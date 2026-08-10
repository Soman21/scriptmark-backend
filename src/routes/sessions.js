import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()
router.use(requireAuth)

// GET /api/sessions - list marking sessions
router.get('/', async (req, res) => {
  const sessions = await prisma.markingSession.findMany({
    include: {
      guide: { select: { title: true } },
      _count: { select: { scripts: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json(sessions)
})

// POST /api/sessions - create a new marking session ("New Marking Session" button)
router.post('/', async (req, res) => {
  try {
    const { title, guideId } = req.body
    if (!title) return res.status(400).json({ error: 'A session title is required.' })

    const session = await prisma.markingSession.create({
      data: {
        title,
        guideId: guideId || null,
        createdById: req.user.id,
        status: 'ACTIVE',
      },
    })
    res.status(201).json(session)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not create marking session.' })
  }
})

// GET /api/sessions/:id/scripts - scripts within a session, in upload order
router.get('/:id/scripts', async (req, res) => {
  const scripts = await prisma.script.findMany({
    where: { sessionId: req.params.id },
    include: { answers: true },
    orderBy: { uploadedAt: 'asc' },
  })
  res.json(scripts)
})

// POST /api/sessions/:id/scripts - register a newly scanned/uploaded script
// NOTE: actual OCR (Google Cloud Vision) and LLM scoring are not wired up yet.
// For now this just creates the Script row; ocrText/suggestedScore stay null
// until those integrations are added.
router.post('/:id/scripts', async (req, res) => {
  try {
    const { studentIdentifier, imageUrl } = req.body
    const script = await prisma.script.create({
      data: {
        sessionId: req.params.id,
        studentIdentifier,
        imageUrl,
        status: 'PENDING',
      },
    })
    res.status(201).json(script)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not register script.' })
  }
})

export default router
