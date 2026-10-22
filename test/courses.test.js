import { test } from 'node:test'
import assert from 'node:assert/strict'
import { courseKey, groupCourses, courseWeights, checkWeights, buildCourseSheet } from '../src/lib/courses.js'

const done = (...scores) => scores.map((s) => ({ confirmedAt: new Date(), confirmedScore: s }))
const script = (id, regNumber, studentName, answers, caScore = null) => ({ id, regNumber, studentName, answers, caScore })

test('sessions group by course code, academic session and semester', () => {
  const base = { academicSession: '2025/2026', semester: 'First' }
  const groups = groupCourses([
    { id: 'a', courseCode: 'ECE 432', examinationType: 'Examination', ...base },
    { id: 'b', courseCode: 'ece432', examinationType: 'Test', ...base },
    { id: 'c', courseCode: 'ECE 432', examinationType: 'Test', academicSession: '2025/2026', semester: 'Second' },
    { id: 'd', courseCode: null },
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['a', 'b'])
  assert.equal(groups[0].courseCode, 'ECE 432')
  assert.equal(courseKey({ courseCode: '' }), null)
})

test('default weights: exam 70, CA sessions share 30, typed CA when there is none', () => {
  const exam = { id: 'e', examinationType: 'Examination' }
  const test1 = { id: 't', examinationType: 'Test' }
  const assign = { id: 'a', examinationType: 'Assignment' }
  assert.deepEqual(courseWeights([exam, test1, assign]).weights, { e: 70, t: 15, a: 15 })
  assert.equal(courseWeights([exam]).typedCaMax, 30)
  assert.deepEqual(courseWeights([{ ...exam, weight: 60 }, { ...test1, weight: 40 }]).weights, { e: 60, t: 40 })
})

test('weights must add up to 100 when CA comes from sessions', () => {
  const s = [
    { id: 'e', examinationType: 'Examination' },
    { id: 't', examinationType: 'Test' },
  ]
  assert.equal(checkWeights(s, { e: 70, t: 20 }), 'Weights must add up to 100.')
  assert.equal(checkWeights(s, { e: 70, t: 30 }), null)
  assert.equal(checkWeights([s[0]], { e: 80 }), null)
  assert.equal(checkWeights([s[0]], { e: 120 }), 'Each weight must be between 0 and 100.')
})

test('combined sheet matches by reg number, scales to weight and marks Absent', () => {
  const sheet = buildCourseSheet([
    {
      id: 'exam',
      title: 'ECE 432 Exam',
      examinationType: 'Examination',
      weight: 70,
      maxMarks: 70,
      scripts: [script('x1', '2017/364085', 'Ada Obi', done(30, 26)), script('x2', '2017364090', 'Bola Ade', done(40))],
    },
    {
      id: 'test',
      title: 'ECE 432 Test',
      examinationType: 'Test',
      weight: 20,
      maxMarks: 40,
      scripts: [script('t1', '2017 364085', 'ADA OBI', done(30))],
    },
    {
      id: 'assign',
      title: 'ECE 432 Assignment',
      examinationType: 'Assignment',
      weight: 10,
      maxMarks: 10,
      scripts: [script('a1', '2017364085', 'Ada Obi', done(8)), script('a2', '2017364090', 'Bola Ade', done(5))],
    },
  ])
  assert.deepEqual(sheet.assessments.map((a) => a.sessionId), ['test', 'assign', 'exam'])
  const [ada, bola] = sheet.rows
  assert.equal(ada.regNumber, '2017/364085')
  assert.equal(ada.cells.test.score, 15) // 30 of 40, scaled to 20
  assert.equal(ada.ca, 23)
  assert.equal(ada.exam, 56)
  assert.equal(ada.total, 79)
  assert.equal(ada.grade, 'A')
  assert.equal(bola.cells.test.status, 'ABSENT')
  assert.equal(bola.ca, 5)
  assert.equal(bola.total, 45)
  assert.equal(bola.note, 'Absent: Test')
})

test('only an exam session: CA is typed on the script, otherwise the total waits', () => {
  const sheet = buildCourseSheet([
    {
      id: 'exam',
      title: 'Exam',
      examinationType: 'Examination',
      weight: null,
      maxMarks: 70,
      scripts: [script('x1', 'R1', 'Ada', done(50), 25), script('x2', 'R2', 'Bola', done(40))],
    },
  ])
  assert.equal(sheet.typedCaMax, 30)
  assert.equal(sheet.rows[0].total, 75)
  assert.equal(sheet.rows[0].caTyped, true)
  assert.equal(sheet.rows[1].total, null)
  assert.equal(sheet.rows[1].note, 'CA not entered')
})

test('a typed CA overrides the CA sessions, and unconfirmed scripts hold the total', () => {
  const sheet = buildCourseSheet([
    { id: 'exam', title: 'Exam', examinationType: 'Examination', weight: 70, maxMarks: 70, scripts: [script('x1', 'R1', 'Ada', done(50), 28), script('x2', 'R2', 'Bola', [{ confirmedAt: null, confirmedScore: null }])] },
    { id: 'test', title: 'Test', examinationType: 'Test', weight: 30, maxMarks: 30, scripts: [script('t1', 'R1', 'Ada', done(10)), script('t2', 'R2', 'Bola', done(20))] },
  ])
  assert.equal(sheet.rows[0].ca, 28)
  assert.equal(sheet.rows[0].total, 78)
  assert.equal(sheet.rows[1].cells.exam.status, 'PENDING')
  assert.equal(sheet.rows[1].total, null)
  assert.equal(sheet.rows[1].note, 'Not fully confirmed')
})
