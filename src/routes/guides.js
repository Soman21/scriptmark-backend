import express from 'express'
import { logActivity } from '../lib/activity.js'
import { Prisma } from '@prisma/client'
import multer from 'multer'
import prisma from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { extractTextFromDocument } from '../lib/docParse.js'
import { parseMarkingSchemeDocument, generateModelAnswers } from '../lib/groq.js'
import { uploadScriptImage } from '../lib/supabaseStorage.js'
import { accessibleGuidesWhere, canAccessSession, canEditGuide } from '../lib/access.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

const router = express.Router()
router.use(requireAuth)

router.get('/', async (req, res) => {
  // Your own guides, plus the guide of any session you are an approved
  // marker on. Only Admin sees everyone's.
  const where = await accessibleGuidesWhere(prisma, req.user)
  const guides = await prisma.markingGuide.findMany({
    where,
    include: { questions: { orderBy: { order: 'asc' } }, createdBy: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  res.json(guides)
})

router.get('/:id', async (req, res) => {
  const where = await accessibleGuidesWhere(prisma, req.user)
  const guide = await prisma.markingGuide.findFirst({
    where: { id: req.params.id, ...where },
    include: { questions: { orderBy: { order: 'asc' } } },
  })
  if (!guide) {
    const exists = await prisma.markingGuide.findUnique({ where: { id: req.params.id }, select: { id: true } })
    return exists
      ? res.status(403).json({ error: 'You do not have permission to view this guide.' })
      : res.status(404).json({ error: 'Marking guide not found.' })
  }
  res.json(guide)
})

// POST /api/guides/parse - upload an existing marking scheme (PDF or DOCX),
// get back structured questions to review in the SAME editable question
// builder used for manual entry. Nothing is saved here — this only returns
// a suggestion for the lecturer to check and adjust before actually saving
// the guide via the regular POST / below.
router.post('/parse', requireRole('LECTURER', 'ADMIN'), upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No document was uploaded (expected field name "document").' })
    }

    const rawText = await extractTextFromDocument(req.file.buffer, req.file.mimetype)
    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ error: 'Could not find any readable text in that document.' })
    }

    const parsed = await parseMarkingSchemeDocument(rawText)
    if (parsed.questions.length === 0) {
      return res.status(400).json({ error: 'Could not identify any questions in that document. Please check the formatting or enter them manually.' })
    }

    // Keep the original file too, not just the extracted text, so markers
    // can preview it in its real layout later, on the Claim Questions page.
    const documentUrl = await uploadScriptImage(req.file.buffer, req.file.originalname, req.file.mimetype)

    res.json({ ...parsed, previewText: rawText.slice(0, 8000), documentUrl, documentMimeType: req.file.mimetype })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not parse this document: ' + err.message })
  }
})

// POST /api/guides - create a guide with its questions
// body: { title, subject, questions, isDraft }
// POST /api/guides/generateAnswers - given a set of questions that came back
// with no model answer (a bare question paper was uploaded), generate one
// for each with AI. This is an explicit, separate step the lecturer chooses
// to run, not something that happens silently during parsing.
// body: { questions: [{ index, number, subLabel, text, maxMarks }] }
router.post('/generateAnswers', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const { questions } = req.body
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'No questions were provided.' })
    }

    const answers = await generateModelAnswers(questions)
    res.json({ answers })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not generate answers: ' + err.message })
  }
})

// GET /api/guides/:id/claimStatus - the guide's questions with who (if
// anyone) has claimed each one, plus the roster of markers on the session
// this guide belongs to, and whether the current user is that session's
// Coordinator (its creator). Used to render the Claim Questions screen.
router.get('/:id/claimStatus', async (req, res) => {
  try {
    const guide = await prisma.markingGuide.findUnique({
      where: { id: req.params.id },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          include: { assignedMarker: { select: { id: true, name: true } } },
        },
      },
    })
    if (!guide) return res.status(404).json({ error: 'Marking guide not found.' })

    const session = await prisma.markingSession.findFirst({ where: { guideId: guide.id } })
    if (!session) return res.status(404).json({ error: 'No session is using this guide yet.' })
    if (!(await canAccessSession(prisma, req.user, session.id))) {
      return res.status(403).json({ error: 'You do not have permission to view this session.' })
    }

    const markers = await prisma.sessionMarker.findMany({
      where: { sessionId: session.id, status: 'APPROVED' },
      include: { user: { select: { id: true, name: true, email: true } } },
    })

    const myMembership = markers.find((m) => m.userId === req.user.id)
    const canManage =
      req.user.role === 'ADMIN' ||
      session.createdById === req.user.id ||
      (myMembership && myMembership.accessLevel === 'FULL')

    res.json({
      questions: guide.questions,
      questionPaperUrl: guide.questionPaperUrl,
      questionPaperMimeType: guide.questionPaperMimeType,
      markers: markers.map((m) => ({ ...m.user, accessLevel: m.accessLevel })),
      isCoordinator: session.createdById === req.user.id,
      canManage,
      sessionId: session.id,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load claim status: ' + err.message })
  }
})

// PUT /api/guides/:id/questions/:questionId/claim - claim, unclaim, or
// (Coordinator/Admin only) reassign a question.
// body: { targetUserId?: string | null }
//   - Omitted targetUserId means "claim this for myself."
//   - null means "unclaim/release it."
//   - A lecturer can only act on a question that's unclaimed or already
//     theirs. Only the session's Coordinator or an Admin can hand a question
//     to someone else, or take it away from another marker.
router.put('/:id/questions/:questionId/claim', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const question = await prisma.question.findUnique({ where: { id: req.params.questionId } })
    if (!question || question.guideId !== req.params.id) {
      return res.status(404).json({ error: 'Question not found.' })
    }

    const session = await prisma.markingSession.findFirst({ where: { guideId: req.params.id } })
    if (!session) return res.status(404).json({ error: 'No session is using this guide yet.' })
    if (!(await canAccessSession(prisma, req.user, session.id))) {
      return res.status(403).json({ error: 'You do not have permission to change this session.' })
    }

    const isCoordinator = session.createdById === req.user.id || req.user.role === 'ADMIN'
    const { targetUserId } = req.body
    const wantsSelf = targetUserId === undefined
    const finalTargetId = wantsSelf ? req.user.id : targetUserId // null here means "unclaim"

    const alreadyTaken = question.assignedMarkerId && question.assignedMarkerId !== req.user.id
    // A marker may release a question they hold themselves.
    const releasingOwn = targetUserId === null && question.assignedMarkerId === req.user.id
    if (!isCoordinator && (alreadyTaken || (!wantsSelf && !releasingOwn))) {
      return res.status(403).json({
        error: alreadyTaken
          ? 'This question is already claimed by someone else. Ask your Coordinator to reassign it if needed.'
          : 'Only this session\'s Coordinator can assign a question to someone else.',
      })
    }

    if (finalTargetId) {
      const isMarker = await prisma.sessionMarker.findUnique({
        where: { sessionId_userId: { sessionId: session.id, userId: finalTargetId } },
      })
      if (!isMarker || isMarker.status !== 'APPROVED') {
        return res.status(400).json({ error: 'That person needs to join this session with its code first.' })
      }
    }

    const updated = await prisma.question.update({
      where: { id: question.id },
      data: { assignedMarkerId: finalTargetId },
      include: { assignedMarker: { select: { id: true, name: true } } },
    })
    res.json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not update this claim: ' + err.message })
  }
})

router.post('/', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const { title, subject, questions, isDraft, questionPaperUrl, questionPaperMimeType } = req.body

    if (!title) {
      return res.status(400).json({ error: 'A title is required, even for a draft.' })
    }
    if (!isDraft && (!Array.isArray(questions) || questions.length === 0)) {
      return res.status(400).json({ error: 'At least one question is required to publish.' })
    }

    const guide = await prisma.markingGuide.create({
      data: {
        title,
        subject,
        isDraft: !!isDraft,
        createdById: req.user.id,
        questionPaperUrl: questionPaperUrl || null,
        questionPaperMimeType: questionPaperMimeType || null,
        questions: {
          create: (questions || []).map((q, i) => ({
            number: q.number || '1',
            subLabel: q.subLabel || null,
            text: q.text || '',
            modelAnswer: q.modelAnswer || '',
            keywords: q.keywords || '',
            maxMarks: Number(q.maxMarks) || 0,
            order: i,
            isCalculationHeavy: !!q.isCalculationHeavy,
            steps: Array.isArray(q.steps) && q.steps.length > 0 ? q.steps : undefined,
          })),
        },
      },
      include: { questions: true },
    })

    await logActivity({ type: 'GUIDE_CREATED', actor: req.user, text: `${req.user.name} created the guide ${guide.title}` })
    res.status(201).json(guide)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not create marking guide.' })
  }
})

// PUT /api/guides/:id - full edit: title, subject, isDraft, and the question
// list. Questions are matched to the saved ones by number and part, so a
// question that scripts have already been marked against is updated in
// place (keeping its answers and whoever claimed it) instead of being
// deleted and recreated.
const questionKey = (q) => `${String(q.number || '1').trim()}|${q.subLabel || ''}`
const questionData = (q, i) => ({
  number: q.number || '1',
  subLabel: q.subLabel || null,
  text: q.text || '',
  modelAnswer: q.modelAnswer || '',
  keywords: q.keywords || '',
  maxMarks: Number(q.maxMarks) || 0,
  order: i,
  isCalculationHeavy: !!q.isCalculationHeavy,
  steps: Array.isArray(q.steps) && q.steps.length > 0 ? q.steps : Prisma.DbNull,
})

router.put('/:id', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const { title, subject, isDraft, questions, questionPaperUrl, questionPaperMimeType } = req.body

    const existing = await prisma.markingGuide.findUnique({
      where: { id: req.params.id },
      include: { questions: { include: { _count: { select: { scriptAnswers: true } } } } },
    })
    if (!existing) return res.status(404).json({ error: 'Marking guide not found.' })
    if (!canEditGuide(req.user, existing)) {
      return res.status(403).json({ error: 'Only the lecturer who wrote this guide can change it.' })
    }

    const incoming = (questions || []).map(questionData)
    const keep = new Set(incoming.map(questionKey))
    const removedMarked = existing.questions.filter((q) => !keep.has(questionKey(q)) && q._count.scriptAnswers > 0)
    if (removedMarked.length) {
      const labels = removedMarked.map((q) => `Q${q.number}${q.subLabel || ''}`).join(', ')
      return res.status(409).json({
        error: `Scripts have already been marked against ${labels}, so it cannot be removed. Change its text or marks instead.`,
      })
    }

    const byKey = new Map(existing.questions.map((q) => [questionKey(q), q]))
    // Questions scripts were already marked against whose marking content
    // changed: the frontend offers to re mark them with the new version.
    const markingFields = ['text', 'modelAnswer', 'keywords', 'maxMarks', 'isCalculationHeavy']
    const changedMarked = incoming
      .map((data) => ({ data, match: byKey.get(questionKey(data)) }))
      .filter(
        ({ data, match }) =>
          match &&
          match._count.scriptAnswers > 0 &&
          (markingFields.some((f) => data[f] !== match[f]) ||
            JSON.stringify(data.steps === Prisma.DbNull ? null : data.steps) !== JSON.stringify(match.steps ?? null))
      )
      .map(({ match }) => ({ id: match.id, label: `Q${match.number}${match.subLabel || ''}`, markedAnswers: match._count.scriptAnswers }))
    const guide = await prisma.$transaction(async (tx) => {
      await tx.question.deleteMany({ where: { guideId: existing.id, id: { in: existing.questions.filter((q) => !keep.has(questionKey(q))).map((q) => q.id) } } })
      for (const data of incoming) {
        const match = byKey.get(questionKey(data))
        if (match) await tx.question.update({ where: { id: match.id }, data })
        else await tx.question.create({ data: { ...data, guideId: existing.id } })
      }
      return tx.markingGuide.update({
        where: { id: existing.id },
        data: {
          title,
          subject,
          isDraft: !!isDraft,
          ...(questionPaperUrl !== undefined ? { questionPaperUrl } : {}),
          ...(questionPaperMimeType !== undefined ? { questionPaperMimeType } : {}),
        },
        include: { questions: { orderBy: { order: 'asc' } } },
      })
    })
    res.json({ ...guide, changedMarkedQuestions: changedMarked })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not save the marking guide.' })
  }
})

router.delete('/:id', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const guide = await prisma.markingGuide.findUnique({ where: { id: req.params.id } })
    if (!guide) return res.status(404).json({ error: 'Marking guide not found.' })
    if (!canEditGuide(req.user, guide)) {
      return res.status(403).json({ error: 'Only the lecturer who wrote this guide can delete it.' })
    }
    await prisma.markingGuide.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: 'Marking guide not found.' })
  }
})

export default router