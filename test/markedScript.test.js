import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linesFromAnnotation } from '../src/lib/ocrLines.js'
import { findAnchors, findCover, marginX, tokens } from '../src/lib/markedLayout.js'
import { composeInk, inkItemsToShapes, movesFrom, remarkConflict, pathOf, fmt } from '../src/lib/markInk.js'
import { cleanInk } from '../src/routes/marked.js'

// A tiny Vision reply: two lines on a 1000 x 1400 image.
function word(text, x, y, w, brk) {
  return {
    boundingBox: { vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + 30 }, { x, y: y + 30 }] },
    symbols: text.split('').map((ch, i, all) => ({ text: ch, ...(i === all.length - 1 && brk ? { property: { detectedBreak: { type: brk } } } : {}) })),
  }
}

test('lines keep their text and position as fractions of the page', () => {
  const lines = linesFromAnnotation({
    pages: [{
      width: 1000,
      height: 1400,
      blocks: [{ paragraphs: [{ words: [word('Entities', 100, 280, 160, 'SPACE'), word('Lecturers', 280, 280, 180, 'LINE_BREAK'), word('Students', 100, 330, 170, 'LINE_BREAK')] }] }],
    }],
  })
  assert.deepEqual(lines, [
    ['Entities Lecturers', 0.1, 0.2, 0.36, 0.0214],
    ['Students', 0.1, 0.2357, 0.17, 0.0214],
  ])
  assert.deepEqual(linesFromAnnotation(null), [])
})

// Page 2 of a 542 script, as Vision would place it.
const page2 = [
  ['DO NOT WRITE ON THIS MARGIN', 0.86, 0.17, 0.08, 0.02],
  ['SECTION A', 0.3, 0.19, 0.15, 0.02],
  ['1a Entities', 0.1, 0.22, 0.2, 0.02],
  ['Lecturers', 0.12, 0.25, 0.2, 0.02],
  ['Students Department', 0.12, 0.28, 0.4, 0.02],
  ['Courses', 0.12, 0.31, 0.2, 0.02],
  ['1b Lecturers', 0.1, 0.35, 0.3, 0.02],
  ['Staff ID Name Rank and Office', 0.1, 0.38, 0.7, 0.02],
  ['Student', 0.3, 0.42, 0.2, 0.02],
  ['Registration Number Name Date of Birth Email', 0.1, 0.45, 0.8, 0.02],
  ['and phone number', 0.1, 0.48, 0.4, 0.02],
]
const page3 = [
  ['Relationship', 0.3, 0.1, 0.3, 0.02],
  ['Students Takes Courses', 0.2, 0.2, 0.6, 0.02],
  ['Each student take many courses', 0.2, 0.25, 0.7, 0.02],
]

test('a mark goes in the margin beside the last line of the answer', () => {
  const anchors = findAnchors(
    [{ pageNumber: 2, lines: page2 }, { pageNumber: 3, lines: page3 }],
    [
      { id: 'a', number: '1', subLabel: 'a', text: 'Entities: Lecturers, Students, Department, Courses.' },
      { id: 'b', number: '1', subLabel: 'b', text: 'Lecturers: Staff ID, Name, Rank and Office. Student: Registration Number, Name, Date of Birth, Email and phone number' },
      { id: 'c', number: '1', subLabel: 'c', text: 'Students takes courses. Each student take many courses.' },
    ]
  )
  assert.equal(anchors.a.page, 2)
  assert.ok(Math.abs(anchors.a.y - 0.32) < 0.001, `a at ${anchors.a.y}`)
  assert.equal(anchors.a.by, 'text')
  assert.ok(Math.abs(anchors.a.x - 0.9) < 0.001, 'in the printed margin column')
  assert.equal(anchors.b.page, 2)
  assert.ok(Math.abs(anchors.b.y - 0.49) < 0.001, `b at ${anchors.b.y}`)
  assert.equal(anchors.c.page, 3)
})

test('with no matching text the part label places the mark, else nothing', () => {
  const anchors = findAnchors([{ pageNumber: 2, lines: page2 }], [
    { id: 'b', number: '1', subLabel: 'b', text: '' },
    { id: 'z', number: '9', subLabel: 'c', text: 'quantum chromodynamics' },
  ])
  assert.equal(anchors.b.by, 'label')
  assert.ok(Math.abs(anchors.b.y - 0.36) < 0.001)
  assert.equal(anchors.z, undefined)
})

test('marks that would overlap are pushed apart', () => {
  const anchors = findAnchors([{ pageNumber: 1, lines: [['1a yes', 0.1, 0.3, 0.2, 0.02], ['1b no', 0.1, 0.32, 0.2, 0.02]] }], [
    { id: 'a', number: '1', subLabel: 'a', text: '' },
    { id: 'b', number: '1', subLabel: 'b', text: '' },
  ])
  assert.ok(anchors.b.y - anchors.a.y >= 0.0649)
})

test('margin falls back near the edge, and the stop words are ignored', () => {
  assert.equal(marginX([]), 0.9)
  assert.deepEqual(tokens('The data and the Network'), ['data', 'network'])
})

const cover = [
  ['MBELEDOGU KENECHUKWU UDOKA', 0.1, 0.07, 0.5, 0.02],
  ["EXAMINER'S USE ONLY", 0.73, 0.17, 0.15, 0.015],
  ['QUESTION NUMBER', 0.62, 0.64, 0.12, 0.02],
  ['REMARK', 0.76, 0.645, 0.1, 0.015],
  ['1', 0.66, 0.675, 0.02, 0.02],
  ['5', 0.66, 0.7, 0.02, 0.02],
  ['6', 0.66, 0.725, 0.02, 0.02],
  ['TOTAL', 0.63, 0.905, 0.08, 0.02],
]

test('the booklet cover: examiner box, mark column, rows and TOTAL', () => {
  const c = findCover(cover)
  assert.ok(Math.abs(c.totalAt.x - 0.805) < 0.001)
  assert.ok(Math.abs(c.totalAt.y - 0.235) < 0.001)
  assert.ok(Math.abs(c.markX - 0.81) < 0.001)
  assert.deepEqual(c.rows.map((r) => r.number), ['1', '5', '6'])
  assert.ok(Math.abs(c.totalY - 0.915) < 0.001)
  assert.equal(findCover([['Relationship', 0.3, 0.1, 0.3, 0.02]]), null)
})

const answers = [
  { id: 'a', number: '1', subLabel: 'a', score: 4, max: 4, remark: 'All entities identified', answered: true, counted: true },
  { id: 'b', number: '1', subLabel: 'b', score: 0, max: 4, remark: 'Attributes not given', answered: true, counted: true },
  { id: 'x', number: '2', subLabel: 'a', score: 0, max: 17.5, remark: '', answered: false, counted: true },
  { id: 'e', number: '5', subLabel: 'a', score: 3.5, max: 6, remark: '', answered: true, counted: false },
]

test('ink: tick for marks, cross for zero, circled score, remark, NC, nothing for unanswered', () => {
  const { pages, unplaced } = composeInk({
    pages: [{ pageNumber: 1, aspect: 1.4 }, { pageNumber: 2, aspect: 1.4 }],
    anchors: { a: { page: 2, x: 0.9, y: 0.3 }, b: { page: 2, x: 0.9, y: 0.5 } },
    cover: findCover(cover),
    answers,
    total: 4,
    totalMax: 70,
  })
  const p2 = pages[2]
  assert.ok(p2.some((s) => s.t === 'tick' && s.answerId === 'a'))
  assert.ok(p2.some((s) => s.t === 'cross' && s.answerId === 'b'))
  assert.ok(p2.some((s) => s.t === 'text' && s.text === 'All entities identified'))
  assert.ok(p2.some((s) => s.t === 'loop' && s.answerId === 'a'))
  assert.ok(!p2.some((s) => s.answerId === 'x'), 'unanswered parts get no ink')
  assert.deepEqual(unplaced, ['e'], 'answered but not found on the page')
  const texts = pages[1].filter((s) => s.t === 'text').map((s) => s.text)
  // Circled total over the exam total, the mark per question, NC, TOTAL.
  assert.deepEqual(texts, ['4', '70', '4', '3.5', 'NC', '4'])
  // y is in page widths: 0.3 of the height on a 1.4 page is 0.42.
  assert.ok(Math.abs(p2.find((s) => s.t === 'loop' && s.answerId === 'a').y - 0.42) < 1e-9)
})

test('a dragged mark goes where the lecturer put it', () => {
  const moves = movesFrom({ 3: [{ k: 'move', a: 'a', x: 0.5, y: 0.5 }, { k: 'pen', pts: [[0, 0], [1, 1]] }] })
  assert.deepEqual(moves, { a: { page: 3, x: 0.5, y: 0.5 } })
  const { pages } = composeInk({ pages: [{ pageNumber: 2, aspect: 1 }, { pageNumber: 3, aspect: 1 }], anchors: { a: { page: 2, x: 0.9, y: 0.3 } }, moves, answers: answers.slice(0, 1), coverPage: 99 })
  assert.equal(pages[2].length, 0)
  assert.ok(pages[3].some((s) => s.t === 'loop'))
})

test('a cover that is not the UNIZIK booklet lists the marks under the total', () => {
  const { pages } = composeInk({ pages: [{ pageNumber: 1, aspect: 1.4 }], answers, total: 4, totalMax: 70 })
  const texts = pages[1].filter((s) => s.t === 'text').map((s) => s.text)
  assert.deepEqual(texts, ['4', '70', 'Q1  4', 'Q5  3.5 NC'])
})

test('lecturer ink items become shapes, y scaled by the page shape', () => {
  const shapes = inkItemsToShapes([{ k: 'pen', pts: [[0.1, 0.5], [0.2, 0.5]] }, { k: 'text', x: 0.1, y: 0.5, t: 'key?' }, { k: 'tick', x: 0.2, y: 0.2 }, { k: 'move', a: 'a', x: 0, y: 0 }], 2)
  assert.deepEqual(shapes.map((s) => s.t), ['stroke', 'text', 'tick'])
  assert.deepEqual(shapes[0].pts, [[0.1, 1], [0.2, 1]])
  assert.equal(pathOf(shapes[0])[1][0], 'L')
  assert.equal(pathOf({ t: 'loop', x: 0.5, y: 0.5, rx: 0.04, ry: 0.03, seed: 'q' }).length, 4)
})

test('the same mark always draws the same wobble', () => {
  const a = pathOf({ t: 'loop', x: 0.5, y: 0.5, rx: 0.04, ry: 0.03, seed: 'abc' })
  const b = pathOf({ t: 'loop', x: 0.5, y: 0.5, rx: 0.04, ry: 0.03, seed: 'abc' })
  assert.deepEqual(a, b)
  assert.equal(fmt(13.499999), '13.5')
})

test('Check remark: full marks but "missing", or zero but "correct"', () => {
  assert.equal(remarkConflict(2, 2, 'Diagram missing, Presentation layer missing'), true)
  assert.equal(remarkConflict(1.5, 2, 'Diagram missing'), false)
  assert.equal(remarkConflict(0, 4, 'Correct and complete'), true)
  assert.equal(remarkConflict(0, 4, 'Incorrect modes explained'), false)
  assert.equal(remarkConflict(4, 4, 'All entities identified'), false)
  assert.equal(remarkConflict(4, 4, ''), false)
})

test('ink from the browser is checked and rounded', () => {
  const items = cleanInk([
    { k: 'pen', pts: [[0.12345678, 2], [-1, 0.5]], w: 1 },
    { k: 'pen', pts: [[0.1, 0.1]] },
    { k: 'text', x: 0.1, y: 0.1, t: '  key?  ' },
    { k: 'text', x: 0.1, y: 0.1, t: '   ' },
    { k: 'move', a: 'answer1', x: 0.5, y: 0.5 },
    { k: 'virus' },
    { k: 'tick', x: '0.3', y: 0.4 },
  ])
  assert.deepEqual(items, [
    { k: 'pen', pts: [[0.1235, 1], [0, 0.5]], w: 0.02 },
    { k: 'text', x: 0.1, y: 0.1, t: 'key?' },
    { k: 'move', a: 'answer1', x: 0.5, y: 0.5 },
    { k: 'tick', x: 0.3, y: 0.4 },
  ])
  assert.equal(cleanInk('nope'), null)
})
