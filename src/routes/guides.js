import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()
router.use(requireAuth)

// GET /api/guides - list all guides created by anyone in the institution
router.get('/', async (req, res) => {
  const guides = await prisma.markingGuide.findMany({
    include: { questions: true, createdBy: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  })
  res.json(guides)
})

// GET /api/guides/:id
router.get('/:id', async (req, res) => {
  const guide = await prisma.markingGuide.findUnique({
    where: { id: req.params.id },
    include: { questions: { orderBy: { order: 'asc' } } },
  })
  if (!guide) return res.status(404).json({ error: 'Marking guide not found.' })
  res.json(guide)
})

// POST /api/guides - create a guide with its questions
// body: { title, subject, questions: [{ text, modelAnswer, keywords, maxMarks }], isDraft }
// When isDraft is true, validation is relaxed — an incomplete guide can still be saved
// so the lecturer can come back and finish it later.
router.post('/', async (req, res) => {
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

// PUT /api/guides/:id
router.put('/:id', async (req, res) => {
  const { title, subject } = req.body
  try {
    const guide = await prisma.markingGuide.update({
      where: { id: req.params.id },
      data: { title, subject },
    })
    res.json(guide)
  } catch (err) {
    res.status(404).json({ error: 'Marking guide not found.' })
  }
})

// DELETE /api/guides/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.markingGuide.delete({ where: { id: req.params.id } })
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: 'Marking guide not found.' })
  }
})

export default router