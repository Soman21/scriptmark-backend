import { computeGrade } from './grading.js'

// One line of a result sheet. The exam score only counts once every answer
// on the script is confirmed (by a lecturer or by auto accept), so an
// unchecked AI suggestion never reaches the sheet. With scores = 'total', the
// CA is added and a grade given only when both CA and exam score exist; a
// grade from the exam alone would be wrong for a course that has CA.
export function examScoreOf(script) {
  const answers = script.answers || []
  if (answers.length === 0 || answers.some((a) => a.confirmedAt == null)) return null
  return answers.reduce((sum, a) => sum + (a.confirmedScore ?? 0), 0)
}

export function resultRow(script, scores = 'total') {
  const name = script.studentName || script.studentIdentifier || 'Unnamed'
  const exam = examScoreOf(script)
  if (scores === 'exam') {
    return { name, regNumber: script.regNumber || '', exam, note: exam == null ? 'Not fully confirmed' : '' }
  }
  const ca = script.caScore ?? null
  const ready = exam != null && ca != null
  return {
    name,
    regNumber: script.regNumber || '',
    ca,
    exam,
    total: ready ? ca + exam : null,
    grade: ready ? computeGrade(ca + exam) : '',
    note: exam == null ? 'Not fully confirmed' : ca == null ? 'CA not entered' : '',
  }
}

export const RESULT_COLUMNS = {
  exam: [
    ['name', 'Student Name'],
    ['regNumber', 'Reg Number'],
    ['exam', 'Exam Score'],
    ['note', 'Note'],
  ],
  total: [
    ['name', 'Student Name'],
    ['regNumber', 'Reg Number'],
    ['ca', 'CA Score'],
    ['exam', 'Exam Score'],
    ['total', 'Total'],
    ['grade', 'Grade'],
    ['note', 'Note'],
  ],
}
