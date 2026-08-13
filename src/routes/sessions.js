import express from 'express'
import multer from 'multer'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { uploadScriptImage } from '../lib/supabaseStorage.js'
import { extractTextFromImage } from '../lib/vision.js'

const router = express.Router()
router.use(requireAuth)

// Keep uploaded files in memory briefly, then forward straight to Supabase Storage —
// we never write them to disk on the server.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per script image
})

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
// This is the real OCR pipeline: image comes in -> saved to Supabase Storage ->
// sent to Google Cloud Vision -> extracted text saved to the database.
// Send as multipart/form-data with a field named "image", plus optional "studentIdentifier".
router.post('/:id/scripts', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file was uploaded (expected field name "image").' })
    }

    // 1. Upload the raw image to Supabase Storage so it has a permanent public URL
    const imageUrl = await uploadScriptImage(req.file.buffer, req.file.originalname, req.file.mimetype)

    // 2. Create the Script row right away with status PENDING, in case OCR is slow or fails
    const script = await prisma.script.create({
      data: {
        sessionId: req.params.id,
        studentIdentifier: req.body.studentIdentifier || null,
        imageUrl,
        status: 'PENDING',
      },
    })

    // 3. Run OCR on the uploaded image
    let ocrText = ''
    let ocrConfidence = 0
    try {
      const result = await extractTextFromImage(imageUrl)
      ocrText = result.text
      ocrConfidence = result.confidence
    } catch (ocrErr) {
      console.error('OCR failed:', ocrErr)
      // We still keep the script record — it can be retried or reviewed manually.
      await prisma.script.update({ where: { id: script.id }, data: { status: 'FLAGGED' } })
      return res.status(207).json({
        script,
        warning: 'Image uploaded, but OCR failed. The script has been flagged for manual review.',
      })
    }

    // 4. Save the extracted text back onto the script
    const updated = await prisma.script.update({
      where: { id: script.id },
      data: {
        ocrText,
        ocrConfidence,
        status: 'DIGITIZED',
      },
    })

    res.status(201).json(updated)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not process the uploaded script.' })
  }
})

// DELETE /api/sessions/:id/scripts/:scriptId - discard a scanned script
router.delete('/:id/scripts/:scriptId', async (req, res) => {
  try {
    await prisma.script.delete({ where: { id: req.params.scriptId } })
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

export default router