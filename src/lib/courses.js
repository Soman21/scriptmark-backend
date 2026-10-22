import { computeGrade } from './grading.js'
import { examScoreOf } from './resultRows.js'

// A course is not stored anywhere. Sessions with the same course code,
// academic session and semester belong together, so the grouping always
// follows whatever the sessions say now. Test and Assignment count as CA,
// Examination (or no type) is the exam.

export const normalizeCode = (code) => (code || '').toUpperCase().replace(/\s+/g, '')
// How the course code is shown: as the lecturer typed it, tidied.
export const displayCode = (code) => (code || '').trim().toUpperCase().replace(/\s+/g, ' ')

export function courseKey(session) {
  const code = normalizeCode(session.courseCode)
  if (!code) return null
  return [code, session.academicSession || '', session.semester || ''].join('|')
}

export const isCA = (session) => session.examinationType === 'Test' || session.examinationType === 'Assignment'

export function groupCourses(sessions) {
  const groups = new Map()
  for (const s of sessions) {
    const key = courseKey(s)
    if (!key) continue
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        courseCode: displayCode(s.courseCode),
        academicSession: s.academicSession || null,
        semester: s.semester || null,
        sessions: [],
      })
    }
    groups.get(key).sessions.push(s)
  }
  return [...groups.values()]
}

const DEFAULT_EXAM = 70

// Weight of each session in the course, out of 100. A weight the lecturer
// set is kept; the rest default to 70 for the exam and 30 shared by the CA
// sessions. With no CA session, whatever the exam leaves is typed CA.
export function courseWeights(sessions) {
  const exams = sessions.filter((s) => !isCA(s))
  const cas = sessions.filter(isCA)
  const weights = {}
  for (const s of exams) weights[s.id] = s.weight ?? DEFAULT_EXAM / exams.length
  for (const s of cas) weights[s.id] = s.weight ?? (100 - DEFAULT_EXAM) / cas.length
  const examTotal = exams.reduce((sum, s) => sum + weights[s.id], 0)
  return { weights, typedCaMax: cas.length ? null : Math.max(0, 100 - examTotal) }
}

// The sum a set of new weights must reach: 100 when every part of the
// course is a session, at most 100 when CA is typed.
export function checkWeights(sessions, weights) {
  const values = sessions.map((s) => Number(weights[s.id]))
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) return 'Each weight must be between 0 and 100.'
  const total = values.reduce((a, b) => a + b, 0)
  const hasCA = sessions.some(isCA)
  if (hasCA && Math.abs(total - 100) > 0.01) return 'Weights must add up to 100.'
  if (!hasCA && total > 100) return 'Weights cannot exceed 100.'
  return null
}

const round1 = (n) => Math.round(n * 10) / 10

function studentKey(script) {
  const reg = (script.regNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (reg) return `reg:${reg}`
  const name = (script.studentName || script.studentIdentifier || '').trim().toLowerCase()
  return name ? `name:${name}` : `script:${script.id}`
}

// sessions: [{ id, title, examinationType, weight, maxMarks,
//   scripts: [{ id, studentName, regNumber, studentIdentifier, caScore, answers }] }]
// A student is matched across sessions by reg number (name when there is
// none). A session the student has no script in shows Absent and counts 0.
// A script that is not fully confirmed holds back the total.
export function buildCourseSheet(sessions) {
  const { weights, typedCaMax } = courseWeights(sessions)
  const ordered = [...sessions.filter(isCA), ...sessions.filter((s) => !isCA(s))]
  const assessments = ordered.map((s) => ({
    sessionId: s.id,
    title: s.title,
    type: s.examinationType || 'Examination',
    kind: isCA(s) ? 'CA' : 'EXAM',
    weight: weights[s.id],
    maxMarks: s.maxMarks || null,
  }))

  // Exam scripts go first so a student's name and reg number come from the
  // exam, the record that matters most, when the spellings differ.
  const students = new Map()
  for (const s of [...sessions.filter((x) => !isCA(x)), ...sessions.filter(isCA)]) {
    for (const script of s.scripts || []) {
      const key = studentKey(script)
      if (!students.has(key)) students.set(key, { name: '', regNumber: '', scripts: {} })
      const st = students.get(key)
      st.name ||= script.studentName || script.studentIdentifier || ''
      st.regNumber ||= script.regNumber || ''
      st.scripts[s.id] = script
    }
  }

  const rows = [...students.values()].map((st) => {
    const cells = {}
    const absent = []
    let pending = false
    for (const a of assessments) {
      const script = st.scripts[a.sessionId]
      if (!script) {
        cells[a.sessionId] = { status: 'ABSENT', score: null }
        absent.push(a.type)
        continue
      }
      const raw = examScoreOf(script)
      if (raw == null) {
        cells[a.sessionId] = { status: 'PENDING', score: null, scriptId: script.id }
        pending = true
        continue
      }
      const scaled = a.maxMarks ? (raw / a.maxMarks) * a.weight : raw
      cells[a.sessionId] = { status: 'OK', score: round1(scaled), raw, scriptId: script.id }
    }

    const sumOf = (kind) =>
      assessments.filter((a) => a.kind === kind).reduce((sum, a) => sum + (cells[a.sessionId].score ?? 0), 0)

    // A CA typed on the exam script always wins, so the lecturer can correct
    // it by hand even when Test and Assignment sessions exist.
    const examScript = assessments.filter((a) => a.kind === 'EXAM').map((a) => st.scripts[a.sessionId]).find(Boolean)
    const typedCa = examScript?.caScore ?? null
    const hasCaSessions = assessments.some((a) => a.kind === 'CA')
    const ca = typedCa != null ? typedCa : hasCaSessions ? round1(sumOf('CA')) : null
    const exam = round1(sumOf('EXAM'))

    const ready = !pending && ca != null
    const total = ready ? round1(ca + exam) : null
    const note = pending
      ? 'Not fully confirmed'
      : ca == null
        ? 'CA not entered'
        : absent.length
          ? `Absent: ${absent.join(', ')}`
          : ''

    return {
      name: st.name || 'Unnamed',
      regNumber: st.regNumber,
      cells,
      ca,
      caTyped: typedCa != null,
      caScriptId: examScript?.id || null,
      exam: assessments.some((a) => a.kind === 'EXAM' && cells[a.sessionId].status === 'OK') ? exam : null,
      total,
      grade: total == null ? '' : computeGrade(total),
      note,
    }
  })

  rows.sort((a, b) => (a.regNumber || a.name).localeCompare(b.regNumber || b.name, undefined, { numeric: true }))
  return { assessments, typedCaMax, rows }
}
