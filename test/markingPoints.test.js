import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanPoints, checkGuideTotals, needsDiagramLook, attemptMark, capUnlabelledDrawing,
  applyPointScores, pointAgreement, roundQuarter,
  countBestFrom, cleanCountBest, countedPoints, bestTotal,
} from '../src/lib/markingPoints.js'

const q3 = [
  { number: '3', subLabel: 'i', maxMarks: 5, questionTotal: 10, steps: [
    { description: 'Source', marks: 1.25 }, { description: 'Channel', marks: 1.25 },
    { description: 'Labelled block diagram', marks: 2.5, note: 'DIAGRAM' },
  ] },
  { number: '3', subLabel: 'ii', maxMarks: 5, questionTotal: 10, steps: [
    { description: 'Full duplex', marks: 0.5 }, { description: 'Half duplex', marks: 0.5 },
  ] },
]

test('totals: points must add up to the part, parts to the question', () => {
  const w = checkGuideTotals(q3)
  assert.deepEqual(w, [{ label: 'Q3ii', kind: 'POINTS', expected: 5, actual: 1 }])
  const parts = checkGuideTotals([{ ...q3[0], questionTotal: 12 }, { ...q3[1], steps: [] }])
  assert.deepEqual(parts, [{ label: 'Q3', kind: 'PARTS', expected: 12, actual: 10 }])
  assert.deepEqual(checkGuideTotals([{ number: '1', maxMarks: 2.5, steps: [{ marks: 1.25 }, { marks: '1.25' }] }]), [])
})

test('cleanPoints keeps quarter marks, notes and the guide diagram', () => {
  const p = cleanPoints([
    { description: ' Analog Signals ', marks: '1.25', note: 'DIAGRAM', diagram: ' boxes ' },
    { description: '', marks: 3 },
    { description: 'x', marks: 1, note: 'WHAT' },
  ])
  assert.deepEqual(p, [
    { description: 'Analog Signals', marks: 1.25, note: 'DIAGRAM', diagram: 'boxes' },
    { description: 'x', marks: 1, note: null, diagram: null },
  ])
})

test('diagram look: by note or by the question asking for a drawing', () => {
  assert.equal(needsDiagramLook(q3[0]), true)
  assert.equal(needsDiagramLook({ text: 'Sketch the waveform', steps: [] }), true)
  assert.equal(needsDiagramLook({ text: 'Define modulation', steps: [] }), false)
})

test('unlabelled drawing earns about a fifth of the point', () => {
  assert.equal(attemptMark(5), 1)
  assert.equal(attemptMark(2.5), 0.5)
  assert.equal(attemptMark(1.25), 0.25)
  assert.equal(attemptMark(0.5), 0.25)
  const bd = [
    { description: 'Source', marks: 1.25, note: null, awarded: 1.25, result: 'full', reasoning: '' },
    { description: 'Diagram', marks: 2.5, note: 'DIAGRAM', awarded: 2.5, result: 'full', reasoning: 'Correct.' },
  ]
  const { breakdown, changed } = capUnlabelledDrawing(bd, false)
  assert.equal(changed, true)
  assert.deepEqual(breakdown.map((p) => p.awarded), [1.25, 0.5])
  assert.equal(breakdown[1].result, 'partial')
  assert.equal(capUnlabelledDrawing(bd, true).changed, false)
})

test('lecturer point marks: checked and summed', () => {
  const pts = [{ marks: 1.25, awarded: 1 }, { marks: 0.5, awarded: 0.5 }]
  assert.deepEqual(applyPointScores(pts, [1.25, 0.25]).total, 1.5)
  assert.match(applyPointScores(pts, [2, 0]).error, /Point 1/)
  assert.match(applyPointScores(pts, [1]).error, /every point/)
  assert.match(applyPointScores(null, [1]).error, /no marking points/)
})

test('point agreement counts only points a lecturer marked', () => {
  const r = pointAgreement([
    { stepBreakdown: [{ marks: 1.25, awarded: 1.25, confirmed: 1.25 }, { marks: 1, awarded: 0.5, confirmed: 0 }] },
    { stepBreakdown: [{ marks: 1, awarded: 1 }] },
    { diagramDescription: 'boxes', stepBreakdown: [{ marks: 2, awarded: 2, confirmed: 1.5 }] },
  ])
  assert.equal(r.n, 3)
  assert.equal(r.exactAgreement, 0.33)
  assert.equal(r.sameResult, 0.33)
  assert.equal(r.diagram.n, 1)
  assert.equal(roundQuarter(0.6), 0.5)
})

test('parts that may be answered with a table also get a look at the page', () => {
  assert.equal(needsDiagramLook({ text: 'Critically compare LAN, MAN and WAN', steps: [] }), true)
  assert.equal(needsDiagramLook({ text: 'Differentiate between FDM and TDM', steps: [] }), true)
  assert.equal(needsDiagramLook({ text: 'Explain the term', modelAnswer: '| Criteria | LAN |\n| --- | --- |\n| Cost | Low |', steps: [] }), true)
  assert.equal(needsDiagramLook({ text: 'State Ohm\'s law', modelAnswer: 'V = IR', steps: [] }), false)
})

// "Any five" questions (Racle, 7 Nov 2026): the 538 guide lists seven
// characteristics for "State and explain any five", one mark each.
const seven = Array.from({ length: 7 }, (_, i) => ({ description: `c${i + 1}`, marks: 1 }))

test('count best: read from "any five" in the question text', () => {
  assert.equal(countBestFrom('State and explain any five characteristics of effective data communication.', 7), 5)
  assert.equal(countBestFrom('List ANY 3 types', 5), 3)
  assert.equal(countBestFrom('Draw any three network topologies', 3), null) // no extra points listed
  assert.equal(countBestFrom('State five characteristics', 7), null)
  assert.equal(countBestFrom('', 7), null)
})

test('count best: only a whole number below the point count is kept', () => {
  assert.equal(cleanCountBest('5', 7), 5)
  assert.equal(cleanCountBest(7, 7), null)
  assert.equal(cleanCountBest(2.5, 7), null)
  assert.equal(cleanCountBest(0, 7), null)
  assert.equal(cleanCountBest(null, 7), null)
})

test('count best: the highest scores count, ties to the earlier point', () => {
  assert.deepEqual(countedPoints([1, 1, 0, 1, 1, 1, 1], 5), [0, 1, 3, 4, 5])
  assert.equal(bestTotal([1, 1, 0, 1, 1, 1, 1], 5), 5)
  assert.equal(bestTotal([0.5, 1, 0.25], 2), 1.5)
  assert.equal(bestTotal([1, 1, 1], null), 3)
  assert.deepEqual(countedPoints([1, 2], null), [0, 1])
})

test('count best: guide totals check uses the best points only', () => {
  assert.deepEqual(checkGuideTotals([{ number: '1', subLabel: 'b', maxMarks: 5, countBest: 5, steps: seven }]), [])
  assert.deepEqual(checkGuideTotals([{ number: '1', subLabel: 'b', maxMarks: 5, steps: seven }]), [
    { label: 'Q1b', kind: 'POINTS', expected: 5, actual: 7 },
  ])
})

test('count best: lecturer point marks total the best points', () => {
  const points = seven.map((p) => ({ ...p, awarded: 1 }))
  const { total } = applyPointScores(points, [1, 1, 0, 1, 1, 1, 1], 5)
  assert.equal(total, 5)
  assert.equal(applyPointScores(points, [1, 0, 0, 0, 0, 0, 1], 5).total, 2)
})

test('printed heading marks are read exactly, decimals included', async () => {
  const { printedMarks, applyPrintedMarks } = await import('../src/lib/markingPoints.js')
  const text = `Question 1 (17.5 Marks)
[Printed 15 Marks. Parts: 4 + 4 + 4 + 5.5 = 17.5.]
(1c) Identify the relationships among the entities. (4 Marks)
• 1 mark for identifying the relationship (Belongs to).
(1d) Draw a complete E-R Diagram for the scenario. (5.5 Marks)
[Printed 4 Marks, changed to 5 by hand.]
\fQuestion 4 (17.5 Marks)
(4b) Assess the impact of poor data integrity on clinical decision-making, patient safety, legal
compliance, and organizational performance, and propose strategies to prevent data integrity
violations. (12.5 Marks)
(4c) No mark on the heading
• Point (2 marks)`
  const r = printedMarks(text)
  assert.deepEqual(r.parts, { '1c': 4, '1d': 5.5, '4b': 12.5 })
  assert.deepEqual(r.totals, { 1: 17.5, 4: 17.5 })
  const qs = applyPrintedMarks([
    { number: '1', subLabel: 'c', maxMarks: 4.38, questionTotal: null },
    { number: '1', subLabel: 'd', maxMarks: 4.38 },
    { number: '4', subLabel: 'c', maxMarks: 3 },
  ], text)
  assert.deepEqual(qs.map((q) => [q.maxMarks, q.questionTotal]), [[4, 17.5], [5.5, 17.5], [3, 17.5]])
})
