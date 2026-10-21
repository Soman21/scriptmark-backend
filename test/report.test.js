import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReportFacts, weakAnswerReasons, cleanReport } from '../src/lib/report.js'

const analytics = {
  totalScripts: 3,
  scoredCount: 3,
  average: 21.3,
  highest: 30,
  distribution: [{ range: '0-20', value: 1 }],
  perQuestion: [
    { number: '1', subLabel: 'a', text: 'Define', maxMarks: 10, averagePercent: 80, responseCount: 3 },
    { number: '2', subLabel: null, text: 'Derive', maxMarks: 20, averagePercent: 35, responseCount: 3 },
    { number: '3', subLabel: null, text: 'Unused', maxMarks: 5, averagePercent: null, responseCount: 0 },
  ],
}

test('facts rank the questions and carry the agreement numbers as percents', () => {
  const facts = buildReportFacts({ courseCode: 'ECE 301', title: 'Signals' }, analytics, {
    humanConfirmed: 9,
    autoAcceptedExcluded: 3,
    overriddenAfterConfirm: 1,
    overall: { exactAgreement: 0.667, withinOneMark: 0.889 },
  })
  assert.equal(facts.title, 'ECE 301 Signals')
  assert.deepEqual(facts.perQuestion.map((q) => q.question), ['Q1a', 'Q2'])
  assert.deepEqual(facts.hardest, ['Q2'])
  assert.deepEqual(facts.easiest, ['Q1a'])
  assert.equal(facts.marking.exactAgreement, 67)
})

test('only weak answers on the hardest questions feed the common mistakes', () => {
  const qn = (number, maxMarks) => ({ number, subLabel: null, maxMarks })
  const reasons = weakAnswerReasons(
    [
      { question: qn('2', 20), reasoning: 'Missed the boundary condition', confirmedScore: 4 },
      { question: qn('2', 20), reasoning: 'Full derivation', confirmedScore: 18 },
      { question: qn('4', 10), reasoning: 'Not a hard question', confirmedScore: 1 },
    ],
    ['Q2']
  )
  assert.deepEqual(reasons, { Q2: ['Missed the boundary condition'] })
})

test('the cleaner drops unknown questions and removes dashes', () => {
  const facts = { perQuestion: [{ question: 'Q2' }] }
  const out = cleanReport(
    { overview: 'Good overall — mostly.', questions: [{ question: '2', comment: 'Weak - often' }, { question: 'Q9', comment: 'x' }], recommendations: ['Revise **limits**'] },
    facts
  )
  assert.equal(out.overview, 'Good overall, mostly.')
  assert.deepEqual(out.questions, [{ question: 'Q2', comment: 'Weak, often' }])
  assert.deepEqual(out.recommendations, ['Revise limits'])
})
