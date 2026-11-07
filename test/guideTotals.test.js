import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readExamRules, studentMax, scalePoints, fixGuideTotals, cleanAnswerRule } from '../src/lib/guideTotals.js'

test('reads exam total and answer rule from the instructions', () => {
  assert.deepEqual(readExamRules('Total Marks: 70\nINSTRUCTIONS: ANSWER question 1 and ANY (3) OTHER QUESTIONS.'),
    { examTotal: 70, answerRule: { compulsory: ['1'], any: 3 } })
  assert.deepEqual(readExamRules('Instructions: Answer Question two (Compulsory) and any Four (4) other questions.').answerRule,
    { compulsory: ['2'], any: 4 })
  assert.deepEqual(readExamRules('Answer any five questions').answerRule, { compulsory: [], any: 5 })
  assert.deepEqual(readExamRules('Answer all questions'), { examTotal: null, answerRule: null })
  assert.equal(cleanAnswerRule({ compulsory: ['1'], any: 0 }), null)
})

test('a student scores the compulsory question and the best of the rest', () => {
  const qs = [
    { number: '1', maxMarks: 10 }, { number: '1', maxMarks: 7.5 },
    { number: '2', maxMarks: 17.5 }, { number: '3', maxMarks: 15 }, { number: '4', maxMarks: 20 }, { number: '5', maxMarks: 17.5 },
  ]
  assert.equal(studentMax(qs, { compulsory: ['1'], any: 3 }), 17.5 + 20 + 17.5 + 17.5)
  assert.equal(studentMax(qs, null), 87.5)
})

test('points scale to a new part mark and stay on quarters', () => {
  const s = scalePoints([{ marks: 1 }, { marks: 1 }, { marks: 1 }, { marks: 1 }], 3)
  assert.deepEqual(s.map((p) => p.marks), [0.75, 0.75, 0.75, 0.75])
  const t = scalePoints([{ marks: 1 }, { marks: 1 }, { marks: 1 }], 2.5)
  assert.equal(t.reduce((a, p) => a + p.marks, 0), 2.5)
})

const pts = (...m) => m.map((marks, i) => ({ description: `p${i}`, marks }))

test('fix all: parts take their points totals when that makes the question add up (ECE 542 Q6)', async () => {
  const q6 = ['a', 'b', 'c', 'd', 'e', 'f'].map((l, i) => ({
    number: '6', subLabel: l, questionTotal: 17.5, maxMarks: i === 0 ? 2.5 : 2.92,
    steps: [pts(0.5, 0.5, 0.5, 0.5, 0.5), pts(0.75, 0.5, 0.5, 0.5, 0.75), pts(0.25, 0.25, 0.25, 0.25, 1), pts(0.5, 0.5, 0.5, 0.5), pts(0.75, 0.75, 0.75, 0.75), pts(0.5, 1.25, 1.25, 2)][i],
  }))
  let asked = false
  const out = await fixGuideTotals(q6, async () => { asked = true; return null })
  assert.equal(asked, false)
  assert.deepEqual(out.questions.map((q) => q.maxMarks), [2.5, 3, 2, 2, 3, 5])
  assert.deepEqual(out.warnings, [])
  assert.equal(out.changes.length, 5)
})

test('fix all: points are scaled when the part marks already add up', async () => {
  const qs = [
    { number: '5', subLabel: 'a', questionTotal: 10, maxMarks: 6, steps: pts(1, 1, 1, 1, 1, 1, 1, 1) },
    { number: '5', subLabel: 'b', questionTotal: 10, maxMarks: 4, steps: pts(2, 2) },
  ]
  const out = await fixGuideTotals(qs)
  assert.equal(out.questions[0].maxMarks, 6)
  assert.deepEqual(out.questions[0].steps.map((p) => p.marks), [0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75])
  assert.deepEqual(out.warnings, [])
})

test('fix all: the AI shares a gap, and a bad AI answer falls back to the largest part', async () => {
  const qs = () => [
    { number: '1', subLabel: 'a', questionTotal: 17.5, maxMarks: 4, steps: [] },
    { number: '1', subLabel: 'b', questionTotal: 17.5, maxMarks: 4, steps: [] },
    { number: '1', subLabel: 'd', questionTotal: 17.5, maxMarks: 5, steps: pts(1.25, 1.25, 1.25, 1.25) },
    { number: '1', subLabel: 'c', questionTotal: 17.5, maxMarks: 4, steps: [] },
  ]
  const ai = await fixGuideTotals(qs(), async () => [
    { subLabel: 'a', marks: 4 }, { subLabel: 'b', marks: 4 }, { subLabel: 'd', marks: 5.5, reason: 'Diagram, most work' }, { subLabel: 'c', marks: 4 },
  ])
  assert.deepEqual(ai.questions.map((q) => q.maxMarks), [4, 4, 5.5, 4])
  assert.equal(ai.questions[2].steps.reduce((a, p) => a + p.marks, 0), 5.5)
  assert.ok(ai.changes.some((c) => c.reason === 'Diagram, most work'))
  assert.deepEqual(ai.warnings, [])
  const bad = await fixGuideTotals(qs(), async () => [{ subLabel: 'a', marks: 99 }])
  assert.deepEqual(bad.questions.map((q) => q.maxMarks), [4, 4, 5.5, 4])
  assert.deepEqual(bad.warnings, [])
})
