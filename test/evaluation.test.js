// Tests for the AI vs lecturer agreement metrics. Expected values for the
// fixed sample were cross checked against scikit-learn and SciPy
// (cohen_kappa_score, pearsonr, precision/recall/f1). Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pearson, cohensKappa, agreementStats, passFailMetrics, buildEvaluationReport, evaluationCsv } from '../src/lib/evaluation.js'

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`)

// Small hand checkable sample, out of 10.
const ai = [8, 6, 5, 9, 2, 7]
const lecturer = [8, 5, 5, 10, 3, 7]

test('pearson matches scipy and is null without variance', () => {
  close(pearson(ai, lecturer), 0.9544544639)
  assert.equal(pearson([5, 5, 5], [1, 2, 3]), null)
})

test('kappa and quadratic kappa match scikit-learn', () => {
  close(cohensKappa(lecturer, ai), 0.4375)
  close(cohensKappa(lecturer, ai, 'quadratic'), 0.9518716578)
  assert.equal(cohensKappa([4, 4], [4, 4]), null)
})

test('half marks are their own kappa category', () => {
  assert.equal(cohensKappa([2.5, 3, 2.5, 3], [2.5, 3, 2.5, 3]), 1)
})

test('agreementStats reports exact, within one, MAE, RMSE and bias', () => {
  const st = agreementStats(ai.map((s, i) => ({ suggested: s, confirmed: lecturer[i], maxMarks: 10 })))
  assert.equal(st.n, 6)
  assert.equal(st.exactAgreement, 0.5)
  assert.equal(st.withinOneMark, 1)
  assert.equal(st.mae, 0.5)
  assert.equal(st.rmse, 0.707)
  assert.equal(st.meanBias, -0.167)
  assert.equal(st.maePercentOfMax, 5)
})

test('passFailMetrics uses half marks as the pass line, lecturer as truth', () => {
  const pf = passFailMetrics([
    { suggested: 6, confirmed: 4, maxMarks: 10 }, // false pass
    { suggested: 5, confirmed: 5, maxMarks: 10 }, // true pass
    { suggested: 3, confirmed: 6, maxMarks: 10 }, // false fail
    { suggested: 1, confirmed: 2, maxMarks: 10 }, // true fail
  ])
  assert.deepEqual(pf, { accuracy: 0.5, precision: 0.5, recall: 0.5, f1: 0.5, confusion: { truePass: 1, falsePass: 1, falseFail: 1, trueFail: 1 } })
})

const row = (o) => ({ scriptId: 's1', regNumber: '2017364085', questionId: 'q1', questionLabel: 'Q1', maxMarks: 10, confidence: 'high', autoAccepted: false, overridden: false, ...o })

test('buildEvaluationReport leaves out auto accepted and unconfirmed answers', () => {
  const report = buildEvaluationReport([
    row({ suggested: 8, confirmed: 7 }),
    row({ questionId: 'q2', questionLabel: 'Q2', suggested: 5, confirmed: 5, confidence: 'medium' }),
    row({ scriptId: 's2', suggested: 9, confirmed: 9, autoAccepted: true }),
    row({ scriptId: 's3', suggested: 4, confirmed: null }),
    row({ scriptId: 's4', suggested: 3, confirmed: 6, confidence: 'low', overridden: true }),
  ])
  assert.equal(report.answersScored, 4)
  assert.equal(report.humanConfirmed, 3)
  assert.equal(report.autoAcceptedExcluded, 1)
  assert.equal(report.overriddenAfterConfirm, 1)
  assert.equal(report.byConfidence.high.n, 1)
  assert.equal(report.byConfidence.low.mae, 3)
  assert.deepEqual(report.perQuestion.map((q) => [q.question, q.n]), [['Q1', 2], ['Q2', 1]])
  // s1 (fully human) and s4 count; s2 had an auto accepted answer
  assert.equal(report.scripts.n, 2)
})

test('script level compares grades on percent of max', () => {
  const report = buildEvaluationReport([
    row({ suggested: 7, confirmed: 7 }), // A vs A
    row({ scriptId: 's2', suggested: 6, confirmed: 4.5 }), // B vs D
  ])
  assert.equal(report.scripts.sameGrade, 0.5)
  assert.equal(report.scripts.withinOneGrade, 0.5)
  assert.equal(report.scripts.maePercent, 7.5)
})

test('an empty session gives an empty report, not an error', () => {
  const report = buildEvaluationReport([])
  assert.equal(report.overall.n, 0)
  assert.equal(report.scripts.n, 0)
})

test('evaluationCsv writes one row per scored answer and quotes commas', () => {
  const csv = evaluationCsv([row({ suggested: 8, confirmed: 7, questionLabel: 'Q1, part a' }), row({ suggested: 1, confirmed: null })])
  const lines = csv.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].startsWith('script_id,reg_number,question'))
  assert.equal(lines[1], 's1,2017364085,"Q1, part a",10,high,8,7,1,false,false,,,')
})
