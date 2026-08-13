import { scoreScriptAgainstGuide } from '../lib/groq.js'
import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'


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

    const script = await prisma.script.findUnique({ where: { id: req.params.scriptId } })
    if (!script) return res.status(404).json({ error: 'Script not found.' })
    if (!script.ocrText) {
      return res.status(400).json({ error: 'This script has no extracted text yet — OCR may still be processing.' })
    }

    const guide = await prisma.markingGuide.findUnique({
      where: { id: guideId },
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

      const answer = existing
        ? await prisma.scriptAnswer.update({
            where: { id: existing.id },
            data: {
              suggestedScore: r.suggestedScore,
              reasoning: r.reasoning,
              extractedText: script.ocrText,
            },
          })
        : await prisma.scriptAnswer.create({
            data: {
              scriptId: script.id,
              questionId: r.questionId,
              suggestedScore: r.suggestedScore,
              reasoning: r.reasoning,
              extractedText: script.ocrText,
            },
          })

      savedAnswers.push(answer)
    }

    const totalSuggested = savedAnswers.reduce((sum, a) => sum + (a.suggestedScore || 0), 0)
    const updatedScript = await prisma.script.update({
      where: { id: script.id },
      data: { totalScore: totalSuggested },
    })

    res.json({ script: updatedScript, answers: savedAnswers, questions: guide.questions })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not score this script: ' + err.message })
  }
})


// PUT /api/results/:answerId/confirm - lecturer confirms/edits a suggested score
// This is the "human-in-the-loop" step: body { confirmedScore, reasoning? }
router.put('/:answerId/confirm', async (req, res) => {
  try {
    const { confirmedScore, extractedText } = req.body

    const answer = await prisma.scriptAnswer.update({
      where: { id: req.params.answerId },
      data: {
        confirmedScore: Number(confirmedScore),
        extractedText: extractedText ?? undefined,
        confirmedAt: new Date(),
      },
    })

    // Recompute the script's total from all confirmed answers
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

// PUT /api/results/scripts/:scriptId/flag - flag a script for manual review
router.put('/scripts/:scriptId/flag', async (req, res) => {
  try {
    const script = await prisma.script.update({
      where: { id: req.params.scriptId },
      data: { status: 'FLAGGED' },
    })
    res.json(script)
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

export default router
