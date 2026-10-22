import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { scoreScriptAgainstGuide } from '../lib/groq.js'
import { accessibleGuidesWhere, canAccessScript, canAccessSession } from '../lib/access.js'

const router = express.Router()
router.use(requireAuth)

// POST /api/results/scripts/:scriptId/score - run the LLM over a digitized script
// against a chosen marking guide, and save one ScriptAnswer per question with a
// SUGGESTED score + reasoning. Nothing here is final — see /confirm below.
router.post('/scripts/:scriptId/score', async (req, res) => {
  try {
    const { guideId } = req.body
    if (!guideId) {
      return res.status(400).json({ error: 'A marking guide must be selected before scoring.' })
    }

    const { script, session } = await canAccessScript(prisma, req.user, req.params.scriptId)
    if (!script) return res.status(404).json({ error: 'Script not found.' })
    if (!session) return res.status(403).json({ error: 'You do not have permission to mark this script.' })
    if (!script.ocrText) {
      return res.status(400).json({ error: 'This script has no extracted text yet. Reading may still be in progress.' })
    }

    const guide = await prisma.markingGuide.findFirst({
      where: { id: guideId, ...(await accessibleGuidesWhere(prisma, req.user)) },
      include: { questions: true },
    })
    if (!guide) return res.status(404).json({ error: 'Marking guide not found.' })
    if (guide.questions.length === 0) {
      return res.status(400).json({ error: 'This marking guide has no questions to score against.' })
    }

    const results = await scoreScriptAgainstGuide(script.ocrText, guide.questions)

    const savedAnswers = []
    for (const r of results) {
      const existing = await prisma.scriptAnswer.findFirst({
        where: { scriptId: script.id, questionId: r.questionId },
      })

      const answerData = {
        suggestedScore: r.suggestedScore,
        reasoning: r.reasoning,
        confidence: r.confidence || null,
        extractedText: r.answerText || script.ocrText,
      }

      const answer = existing
        ? await prisma.scriptAnswer.update({ where: { id: existing.id }, data: answerData })
        : await prisma.scriptAnswer.create({
            data: { scriptId: script.id, questionId: r.questionId, ...answerData },
          })

      savedAnswers.push(answer)
    }

    const totalSuggested = savedAnswers.reduce((sum, a) => sum + (a.suggestedScore || 0), 0)
    const hasLowConfidence = savedAnswers.some((a) => a.confidence === 'low')
    const updatedScript = await prisma.script.update({
      where: { id: script.id },
      data: { totalScore: totalSuggested, hasLowConfidenceScore: hasLowConfidence },
    })

    res.json({ script: updatedScript, answers: savedAnswers, questions: guide.questions })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not score this script: ' + err.message })
  }
})

// PUT /api/results/:answerId/confirm - lecturer confirms/edits a suggested score.
// If this answer was ALREADY confirmed once before (a human or the
// auto-accept rule already decided on it), changing it again is an
// "override" and requires a reason, recorded in the audit trail below.
router.put('/:answerId/confirm', async (req, res) => {
  try {
    const { confirmedScore, extractedText, reason } = req.body

    const existing = await prisma.scriptAnswer.findUnique({ where: { id: req.params.answerId } })
    if (!existing) return res.status(404).json({ error: 'Answer not found.' })
    if (!(await canAccessScript(prisma, req.user, existing.scriptId)).session) {
      return res.status(403).json({ error: 'You do not have permission to confirm this score.' })
    }

    // Signing off an already confirmed (often auto accepted) score without
    // changing it is not an override, so it needs no reason.
    const isOverride = existing.confirmedAt != null && Number(confirmedScore) !== existing.confirmedScore
    if (isOverride && !reason) {
      return res.status(400).json({ error: 'A reason is required when changing a score that was already confirmed.' })
    }

    const answer = await prisma.scriptAnswer.update({
      where: { id: req.params.answerId },
      data: {
        confirmedScore: Number(confirmedScore),
        extractedText: extractedText ?? undefined,
        confirmedAt: new Date(),
        autoAccepted: false, // a human just made the call, this is no longer an unreviewed auto-accept
        ...(isOverride
          ? {
              previousScore: existing.confirmedScore,
              changeReason: reason,
              changedById: req.user.id,
              changedAt: new Date(),
            }
          : {}),
      },
    })

    const allAnswers = await prisma.scriptAnswer.findMany({
      where: { scriptId: answer.scriptId },
    })
    const total = allAnswers.reduce((sum, a) => sum + (a.confirmedScore ?? a.suggestedScore ?? 0), 0)

    await prisma.script.update({
      where: { id: answer.scriptId },
      data: { totalScore: total, status: 'REVIEWED' },
    })

    res.json(answer)
  } catch (err) {
    console.error(err)
    res.status(404).json({ error: 'Answer not found.' })
  }
})

// GET /api/results/myQueue?sessionId=... - question-centric review: every
// answer assigned to the CURRENT user across all scripts in a session, so a
// lecturer can review just their own questions without opening every script.
router.get('/myQueue', async (req, res) => {
  try {
    const { sessionId } = req.query
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' })
    if (!(await canAccessSession(prisma, req.user, sessionId))) {
      return res.status(403).json({ error: 'You do not have permission to view this session.' })
    }

    const answers = await prisma.scriptAnswer.findMany({
      where: {
        question: { assignedMarkerId: req.user.id },
        script: { sessionId },
      },
      include: {
        question: true,
        script: { select: { id: true, studentName: true, regNumber: true, studentIdentifier: true } },
      },
      orderBy: [{ question: { order: 'asc' } }, { script: { regNumber: 'asc' } }],
    })

    res.json({ answers })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load your marking queue: ' + err.message })
  }
})

// GET /api/results/transcriptionSample?sessionId=...&n=10 - answers whose
// marked text a lecturer has not checked yet, in random order, for the
// transcription check that gives WER and CER.
router.get('/transcriptionSample', async (req, res) => {
  try {
    const { sessionId } = req.query
    const n = Math.min(50, Math.max(1, Math.floor(Number(req.query.n)) || 10))
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' })
    if (!(await canAccessSession(prisma, req.user, sessionId))) {
      return res.status(403).json({ error: 'You do not have permission to view this session.' })
    }
    const withText = { script: { sessionId }, OR: [{ extractedText: { not: null } }, { visionTranscript: { not: null } }] }
    const [pending, checked] = await Promise.all([
      prisma.scriptAnswer.findMany({
        where: { ...withText, referenceText: null },
        select: {
          id: true,
          extractedText: true,
          visionTranscript: true,
          question: { select: { number: true, subLabel: true, text: true } },
          script: { select: { studentName: true, regNumber: true, imageUrl: true, pages: { select: { imageUrl: true, pageNumber: true }, orderBy: { pageNumber: 'asc' } } } },
        },
      }),
      prisma.scriptAnswer.count({ where: { ...withText, referenceText: { not: null } } }),
    ])
    for (let i = pending.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pending[i], pending[j]] = [pending[j], pending[i]]
    }
    res.json({
      checked,
      remaining: pending.length,
      answers: pending.slice(0, n).map((a) => ({
        id: a.id,
        question: `Q${a.question.number}${a.question.subLabel || ''}`,
        questionText: a.question.text,
        markedText: a.visionTranscript || a.extractedText,
        student: a.script.studentName || a.script.regNumber || null,
        pages: a.script.pages.length ? a.script.pages.map((p) => p.imageUrl) : [a.script.imageUrl].filter(Boolean),
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load answers to check.' })
  }
})

// PUT /api/results/:answerId/reference - body: { text }. Saves what the
// answer really says; an empty text clears it.
router.put('/:answerId/reference', async (req, res) => {
  try {
    const existing = await prisma.scriptAnswer.findUnique({ where: { id: req.params.answerId } })
    if (!existing) return res.status(404).json({ error: 'Answer not found.' })
    if (!(await canAccessScript(prisma, req.user, existing.scriptId)).session) {
      return res.status(403).json({ error: 'You do not have permission to change this answer.' })
    }
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 20000) : ''
    const updated = await prisma.scriptAnswer.update({ where: { id: existing.id }, data: { referenceText: text || null } })
    res.json({ id: updated.id, referenceText: updated.referenceText })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not save the transcription.' })
  }
})

// PUT /api/results/scripts/:scriptId/flag - flag a script for manual review
router.put('/scripts/:scriptId/flag', async (req, res) => {
  try {
    const { script, session } = await canAccessScript(prisma, req.user, req.params.scriptId)
    if (!script) return res.status(404).json({ error: 'Script not found.' })
    if (!session) return res.status(403).json({ error: 'You do not have permission to flag this script.' })
    const flagged = await prisma.script.update({
      where: { id: script.id },
      data: { status: 'FLAGGED' },
    })
    res.json(flagged)
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

export default router