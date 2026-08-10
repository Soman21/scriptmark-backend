import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()
router.use(requireAuth)

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
