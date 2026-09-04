import express from 'express'
import multer from 'multer'
import ExcelJS from 'exceljs'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { uploadScriptImage } from '../lib/supabaseStorage.js'
import { extractTextFromImage } from '../lib/vision.js'
import { computeGrade } from '../lib/grading.js'
import { writeResultsPdf } from '../lib/pdfExport.js'
import { extractStudentInfo } from '../lib/groq.js'

const router = express.Router()
router.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

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

router.post('/', async (req, res) => {
  try {
    const { title, guideId, department, faculty } = req.body
    if (!title) return res.status(400).json({ error: 'A session title is required.' })

    const session = await prisma.markingSession.create({
      data: {
        title,
        guideId: guideId || null,
        department: department || null,
        faculty: faculty || null,
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

router.get('/:id', async (req, res) => {
  const session = await prisma.markingSession.findUnique({
    where: { id: req.params.id },
    include: { guide: { include: { questions: { orderBy: { order: 'asc' } } } } },
  })
  if (!session) return res.status(404).json({ error: 'Session not found.' })
  res.json(session)
})

router.put('/:id', async (req, res) => {
  try {
    const { title, department, faculty, guideId } = req.body
    const session = await prisma.markingSession.update({
      where: { id: req.params.id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(department !== undefined ? { department } : {}),
        ...(faculty !== undefined ? { faculty } : {}),
        ...(guideId !== undefined ? { guideId } : {}),
      },
    })
    res.json(session)
  } catch (err) {
    res.status(404).json({ error: 'Session not found.' })
  }
})

router.get('/scripts/:scriptId', async (req, res) => {
  const script = await prisma.script.findUnique({
    where: { id: req.params.scriptId },
    include: { pages: { orderBy: { pageNumber: 'asc' } }, answers: { include: { question: true } } },
  })
  if (!script) return res.status(404).json({ error: 'Script not found.' })
  res.json(script)
})

router.put('/scripts/:scriptId/studentInfo', async (req, res) => {
  try {
    const { studentName, regNumber } = req.body
    const identifier = [studentName, regNumber].filter(Boolean).join(' — ') || null
    const script = await prisma.script.update({
      where: { id: req.params.scriptId },
      data: {
        studentName: studentName || null,
        regNumber: regNumber || null,
        studentIdentifier: identifier,
      },
    })
    res.json(script)
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

router.get('/:id/scripts', async (req, res) => {
  const scripts = await prisma.script.findMany({
    where: { sessionId: req.params.id },
    include: {
      answers: { include: { question: true } },
      pages: { orderBy: { pageNumber: 'asc' } },
    },
    orderBy: { uploadedAt: 'asc' },
  })
  res.json(scripts)
})

// POST /api/sessions/:id/scripts - upload a page of a script.
// studentName/regNumber are OPTIONAL when starting a new script — if left blank,
// the system tries to read them automatically from the front page's OCR text.
router.post('/:id/scripts', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file was uploaded (expected field name "image").' })
    }

    const { scriptId, studentName, regNumber } = req.body
    const imageUrl = await uploadScriptImage(req.file.buffer, req.file.originalname, req.file.mimetype)

    let script
    let isFirstPageOfNewScript = false
    if (scriptId) {
      script = await prisma.script.findFirst({ where: { id: scriptId, sessionId: req.params.id } })
      if (!script) return res.status(404).json({ error: 'That script was not found in this session.' })
    } else {
      isFirstPageOfNewScript = true
      const identifier = [studentName, regNumber].filter(Boolean).join(' — ') || null
      script = await prisma.script.create({
        data: {
          sessionId: req.params.id,
          studentName: studentName || null,
          regNumber: regNumber || null,
          studentIdentifier: identifier,
          imageUrl,
          status: 'PENDING',
        },
      })
    }

    const existingPageCount = await prisma.scriptPage.count({ where: { scriptId: script.id } })
    const pageNumber = existingPageCount + 1

    let pageText = ''
    let pageConfidence = 0
    try {
      const result = await extractTextFromImage(imageUrl)
      pageText = result.text
      pageConfidence = result.confidence
    } catch (ocrErr) {
      console.error('OCR failed on page:', ocrErr)
      await prisma.scriptPage.create({
        data: { scriptId: script.id, pageNumber, imageUrl, ocrText: null, ocrConfidence: 0 },
      })
      await prisma.script.update({ where: { id: script.id }, data: { status: 'FLAGGED' } })
      return res.status(207).json({
        script: await prisma.script.findUnique({ where: { id: script.id }, include: { pages: true } }),
        warning: `Page ${pageNumber} uploaded, but OCR failed on it. The script has been flagged for manual review.`,
      })
    }

    await prisma.scriptPage.create({
      data: { scriptId: script.id, pageNumber, imageUrl, ocrText: pageText, ocrConfidence: pageConfidence },
    })

    // Front page of a brand new script, no name/reg typed in: try to read them
    // automatically from the OCR text. Never overrides a value already typed in.
    let detected = null
    if (isFirstPageOfNewScript && !studentName && !regNumber) {
      detected = await extractStudentInfo(pageText)
      if (detected.name || detected.regNumber) {
        const identifier = [detected.name, detected.regNumber].filter(Boolean).join(' — ') || null
        await prisma.script.update({
          where: { id: script.id },
          data: {
            studentName: detected.name,
            regNumber: detected.regNumber,
            studentIdentifier: identifier,
          },
        })
      }
    }

    const allPages = await prisma.scriptPage.findMany({
      where: { scriptId: script.id },
      orderBy: { pageNumber: 'asc' },
    })
    const combinedText = allPages.map((p) => p.ocrText || '').join('\n\n--- page break ---\n\n')
    const avgConfidence = allPages.reduce((sum, p) => sum + (p.ocrConfidence || 0), 0) / allPages.length

    const updated = await prisma.script.update({
      where: { id: script.id },
      data: { ocrText: combinedText, ocrConfidence: avgConfidence, status: 'DIGITIZED' },
      include: { pages: { orderBy: { pageNumber: 'asc' } } },
    })

    res.status(201).json({ script: updated, detectedStudentInfo: detected })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not process the uploaded page.' })
  }
})

router.put('/scripts/:scriptId/caScore', async (req, res) => {
  try {
    const { caScore } = req.body
    const script = await prisma.script.update({
      where: { id: req.params.scriptId },
      data: { caScore: caScore === '' || caScore == null ? null : Number(caScore) },
    })
    res.json(script)
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

router.delete('/:id/scripts/:scriptId', async (req, res) => {
  try {
    await prisma.script.delete({ where: { id: req.params.scriptId } })
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

router.get('/:id/export', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })

    const scripts = await prisma.script.findMany({
      where: { sessionId: req.params.id },
      orderBy: { studentName: 'asc' },
    })

    const format = req.query.format === 'pdf' ? 'pdf' : 'xlsx'
    const safeName = session.title.replace(/[^a-z0-9]/gi, '_')

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_results.pdf"`)
      writeResultsPdf(res, session, scripts)
      return
    }

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Results')

    sheet.mergeCells('A1:F1')
    sheet.getCell('A1').value = session.title
    sheet.getCell('A1').font = { size: 16, bold: true }

    sheet.mergeCells('A2:F2')
    sheet.getCell('A2').value = `Department: ${session.department || '—'}`
    sheet.mergeCells('A3:F3')
    sheet.getCell('A3').value = `Faculty: ${session.faculty || '—'}`

    sheet.addRow([])
    sheet.addRow(['Student Name', 'Reg Number', 'CA Score', 'Exam Score', 'Total', 'Grade'])
    const tableHeaderRow = sheet.lastRow
    tableHeaderRow.font = { bold: true }
    tableHeaderRow.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin' } }
    })

    scripts.forEach((s) => {
      const examScore = s.totalScore ?? null
      const ca = s.caScore ?? null
      const total = (examScore ?? 0) + (ca ?? 0)
      const grade = examScore != null ? computeGrade(total) : ''
      sheet.addRow([
        s.studentName || s.studentIdentifier || 'Unnamed',
        s.regNumber || '',
        ca ?? '',
        examScore ?? '',
        examScore != null ? total : '',
        grade,
      ])
    })

    sheet.columns.forEach((col) => {
      col.width = 22
    })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_results.xlsx"`)

    await workbook.xlsx.write(res)
    res.end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not generate the export.' })
  }
})

export default router
