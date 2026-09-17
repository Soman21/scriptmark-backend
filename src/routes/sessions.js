import express from 'express'
import multer from 'multer'
import ExcelJS from 'exceljs'
import prisma from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadScriptImage } from '../lib/supabaseStorage.js'
import { extractTextFromImage } from '../lib/vision.js'
import { computeGrade } from '../lib/grading.js'
import { writeResultsPdf } from '../lib/pdfExport.js'
import { extractStudentInfo, scoreScriptAgainstGuide } from '../lib/groq.js'
import { pdfToPageImages } from '../lib/pdfSplit.js'
import { sendEmail } from '../lib/email.js'

const router = express.Router()
router.use(requireAuth)

// Short, human-typeable join code (uppercase letters and digits, no
// ambiguous characters like 0/O or 1/I), regenerated on collision.
async function generateUniqueJoinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = ''
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
    const existing = await prisma.markingSession.findUnique({ where: { joinCode: code } })
    if (!existing) return code
  }
  throw new Error('Could not generate a unique join code, please try again.')
}

// Shared by every /:id/... route below: Lecturers can only reach their own
// sessions, Reviewers and Admins can reach any session. Attaches the loaded
// session to req.markingSession so routes don't have to re-fetch it.
async function requireSessionAccess(req, res, next) {
  const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
  if (!session) return res.status(404).json({ error: 'Session not found.' })
  if (req.user.role === 'LECTURER' && session.createdById !== req.user.id) {
    return res.status(403).json({ error: 'You do not have permission to access this session.' })
  }
  req.markingSession = session
  next()
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // a multi-page PDF is bigger than a single page image
})

const uploadBatch = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

// GET /api/sessions/lecturers - list Lecturer/Admin users, for the marker
// selection dropdowns when creating a session or assigning questions. Must
// stay ABOVE any /:id route below, or Express would treat "lecturers" as an
// :id value instead.
router.get('/lecturers', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const lecturers = await prisma.user.findMany({
    where: { role: { in: ['LECTURER', 'ADMIN'] } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  })
  res.json(lecturers)
})

// POST /api/sessions/join - a lecturer enters a session's join code to be
// added as one of its markers, no Coordinator approval step needed, the
// code itself is the access control. Must also stay ABOVE any /:id route.
router.post('/join', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const { code } = req.body
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Enter a join code.' })
    }

    const session = await prisma.markingSession.findUnique({ where: { joinCode: code.trim().toUpperCase() } })
    if (!session) {
      return res.status(404).json({ error: 'No session found with that code. Check it and try again.' })
    }

    await prisma.sessionMarker.upsert({
      where: { sessionId_userId: { sessionId: session.id, userId: req.user.id } },
      update: {},
      create: { sessionId: session.id, userId: req.user.id, status: 'APPROVED', accessLevel: 'LIMITED' },
    })

    res.json({ id: session.id, title: session.title })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not join this session: ' + err.message })
  }
})

// GET /api/sessions/browsable - ACTIVE sessions the current user is not
// already a marker on, for the "Request Access" flow when they don't have
// a join code. Must stay ABOVE any /:id route below.
router.get('/browsable', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  const myMemberships = await prisma.sessionMarker.findMany({
    where: { userId: req.user.id },
    select: { sessionId: true },
  })
  const excludeIds = myMemberships.map((m) => m.sessionId)

  const sessions = await prisma.markingSession.findMany({
    where: { status: 'ACTIVE', id: { notIn: excludeIds } },
    select: { id: true, title: true, courseCode: true, createdBy: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json(sessions)
})

router.get('/', async (req, res) => {
  // Lecturers get their own private workspace; Reviewers and Admins need to
  // see everyone's sessions since reviewing someone else's uploads is the
  // whole point of that role.
  const where = req.user.role === 'LECTURER' ? { createdById: req.user.id } : {}
  const sessions = await prisma.markingSession.findMany({
    where,
    include: {
      guide: { select: { title: true } },
      _count: { select: { scripts: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  res.json(sessions)
})

router.post('/', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const {
      title,
      guideId,
      department,
      faculty,
      courseCode,
      examinationType,
      academicSession,
      semester,
      autoAcceptHighConfidence,
    } = req.body
    if (!title) return res.status(400).json({ error: 'A session title is required.' })

    const joinCode = await generateUniqueJoinCode()

    const session = await prisma.markingSession.create({
      data: {
        title,
        guideId: guideId || null,
        department: department || null,
        faculty: faculty || null,
        courseCode: courseCode || null,
        examinationType: examinationType || null,
        academicSession: academicSession || null,
        semester: semester || null,
        autoAcceptHighConfidence: autoAcceptHighConfidence !== false, // default true
        createdById: req.user.id,
        status: 'ACTIVE',
        joinCode,
        // Whoever creates the session is its de facto Coordinator, and is
        // automatically its first marker too. Other lecturers join later
        // themselves using the join code, rather than being picked here.
        markers: { create: [{ userId: req.user.id, status: 'APPROVED', accessLevel: 'FULL' }] },
      },
      include: { markers: { include: { user: { select: { id: true, name: true, email: true } } } } },
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
  if (req.user.role === 'LECTURER' && session.createdById !== req.user.id) {
    return res.status(403).json({ error: 'You do not have permission to view this session.' })
  }
  res.json(session)
})

router.put('/:id', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const {
      title,
      department,
      faculty,
      guideId,
      courseCode,
      examinationType,
      academicSession,
      semester,
      autoAcceptHighConfidence,
    } = req.body
    const session = await prisma.markingSession.update({
      where: { id: req.params.id },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(department !== undefined ? { department } : {}),
        ...(faculty !== undefined ? { faculty } : {}),
        ...(guideId !== undefined ? { guideId } : {}),
        ...(courseCode !== undefined ? { courseCode } : {}),
        ...(examinationType !== undefined ? { examinationType } : {}),
        ...(academicSession !== undefined ? { academicSession } : {}),
        ...(semester !== undefined ? { semester } : {}),
        ...(autoAcceptHighConfidence !== undefined ? { autoAcceptHighConfidence } : {}),
      },
    })
    res.json(session)
  } catch (err) {
    res.status(404).json({ error: 'Session not found.' })
  }
})

// GET /api/sessions/:id/markers - the lecturers currently attached to this
// session, for populating "Assigned Marker" dropdowns in the guide builder.
// GET /api/sessions/:id/markers - APPROVED markers only, with their access
// level, for the Claim Questions page and marker management.
router.get('/:id/markers', async (req, res) => {
  const markers = await prisma.sessionMarker.findMany({
    where: { sessionId: req.params.id, status: 'APPROVED' },
    include: { user: { select: { id: true, name: true, email: true } } },
  })
  res.json(markers.map((m) => ({ ...m.user, accessLevel: m.accessLevel })))
})

// Whether userId can manage this session's membership: its Coordinator, an
// Admin, or any of its own APPROVED Full-access markers.
async function canManageMarkers(session, userId, userRole) {
  if (userRole === 'ADMIN') return true
  if (session.createdById === userId) return true
  const marker = await prisma.sessionMarker.findUnique({
    where: { sessionId_userId: { sessionId: session.id, userId } },
  })
  return !!marker && marker.status === 'APPROVED' && marker.accessLevel === 'FULL'
}

// GET /api/sessions/browsable - ACTIVE sessions the current user is not
// already a marker on, for the "Request Access" flow when they don't have
// a join code.
// POST /api/sessions/:id/requestAccess - ask to join a session without a
// code. Sits PENDING until the Coordinator or a Full-access marker decides.
router.post('/:id/requestAccess', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })

    const existing = await prisma.sessionMarker.findUnique({
      where: { sessionId_userId: { sessionId: session.id, userId: req.user.id } },
    })
    if (existing) {
      return res.status(400).json({
        error: existing.status === 'PENDING' ? 'You already have a pending request for this session.' : 'You already have access to this session.',
      })
    }

    await prisma.sessionMarker.create({
      data: { sessionId: session.id, userId: req.user.id, status: 'PENDING', accessLevel: 'LIMITED' },
    })
    res.status(201).json({ message: 'Request sent. The Coordinator will review it.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not send that request: ' + err.message })
  }
})

// GET /api/sessions/:id/pendingRequests - who's waiting to be let in.
router.get('/:id/pendingRequests', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (!(await canManageMarkers(session, req.user.id, req.user.role))) {
      return res.status(403).json({ error: 'You do not have permission to view this.' })
    }

    const pending = await prisma.sessionMarker.findMany({
      where: { sessionId: session.id, status: 'PENDING' },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    res.json(pending.map((m) => m.user))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load pending requests: ' + err.message })
  }
})

// PUT /api/sessions/:id/markers/:userId/approve
router.put('/:id/markers/:userId/approve', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (!(await canManageMarkers(session, req.user.id, req.user.role))) {
      return res.status(403).json({ error: 'You do not have permission to approve markers.' })
    }

    await prisma.sessionMarker.update({
      where: { sessionId_userId: { sessionId: session.id, userId: req.params.userId } },
      data: { status: 'APPROVED' },
    })

    const requester = await prisma.user.findUnique({ where: { id: req.params.userId } })
    if (requester) {
      sendEmail({
        to: requester.email,
        subject: `You've been added to ${session.title}`,
        html: `<p>Hi ${requester.name},</p><p>Your request to join <strong>${session.title}</strong> on ScriptMark has been approved. You can now claim questions to mark.</p>`,
      }).catch((err) => console.error('Approval email failed:', err))
    }

    res.json({ message: 'Approved.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not approve this request: ' + err.message })
  }
})

// PUT /api/sessions/:id/markers/:userId/deny
router.put('/:id/markers/:userId/deny', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (!(await canManageMarkers(session, req.user.id, req.user.role))) {
      return res.status(403).json({ error: 'You do not have permission to deny markers.' })
    }

    const requester = await prisma.user.findUnique({ where: { id: req.params.userId } })

    await prisma.sessionMarker.delete({
      where: { sessionId_userId: { sessionId: session.id, userId: req.params.userId } },
    })

    if (requester) {
      sendEmail({
        to: requester.email,
        subject: `Your request to join ${session.title} was declined`,
        html: `<p>Hi ${requester.name},</p><p>Your request to join <strong>${session.title}</strong> on ScriptMark was not approved. You can reach out to the Coordinator directly if you think this was a mistake.</p>`,
      }).catch((err) => console.error('Denial email failed:', err))
    }

    res.json({ message: 'Denied.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not deny this request: ' + err.message })
  }
})

// PUT /api/sessions/:id/markers/:userId/accessLevel - body: { accessLevel: 'LIMITED' | 'FULL' }
router.put('/:id/markers/:userId/accessLevel', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (!(await canManageMarkers(session, req.user.id, req.user.role))) {
      return res.status(403).json({ error: 'You do not have permission to change access levels.' })
    }

    const { accessLevel } = req.body
    if (!['LIMITED', 'FULL'].includes(accessLevel)) {
      return res.status(400).json({ error: 'accessLevel must be LIMITED or FULL.' })
    }

    await prisma.sessionMarker.update({
      where: { sessionId_userId: { sessionId: session.id, userId: req.params.userId } },
      data: { accessLevel },
    })
    res.json({ message: 'Access level updated.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not update access level: ' + err.message })
  }
})

// DELETE /api/sessions/:id/markers/:userId - revoke access. Kept to the
// Coordinator or an Admin specifically, not every Full-access marker, since
// removing someone is a bigger call than granting them more access.
router.delete('/:id/markers/:userId', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (req.user.role === 'LECTURER' && session.createdById !== req.user.id) {
      return res.status(403).json({ error: 'Only this session\'s Coordinator or an Admin can revoke access.' })
    }
    if (req.params.userId === session.createdById) {
      return res.status(400).json({ error: 'The Coordinator cannot be removed from their own session.' })
    }

    await prisma.sessionMarker.delete({
      where: { sessionId_userId: { sessionId: session.id, userId: req.params.userId } },
    })
    res.json({ message: 'Access revoked.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not revoke access: ' + err.message })
  }
})

// POST /api/sessions/:id/inviteByEmail - emails the join code directly to
// someone the Coordinator (or a Full-access marker) already has in mind,
// rather than requiring them to copy and share the code manually elsewhere.
// body: { email }
router.post('/:id/inviteByEmail', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (!(await canManageMarkers(session, req.user.id, req.user.role))) {
      return res.status(403).json({ error: 'You do not have permission to invite markers to this session.' })
    }

    const { email } = req.body
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Enter an email address to invite.' })
    }

    const inviter = await prisma.user.findUnique({ where: { id: req.user.id } })

    await sendEmail({
      to: email.trim(),
      subject: `You've been invited to mark ${session.title} on ScriptMark`,
      html: `<p>Hi,</p><p>${inviter.name} has invited you to help mark <strong>${session.title}</strong>${session.courseCode ? ` (${session.courseCode})` : ''} on ScriptMark.</p><p>If you don't have an account yet, sign up first, then log in and use this join code:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${session.joinCode}</p><p>Once you're in, you can claim which questions you'll be marking.</p>`,
    })

    res.json({ message: 'Invite sent.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not send that invite: ' + err.message })
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

router.put('/scripts/:scriptId/studentInfo', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
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
router.post('/:id/scripts', requireRole('LECTURER', 'ADMIN'), upload.single('image'), async (req, res) => {
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

router.put('/scripts/:scriptId/caScore', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
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

router.delete('/:id/scripts/:scriptId', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    await prisma.script.delete({ where: { id: req.params.scriptId } })
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: 'Script not found.' })
  }
})

// POST /api/sessions/:id/scripts/bulkSplit - upload one PDF containing many
// students' scripts, get back the PDF chopped into individual page images and
// grouped into proposed submissions of `pagesPerSubmission` pages each.
// Nothing is saved to the database yet — this is a preview for the lecturer
// to review, edit, drag-and-drop, and adjust before confirming (see
// bulkConfirm below).
//
// IMPORTANT: this step does ZERO OCR, for either mode. OCR and student-info
// detection are deliberately deferred to the Marking step (see /mark below),
// so splitting a big PDF stays fast no matter how many pages it has. "Auto"
// vs "manual" mode is currently just framing for the lecturer — auto-detected
// reg numbers will appear once Marking digitizes each script, not here.
//
// multipart/form-data: pdf (required), pagesPerSubmission (required)
router.post('/:id/scripts/bulkSplit', requireRole('LECTURER', 'ADMIN'), uploadPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file was uploaded (expected field name "pdf").' })
    }

    const pagesPerSubmission = Number(req.body.pagesPerSubmission) || 1

    const pageBuffers = pdfToPageImages(req.file.buffer)
    if (pageBuffers.length === 0) {
      return res.status(400).json({ error: 'Could not read any pages from that PDF.' })
    }

    // Upload every page image up front, so the lecturer sees real thumbnails
    // while reviewing, and nothing needs re-uploading at confirm time.
    const pages = []
    for (let i = 0; i < pageBuffers.length; i++) {
      const imageUrl = await uploadScriptImage(pageBuffers[i], `bulk_page_${i + 1}.png`, 'image/png')
      pages.push({ pageNumber: i + 1, imageUrl })
    }

    const groups = []
    for (let i = 0; i < pages.length; i += pagesPerSubmission) {
      groups.push({ pages: pages.slice(i, i + pagesPerSubmission) })
    }

    res.json({ groups })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not split this PDF: ' + err.message })
  }
})

// POST /api/sessions/:id/scripts/bulkConfirm - takes the lecturer-reviewed
// (and possibly drag-and-drop-adjusted) groups from bulkSplit and creates the
// Script + ScriptPage records. Deliberately does NO OCR here — every script
// is created as PENDING, and gets digitized + scored automatically once
// Marking starts (see /mark below). This is what keeps Confirm & Upload fast.
// body: { groups: [{ studentName, regNumber, pages: [{ imageUrl }] }] }
router.post('/:id/scripts/bulkConfirm', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const { groups } = req.body
    if (!Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({ error: 'No groups to confirm.' })
    }

    const createdScripts = []

    for (const group of groups) {
      const identifier = [group.studentName, group.regNumber].filter(Boolean).join(' — ') || null
      const script = await prisma.script.create({
        data: {
          sessionId: req.params.id,
          studentName: group.studentName || null,
          regNumber: group.regNumber || null,
          studentIdentifier: identifier,
          imageUrl: group.pages[0]?.imageUrl || null,
          status: 'PENDING',
        },
      })

      // Page order at this point reflects whatever the lecturer dragged/
      // dropped into place — re-number 1..N based on current array order,
      // not the page's original position in the source PDF.
      for (let i = 0; i < group.pages.length; i++) {
        const p = group.pages[i]
        await prisma.scriptPage.create({
          data: { scriptId: script.id, pageNumber: i + 1, imageUrl: p.imageUrl },
        })
      }

      createdScripts.push(script)
    }

    res.status(201).json({ scripts: createdScripts })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not confirm these scripts: ' + err.message })
  }
})

// POST /api/sessions/:id/scripts/uploadPage - uploads ONE image and returns
// its URL. Used when the lecturer rotates or crops a page in the split
// review screen: the browser bakes the edit into a new image client-side,
// then sends just that final result here. Untouched pages never hit this
// route at all, so splitting/reviewing stays free of any extra cost unless
// a page is actually edited.
router.post('/:id/scripts/uploadPage', requireRole('LECTURER', 'ADMIN'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image was uploaded (expected field name "image").' })
    }
    const imageUrl = await uploadScriptImage(req.file.buffer, req.file.originalname || 'edited_page.png', req.file.mimetype || 'image/png')
    res.json({ imageUrl })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not upload the edited page: ' + err.message })
  }
})

// POST /api/sessions/:id/scripts/batchUpload - upload several separate files
// in one go, where EACH FILE is already one individual student's complete
// script: a single image, or a PDF (short or long) belonging to just that
// one student. Unlike bulkSplit, there's no grouping step needed here, since
// each file is already a whole submission on its own — this creates the
// Script + ScriptPage records directly. Same as the other upload paths, no
// OCR happens here; digitizing and scoring happen automatically in Marking.
// multipart/form-data: files (multiple, each image/* or application/pdf)
router.post('/:id/scripts/batchUpload', requireRole('LECTURER', 'ADMIN'), uploadBatch.array('files', 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded (expected field name "files").' })
    }

    const createdScripts = []

    for (const file of req.files) {
      const isPdf = file.mimetype === 'application/pdf'
      const pageBuffers = isPdf ? pdfToPageImages(file.buffer) : [file.buffer]

      if (pageBuffers.length === 0) continue

      const script = await prisma.script.create({
        data: { sessionId: req.params.id, status: 'PENDING' },
      })

      let firstPageUrl = null
      for (let i = 0; i < pageBuffers.length; i++) {
        const mime = isPdf ? 'image/png' : file.mimetype
        const ext = isPdf ? 'png' : mime.split('/')[1] || 'png'
        const imageUrl = await uploadScriptImage(pageBuffers[i], `${file.originalname}_page_${i + 1}.${ext}`, mime)
        if (i === 0) firstPageUrl = imageUrl
        await prisma.scriptPage.create({ data: { scriptId: script.id, pageNumber: i + 1, imageUrl } })
      }

      const updated = await prisma.script.update({ where: { id: script.id }, data: { imageUrl: firstPageUrl } })
      createdScripts.push(updated)
    }

    res.status(201).json({ scripts: createdScripts })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not upload these files: ' + err.message })
  }
})

// POST /api/sessions/:id/mark - starts (or resumes) the background marking
// queue for every not-yet-scored script in this session: OCR digitizing,
// then LLM scoring against the session's guide, one script at a time.
// Responds immediately; the actual work continues on the server afterward,
// independent of whether the lecturer stays on the page. Poll
// GET /:id/markingStatus for live progress.
router.post('/:id/mark', requireRole('LECTURER', 'ADMIN'), async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({ where: { id: req.params.id } })
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (!session.guideId) {
      return res.status(400).json({ error: 'This session has no marking guide selected yet.' })
    }

    const guide = await prisma.markingGuide.findUnique({
      where: { id: session.guideId },
      include: { questions: true },
    })
    if (!guide || guide.questions.length === 0) {
      return res.status(400).json({ error: 'The marking guide for this session has no questions.' })
    }

    const scripts = await prisma.script.findMany({
      where: { sessionId: session.id, status: { in: ['PENDING', 'DIGITIZED'] } },
      include: { pages: { orderBy: { pageNumber: 'asc' } } },
    })

    res.json({ started: true, queued: scripts.length })

    // Fire-and-forget: do not await this. It keeps running in the Node
    // process on Railway after the response has already gone back, so it
    // survives the lecturer navigating away or closing the tab.
    runMarkingQueue(scripts, guide, session).catch((err) => console.error('Marking queue failed:', err))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not start marking: ' + err.message })
  }
})

async function runMarkingQueue(scripts, guide, session) {
  for (const script of scripts) {
    try {
      let ocrText = script.ocrText

      if (!ocrText) {
        const pageTexts = []
        let confidenceSum = 0
        for (const page of script.pages) {
          const result = await extractTextFromImage(page.imageUrl)
          await prisma.scriptPage.update({
            where: { id: page.id },
            data: { ocrText: result.text, ocrConfidence: result.confidence },
          })
          pageTexts.push(result.text || '')
          confidenceSum += result.confidence
        }
        ocrText = pageTexts.join('\n\n--- page break ---\n\n')
        const avgConfidence = script.pages.length ? confidenceSum / script.pages.length : 0

        // Student info detection was deferred from splitting to right here —
        // only fill in whatever the lecturer didn't already type in manually.
        let studentName = script.studentName
        let regNumber = script.regNumber
        if ((!studentName || !regNumber) && pageTexts[0]) {
          const detected = await extractStudentInfo(pageTexts[0])
          studentName = studentName || detected.name
          regNumber = regNumber || detected.regNumber
        }

        await prisma.script.update({
          where: { id: script.id },
          data: {
            ocrText,
            ocrConfidence: avgConfidence,
            status: 'DIGITIZED',
            studentName,
            regNumber,
            studentIdentifier: [studentName, regNumber].filter(Boolean).join(' — ') || script.studentIdentifier,
          },
        })
      }

      const results = await scoreScriptAgainstGuide(ocrText, guide.questions)
      let totalSuggested = 0
      let hasLowConfidence = false

      for (const r of results) {
        const existing = await prisma.scriptAnswer.findFirst({
          where: { scriptId: script.id, questionId: r.questionId },
        })
        // High-confidence auto-accept: if this session has it enabled and the
        // AI is confident, the score is confirmed immediately, no human
        // review step needed. Anything not high-confidence still goes
        // through the normal human confirm flow untouched.
        const autoAccept = session.autoAcceptHighConfidence && r.confidence === 'high'
        const answerData = {
          suggestedScore: r.suggestedScore,
          reasoning: r.reasoning,
          confidence: r.confidence || null,
          extractedText: r.answerText || ocrText,
          ...(autoAccept ? { confirmedScore: r.suggestedScore, confirmedAt: new Date(), autoAccepted: true } : {}),
        }
        if (existing) {
          await prisma.scriptAnswer.update({ where: { id: existing.id }, data: answerData })
        } else {
          await prisma.scriptAnswer.create({ data: { scriptId: script.id, questionId: r.questionId, ...answerData } })
        }
        totalSuggested += r.suggestedScore || 0
        if (r.confidence === 'low') hasLowConfidence = true
      }

      await prisma.script.update({
        where: { id: script.id },
        data: { totalScore: totalSuggested, hasLowConfidenceScore: hasLowConfidence, status: 'SCORED' },
      })
    } catch (err) {
      console.error(`Marking failed for script ${script.id}:`, err)
      await prisma.script.update({ where: { id: script.id }, data: { status: 'FLAGGED' } }).catch(() => {})
    }
  }
}

// GET /api/sessions/:id/markingStatus - polled by the Marking page for live
// progress: how many scripts are marked (SCORED or REVIEWED) out of the
// total, plus a per-script summary for the queue table.
router.get('/:id/markingStatus', async (req, res) => {
  try {
    const scripts = await prisma.script.findMany({
      where: { sessionId: req.params.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        studentName: true,
        regNumber: true,
        studentIdentifier: true,
        status: true,
        totalScore: true,
        hasLowConfidenceScore: true,
        updatedAt: true,
      },
    })
    const total = scripts.length
    const markedCount = scripts.filter((s) => s.status === 'SCORED' || s.status === 'REVIEWED').length
    res.json({ total, markedCount, scripts })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load marking status: ' + err.message })
  }
})

// GET /api/sessions/:id/coordinatorOverview - session-wide progress plus a
// per-marker breakdown, for the Coordinator's oversight dashboard. Anyone
// can call this (Results/Marking pages already gate who sees the link to
// it), it just returns aggregate counts, nothing sensitive per-student.
router.get('/:id/coordinatorOverview', async (req, res) => {
  try {
    const session = await prisma.markingSession.findUnique({
      where: { id: req.params.id },
      include: { markers: { include: { user: { select: { id: true, name: true, email: true } } } } },
    })
    if (!session) return res.status(404).json({ error: 'Session not found.' })

    const scriptCount = await prisma.script.count({ where: { sessionId: session.id } })
    const answers = await prisma.scriptAnswer.findMany({
      where: { script: { sessionId: session.id } },
      select: {
        confidence: true,
        confirmedAt: true,
        autoAccepted: true,
        question: { select: { assignedMarkerId: true } },
      },
    })

    const aiMarked = answers.length
    const autoAccepted = answers.filter((a) => a.autoAccepted).length
    const humanReviewRequired = answers.filter((a) => !a.autoAccepted).length
    const humanReviewCompleted = answers.filter((a) => !a.autoAccepted && a.confirmedAt).length
    const pendingReview = humanReviewRequired - humanReviewCompleted

    const perMarker = session.markers.map(({ user }) => {
      const assignedAnswers = answers.filter((a) => a.question.assignedMarkerId === user.id)
      const reviewed = assignedAnswers.filter((a) => a.confirmedAt).length
      return {
        user,
        assigned: assignedAnswers.length,
        reviewed,
        pending: assignedAnswers.length - reviewed,
      }
    })

    res.json({
      scriptCount,
      aiMarked,
      autoAccepted,
      humanReviewRequired,
      humanReviewCompleted,
      pendingReview,
      perMarker,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load the coordinator overview: ' + err.message })
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

// GET /api/sessions/:id/analytics - real cohort-level stats for this session,
// computed from actual confirmed/suggested scores.
router.get('/:id/analytics', async (req, res) => {
  try {
    const scripts = await prisma.script.findMany({
      where: { sessionId: req.params.id },
      include: { answers: { include: { question: true } } },
    })

    const scored = scripts.filter((s) => s.totalScore != null)
    const totalScripts = scripts.length
    const flaggedCount = scripts.filter((s) => s.status === 'FLAGGED').length
    const lowConfidenceCount = scripts.filter((s) => s.hasLowConfidenceScore).length

    const average = scored.length
      ? scored.reduce((sum, s) => sum + s.totalScore, 0) / scored.length
      : null
    const highest = scored.length ? Math.max(...scored.map((s) => s.totalScore)) : null

    // Score distribution in 0-20, 21-40, ... 81-100 buckets, as a percentage
    // of each script's max possible marks (so guides with different totals
    // are comparable).
    const buckets = [0, 0, 0, 0, 0]
    scored.forEach((s) => {
      const maxPossible = s.answers.reduce((sum, a) => sum + (a.question?.maxMarks || 0), 0)
      if (!maxPossible) return
      const pct = (s.totalScore / maxPossible) * 100
      const bucketIndex = Math.min(4, Math.floor(pct / 20))
      buckets[bucketIndex]++
    })

    // Per-question average, to surface commonly-missed questions.
    const questionStats = {}
    scripts.forEach((s) => {
      s.answers.forEach((a) => {
        if (!a.question) return
        const key = a.question.id
        if (!questionStats[key]) {
          questionStats[key] = {
            number: a.question.number,
            subLabel: a.question.subLabel,
            text: a.question.text,
            maxMarks: a.question.maxMarks,
            scores: [],
          }
        }
        const score = a.confirmedScore ?? a.suggestedScore
        if (score != null) questionStats[key].scores.push(score)
      })
    })
    const perQuestion = Object.values(questionStats).map((q) => ({
      number: q.number,
      subLabel: q.subLabel,
      text: q.text,
      maxMarks: q.maxMarks,
      averagePercent: q.scores.length
        ? Math.round((q.scores.reduce((a, b) => a + b, 0) / q.scores.length / q.maxMarks) * 100)
        : null,
      responseCount: q.scores.length,
    }))

    res.json({
      totalScripts,
      scoredCount: scored.length,
      flaggedCount,
      lowConfidenceCount,
      average: average != null ? Math.round(average * 10) / 10 : null,
      highest,
      distribution: [
        { range: '0-20', value: buckets[0] },
        { range: '21-40', value: buckets[1] },
        { range: '41-60', value: buckets[2] },
        { range: '61-80', value: buckets[3] },
        { range: '81-100', value: buckets[4] },
      ],
      perQuestion,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not compute analytics.' })
  }
})

export default router