import express from 'express'
import multer from 'multer'
import prisma from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { extractTextFromDocument } from '../lib/docParse.js'
import { parseMarkingSchemeDocument, generateModelAnswers } from '../lib/groq.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

const router = express.Router()
router.use(requireAuth)

router.get('/', async (req, res) => {
  // Same rule as sessions: Lecturers see their own guides, Reviewers and
  // Admins see everyone's, since reviewing needs visibility into the guide
  // a script is being scored against even if a Reviewer didn't create it.
  const where = req.user.role === 'LECTURER' ? { createdById: req.user.id } : {}
  const guides = await prisma.markingGuide.findMany({
    where,
    include: { questions: { orderBy: { order: 'asc' } }, createdBy: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  res.json(guides)
})

router.get('/:id', async (req, res) => {
  const guide = await prisma.markingGuide.findUnique({
    where: { id: req.params.id },
    include: { questions: { orderBy: { order: 'asc' } } },
  })
  if (!guide) return res.status(404).json({ error: 'Marking guide not found.' })
  if (req.user.role === 'LECTURER' && guide.createdById !== req.user.id) {
    return res.status(403).json({ error: 'You do not have permission to view this guide.' })
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

    res.json({ ...parsed, previewText: rawText.slice(0, 8000) })
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

    const isCoordinator = session.createdById === req.user.id || req.user.role === 'ADMIN'
    const { targetUserId } = req.body
    const wantsSelf = targetUserId === undefined
    const finalTargetId = wantsSelf ? req.user.id : targetUserId // null here means "unclaim"

    const alreadyTaken = question.assignedMarkerId && question.assignedMarkerId !== req.user.id
    if (!isCoordinator && (alreadyTaken || !wantsSelf)) {
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
      if (!isMarker) {
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
    const { title, subject, questions, isDraft } = req.body

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
        questions: {
          create: (questions || []).map((q, i) => ({
            number: q.number || '1',
            subLabel: q.subLabel || null,
            text: q.text || '',
            modelAnswer: q.modelAnswer || '',
            keywords: q.keywords || '',
            maxMarks: Number(q.maxMarks) || 0,
            order: i,
          })),
        },
      },
      include: { questions: true },
    })

    res.status(201).json(guide)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not create marking guide.' })
  }
})

// PUT /api/guides/:id - full edit: title, subject, isDraft, and replace all questions.
router.put('/:id', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const { title, subject, isDraft, questions } = req.body

    const guide = await prisma.markingGuide.update({
      where: { id: req.params.id },
      data: {
        title,
        subject,
        isDraft: !!isDraft,
        questions: {
          deleteMany: {},
          create: (questions || []).map((q, i) => ({
            number: q.number || '1',
            subLabel: q.subLabel || null,
            text: q.text || '',
            modelAnswer: q.modelAnswer || '',
            keywords: q.keywords || '',
            maxMarks: Number(q.maxMarks) || 0,
            order: i,
          })),
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    })
    res.json(guide)
  } catch (err) {
    console.error(err)
    res.status(404).json({ error: 'Marking guide not found.' })
  }
})

router.delete('/:id', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    await prisma.markingGuide.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: 'Marking guide not found.' })
  }
})

export default router