// Tests for cohort analytics: summary stats, reg number groups, item
// analysis and session comparison. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeScores, regNumberGroups, itemAnalysis, buildCohortReport, compareSessions } from '../src/lib/cohort.js'

test('describeScores gives mean, median and sample standard deviation', () => {
  // Python statistics.stdev gives 22.7303
  assert.deepEqual(describeScores([30, 50, 55, 85]), { n: 4, mean: 55, median: 52.5, sd: 22.7, min: 30, max: 85 })
  assert.deepEqual(describeScores([]), { n: 0, mean: null, median: null, sd: null, min: null, max: null })
})

test('regNumberGroups reads entry year and programme from all reg number shapes', () => {
  assert.deepEqual(regNumberGroups('2017364085'), { entryYear: '2017', programme: 'Undergraduate' })
  assert.deepEqual(regNumberGroups('2025366001FN'), { entryYear: '2025', programme: 'Postgraduate' })
  assert.deepEqual(regNumberGroups('2021/245678'), { entryYear: '2021', programme: 'Undergraduate' })
  assert.deepEqual(regNumberGroups(null), { entryYear: null, programme: null })
})

const q1 = { id: 'q1', number: '1', subLabel: null, text: 'Easy', maxMarks: 10 }
const q2 = { id: 'q2', number: '2', subLabel: null, text: 'Separating', maxMarks: 10 }
// Eight students; q1 everyone scores 8, q2 tracks overall ability.
const scripts = [70, 65, 60, 55, 45, 40, 35, 20].map((total, i) => ({
  id: `s${i}`,
  regNumber: i < 6 ? `20213640${i}0` : `20253660${i}1FN`,
  totalScore: total,
  caScore: i === 7 ? 25 : null,
  answers: [
    { question: q1, suggestedScore: 8, confirmedScore: null },
    { question: q2, suggestedScore: 9 - i, confirmedScore: i === 0 ? 10 : null },
  ],
}))

test('itemAnalysis flags a question that does not separate strong from weak students', () => {
  const [a, b] = itemAnalysis(scripts)
  assert.equal(a.question, 'Q1')
  assert.equal(a.facility, 0.8)
  assert.equal(a.discrimination, 0)
  assert.equal(a.needsReview, true)
  // top 27% (2 students): 10 and 8; bottom 2: 3 and 2, out of 10
  assert.equal(b.discrimination, 0.65)
  assert.equal(b.needsReview, false)
})

test('itemAnalysis gives no discrimination for a class too small to split', () => {
  assert.equal(itemAnalysis(scripts.slice(0, 3))[0].discrimination, null)
})

test('buildCohortReport adds CA to the exam score like the result sheet', () => {
  const r = buildCohortReport([...scripts, { id: 'x', totalScore: null, answers: [] }])
  assert.equal(r.scoredScripts, 8)
  assert.equal(r.totalScripts, 9)
  // 20 + 25 CA = 45 is a pass (D); 35 is the only fail
  assert.equal(r.summary.passRate, 0.875)
  assert.deepEqual(r.gradeDistribution.map((g) => g.count), [1, 2, 1, 2, 1, 1])
  assert.deepEqual(r.byProgramme.map((g) => [g.group, g.n]), [['Postgraduate', 2], ['Undergraduate', 6]])
  assert.deepEqual(r.byEntryYear.map((g) => g.group), ['2021', '2025'])
})

test('compareSessions summarises each session and copes with an empty one', () => {
  const rows = compareSessions([
    { id: 'a', title: 'ECE512', courseCode: 'ECE512', scripts: [{ totalScore: 50, caScore: 10 }, { totalScore: 30, caScore: null }] },
    { id: 'b', title: 'Empty', scripts: [] },
  ])
  assert.deepEqual(rows[0], { id: 'a', title: 'ECE512', courseCode: 'ECE512', academicSession: undefined, semester: undefined, scoredScripts: 2, mean: 45, sd: 21.2, passRate: 0.5 })
  assert.equal(rows[1].mean, null)
  assert.equal(rows[1].passRate, null)
})
