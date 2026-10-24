import express from 'express'
import ExcelJS from 'exceljs'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { accessibleSessionsWhere, canManageSession } from '../lib/access.js'
import { courseKey, groupCourses, courseWeights, checkWeights, buildCourseSheet } from '../lib/courses.js'

const router = express.Router()
router.use(requireAuth)

const SESSION_FIELDS = {
  id: true,
  title: true,
  courseCode: true,
  academicSession: true,
  semester: true,
  examinationType: true,
  weight: true,
  status: true,
  createdById: true,
  department: true,
  faculty: true,
}

const keyOf = (q) => courseKey({ courseCode: q.code, academicSession: q.session, semester: q.semester })

// Only sessions this user can open are ever part of their course view.
async function courseSessions(user, key, select = SESSION_FIELDS) {
  const where = await accessibleSessionsWhere(prisma, user)
  const sessions = await prisma.markingSession.findMany({
    where: { AND: [where, { courseCode: { not: null } }] },
    select,
    orderBy: { createdAt: 'asc' },
  })
  return sessions.filter((s) => courseKey(s) === key)
}

async function loadSheet(user, key) {
  const sessions = await courseSessions(user, key, {
    ...SESSION_FIELDS,
    guide: { select: { questions: { select: { maxMarks: true } } } },
    scripts: {
      select: {
        id: true,
        studentName: true,
        regNumber: true,
        studentIdentifier: true,
        caScore: true,
        answers: { select: { confirmedAt: true, confirmedScore: true } },
      },
    },
  })
  if (!sessions.length) return null
  const withMax = sessions.map((s) => ({ ...s, maxMarks: (s.guide?.questions || []).reduce((sum, q) => sum + q.maxMarks, 0) }))
  const canEdit = (await Promise.all(sessions.map((s) => canManageSession(prisma, s, user)))).every(Boolean)
  const first = sessions[0]
  return {
    course: {
      key,
      courseCode: groupCourses([first])[0].courseCode,
      academicSession: first.academicSession,
      semester: first.semester,
      department: first.department,
      faculty: first.faculty,
    },
    canEdit,
    ...buildCourseSheet(withMax),
  }
}

// GET /api/courses - every course the user has a session in, with its
// sessions and their weights.
router.get('/', async (req, res) => {
  try {
    const where = await accessibleSessionsWhere(prisma, req.user)
    const sessions = await prisma.markingSession.findMany({
      where: { AND: [where, { courseCode: { not: null } }] },
      select: SESSION_FIELDS,
      orderBy: { createdAt: 'asc' },
    })
    const courses = groupCourses(sessions).map((c) => {
      const { weights, typedCaMax } = courseWeights(c.sessions)
      return {
        ...c,
        typedCaMax,
        sessions: c.sessions.map((s) => ({
          id: s.id,
          title: s.title,
          examinationType: s.examinationType || 'Examination',
          status: s.status,
          weight: weights[s.id],
        })),
      }
    })
    res.json(courses)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load courses.' })
  }
})

// GET /api/courses/results?code=&session=&semester= - the combined sheet.
router.get('/results', async (req, res) => {
  try {
    const key = keyOf(req.query)
    if (!key) return res.status(400).json({ error: 'Course code is required.' })
    const sheet = await loadSheet(req.user, key)
    if (!sheet) return res.status(404).json({ error: 'Course not found.' })
    res.json(sheet)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load the result sheet.' })
  }
})

// PUT /api/courses/weights  body: { code, session, semester, weights: { sessionId: number } }
// Every session in the course must be one the user manages, otherwise a
// lecturer could change how another coordinator's exam counts.
router.put('/weights', async (req, res) => {
  try {
    const key = keyOf(req.body)
    const sessions = key ? await courseSessions(req.user, key) : []
    if (!sessions.length) return res.status(404).json({ error: 'Course not found.' })
    const allowed = await Promise.all(sessions.map((s) => canManageSession(prisma, s, req.user)))
    if (!allowed.every(Boolean)) return res.status(403).json({ error: 'Only the coordinator can change weights.' })

    const weights = req.body.weights || {}
    const problem = checkWeights(sessions, weights)
    if (problem) return res.status(400).json({ error: problem })

    await prisma.$transaction(
      sessions.map((s) => prisma.markingSession.update({ where: { id: s.id }, data: { weight: Number(weights[s.id]) } })),
    )
    res.json(await loadSheet(req.user, key))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not save the weights.' })
  }
})

const fmt = (n) => (n == null ? '' : n)

// GET /api/courses/export?code=&session=&semester= - the sheet as Excel.
router.get('/export', async (req, res) => {
  try {
    const key = keyOf(req.query)
    const sheetData = key ? await loadSheet(req.user, key) : null
    if (!sheetData) return res.status(404).json({ error: 'Course not found.' })
    const { course, assessments, rows } = sheetData

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Results')
    const title = [course.courseCode, course.academicSession, course.semester && `${course.semester} Semester`].filter(Boolean).join(', ')
    sheet.addRow([title]).font = { size: 16, bold: true }
    sheet.addRow([`Department: ${course.department || 'Not set'}`])
    sheet.addRow([`Faculty: ${course.faculty || 'Not set'}`])
    sheet.addRow([])

    const header = [
      'Student Name',
      'Reg Number',
      ...assessments.map((a) => `${a.type} (${Math.round(a.weight)})`),
      'CA',
      'Exam',
      'Total',
      'Grade',
      'Note',
    ]
    const headerRow = sheet.addRow(header)
    headerRow.font = { bold: true }
    headerRow.eachCell((cell) => {
      cell.border = { bottom: { style: 'thin' } }
    })

    const cellText = (c) => (c.status === 'ABSENT' ? 'Absent' : c.status === 'PENDING' ? 'Pending' : c.score)
    for (const r of rows) {
      sheet.addRow([
        r.name,
        r.regNumber,
        ...assessments.map((a) => cellText(r.cells[a.sessionId])),
        fmt(r.ca),
        fmt(r.exam),
        fmt(r.total),
        r.grade,
        r.note,
      ])
    }
    sheet.columns.forEach((col, i) => {
      col.width = i === 0 ? 28 : 16
    })

    const safeName = (course.courseCode || 'course').replace(/[^a-z0-9]/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_result_sheet.xlsx"`)
    await workbook.xlsx.write(res)
    res.end()
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not generate the export.' })
  }
})

export default router
