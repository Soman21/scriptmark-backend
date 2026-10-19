// Cleanup for the course details a student writes on a script's front page
// (course code, semester, academic session), and the rule for when they may
// fill in a marking session's own fields. Kept separate from groq.js so it
// stays pure and testable without any AI calls.

// "ece 512", "ECE512", "ECE-512" all become "ECE512", matching the
// session form's own "CSC401" example. Anything not shaped like 2 to 4
// letters then 3 digits is treated as unreadable.
export function cleanCourseCode(raw) {
  if (!raw) return null
  const m = String(raw).toUpperCase().replace(/[\s\-_.]+/g, '').match(/^([A-Z]{2,4})(\d{3})$/)
  return m ? `${m[1]}${m[2]}` : null
}

// The booklet prints "20__/20__", so a student writes the two years. Only
// a real pair of consecutive years is kept, as "2025/2026".
export function cleanAcademicSession(raw) {
  if (!raw) return null
  const m = String(raw).replace(/\s+/g, '').match(/^((?:19|20)\d{2})[\/\\]((?:19|20)?\d{2})$/)
  if (!m) return null
  const start = Number(m[1])
  const end = m[2].length === 2 ? Number(m[1].slice(0, 2) + m[2]) : Number(m[2])
  return end === start + 1 ? `${start}/${end}` : null
}

// "1st", "first", "FIRST SEMESTER", "Harmattan" become "First"; the same
// for second and Rain. Anything else is treated as unreadable.
export function cleanSemester(raw) {
  if (!raw) return null
  const s = String(raw).toLowerCase().replace(/semester/g, '').trim()
  if (/^(1|1st|first|harmattan)$/.test(s)) return 'First'
  if (/^(2|2nd|second|rain)$/.test(s)) return 'Second'
  return null
}

const FIELDS = ['courseCode', 'semester', 'academicSession']

// Which of the session's course fields a script's front page may fill in:
// only those the lecturer left blank, and only with a value that was read
// cleanly. What the lecturer typed is never overwritten.
export function courseDetailsToFill(session, detected) {
  const fill = {}
  for (const field of FIELDS) {
    const current = session?.[field]
    const blank = current === null || current === undefined || String(current).trim() === ''
    if (blank && detected?.[field]) fill[field] = detected[field]
  }
  return fill
}
