// The red ink on a marked script, as simple shapes: a tick or cross, a hand
// drawn circle round the mark, the mark itself, the remark, and on the
// cover the total and the mark for each question.
//
// The SAME file is in the frontend (src/lib/markInk.js): the Marked view
// draws these shapes as SVG while the lecturer edits, and the backend draws
// them into the PDF, so screen and download always match. Change both
// together.
//
// Units: x and y are in page widths (0 to 1 across the page; y runs to the
// page's height / width). Sizes are in page widths too, so a circle stays
// round on any page shape.

export const INK = '#D0021B'

export function fmt(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return String(v)
}

function hash(text) {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}

// A small, repeatable wobble per mark, so circles and ticks differ a little
// the way a pen does, but redraw the same every time.
function wobble(seed, i) {
  const v = ((hash(`${seed}:${i}`) % 1000) / 1000) * 2 - 1
  return v * 0.004
}

// Path commands for a shape: [['M', x, y], ['C', x1, y1, x2, y2, x, y],
// ['Q', x1, y1, x, y], ['L', x, y]].
export function pathOf(p) {
  if (p.t === 'loop') {
    const { x, y, rx, ry } = p
    const w = (i) => wobble(p.seed || '', i)
    // Starts at the top right, goes round anticlockwise, and overshoots
    // the start a little, as a quick pen circle does.
    return [
      ['M', x + rx * 0.55 + w(1), y - ry * 0.95],
      ['C', x - rx * 0.6, y - ry * 1.25 + w(2), x - rx * 1.15 + w(3), y - ry * 0.2, x - rx * 0.9, y + ry * 0.55],
      ['C', x - rx * 0.6, y + ry * 1.15 + w(4), x + rx * 0.8, y + ry * 1.1, x + rx * 1.02 + w(5), y + ry * 0.2],
      ['C', x + rx * 1.12, y - ry * 0.5, x + rx * 0.5, y - ry * 1.05 + w(6), x - rx * 0.15, y - ry * 1.05],
    ]
  }
  if (p.t === 'tick') {
    const s = p.s
    return [['M', p.x, p.y - s * 0.05], ['Q', p.x + s * 0.2, p.y + s * 0.1, p.x + s * 0.32, p.y + s * 0.42], ['Q', p.x + s * 0.55, p.y - s * 0.25, p.x + s, p.y - s * 0.62]]
  }
  if (p.t === 'cross') {
    const s = p.s
    return [
      ['M', p.x, p.y - s * 0.5], ['Q', p.x + s * 0.45, p.y - s * 0.05, p.x + s, p.y + s * 0.5],
      ['M', p.x + s * 0.95, p.y - s * 0.55], ['Q', p.x + s * 0.45, p.y, p.x + s * 0.02, p.y + s * 0.6],
    ]
  }
  if (p.t === 'line') return [['M', p.x1, p.y1], ['Q', (p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2 - 0.003, p.x2, p.y2]]
  if (p.t === 'stroke') {
    const pts = p.pts || []
    if (!pts.length) return []
    return [['M', pts[0][0], pts[0][1]], ...pts.slice(1).map(([x, y]) => ['L', x, y])]
  }
  return []
}

// The mark at the end of one answer. x, y: the margin spot from the layout.
function answerMark(a, x, y) {
  const out = []
  const score = Number(a.score) || 0
  const max = Number(a.max) || 0
  const cx = Math.min(x, 0.955)
  if (score <= 0) out.push({ t: 'cross', x: cx - 0.115, y, s: 0.032 })
  else out.push({ t: 'tick', x: cx - 0.122, y, s: 0.044 })
  out.push({ t: 'loop', x: cx, y, rx: 0.044, ry: 0.036, seed: a.id })
  out.push({ t: 'text', x: cx - 0.012, y: y + 0.001, text: fmt(score), size: score >= 10 || !Number.isInteger(score) ? 0.03 : 0.038, anchor: 'middle', rot: -4 })
  out.push({ t: 'line', x1: cx - 0.006, y1: y + 0.02, x2: cx + 0.022, y2: y - 0.024 })
  out.push({ t: 'text', x: cx + 0.02, y: y + 0.028, text: fmt(max), size: max >= 10 || !Number.isInteger(max) ? 0.026 : 0.032, anchor: 'middle', rot: -4 })
  if (a.counted === false) out.push({ t: 'text', x: cx - 0.135, y: y + 0.012, text: 'NC', size: 0.03, anchor: 'end', rot: -3 })
  const remark = String(a.remark || '').trim()
  if (remark) out.push({ t: 'text', x: cx + 0.03, y: y + 0.066, text: remark, size: 0.03, anchor: 'end', rot: -2 })
  return out
}

// Per question number: the sum of its parts and whether it counts.
function byQuestion(answers) {
  const map = new Map()
  for (const a of answers) {
    const n = String(a.number ?? '').trim()
    if (!map.has(n)) map.set(n, { number: n, score: 0, counted: true, answered: false })
    const q = map.get(n)
    q.score += Number(a.score) || 0
    if (a.counted === false) q.counted = false
    if (a.answered) q.answered = true
  }
  return [...map.values()].filter((q) => q.answered).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
}

function coverInk(cover, questions, total, totalMax, aspect) {
  const out = []
  const circled = (x, y) => {
    out.push({ t: 'loop', x, y, rx: 0.074, ry: 0.06, seed: 'total' })
    out.push({ t: 'text', x, y: y - 0.008, text: fmt(total), size: 0.044, anchor: 'middle', rot: -4 })
    out.push({ t: 'line', x1: x - 0.056, y1: y + 0.004, x2: x + 0.058, y2: y - 0.004 })
    out.push({ t: 'text', x, y: y + 0.042, text: fmt(totalMax), size: 0.04, anchor: 'middle', rot: -4 })
  }
  if (cover?.totalAt) circled(cover.totalAt.x, cover.totalAt.y * aspect)
  if (cover?.rows && cover.totalY) {
    const used = new Set()
    let nextY = Math.max(cover.top || 0, ...cover.rows.map((r) => r.y)) + 0.022
    const step = 0.022
    for (const q of questions) {
      const row = cover.rows.find((r) => r.number === q.number && !used.has(r))
      let y
      if (row) {
        used.add(row)
        y = row.y
      } else {
        y = cover.rows.length ? nextY : (cover.top || 0) + 0.012 + step * questions.indexOf(q)
        nextY = y + step
        out.push({ t: 'text', x: cover.numberX, y: y * aspect + 0.01, text: q.number, size: 0.03, anchor: 'middle', rot: -3 })
      }
      if (y >= cover.totalY) continue
      out.push({ t: 'text', x: cover.markX, y: y * aspect + 0.01, text: fmt(q.score), size: 0.03, anchor: 'middle', rot: -3 })
      if (!q.counted) out.push({ t: 'text', x: cover.markX + 0.045, y: y * aspect + 0.01, text: 'NC', size: 0.022, anchor: 'start', rot: -3 })
    }
    out.push({ t: 'text', x: cover.markX, y: cover.totalY * aspect + 0.012, text: fmt(total), size: 0.034, anchor: 'middle', rot: -3 })
  }
  if (!cover?.totalAt) {
    // Not the booklet we know: the circled total in the top right corner,
    // with each question's mark listed under it.
    circled(0.86, 0.08)
    if (!cover?.rows) {
      questions.forEach((q, i) => {
        out.push({ t: 'text', x: 0.9, y: 0.17 + i * 0.032, text: `Q${q.number}  ${fmt(q.score)}${q.counted ? '' : ' NC'}`, size: 0.026, anchor: 'end', rot: -2 })
      })
    }
  }
  return out
}

// Everything to draw, page by page.
// pages: [{ pageNumber, aspect }] (aspect = height / width of the image)
// anchors: from markedLayout.findAnchors, y as a fraction of page height
// moves: { [answerId]: { page, x, y } } marks the lecturer dragged
// answers: [{ id, number, subLabel, score, max, remark, answered, counted }]
// Returns { pages: { [pageNumber]: shapes[] }, unplaced: answerIds[] }
export function composeInk({ pages, anchors = {}, moves = {}, cover = null, coverPage = 1, answers = [], total = 0, totalMax = 0 }) {
  const aspectOf = new Map(pages.map((p) => [p.pageNumber, p.aspect || 1.414]))
  const out = {}
  for (const p of pages) out[p.pageNumber] = []
  const unplaced = []
  for (const a of answers) {
    if (!a.answered) continue
    const spot = moves[a.id] || anchors[a.id]
    if (!spot || !out[spot.page]) {
      unplaced.push(a.id)
      continue
    }
    out[spot.page].push(...answerMark(a, spot.x, spot.y * aspectOf.get(spot.page)).map((s) => ({ ...s, answerId: a.id })))
  }
  if (out[coverPage]) out[coverPage].push(...coverInk(cover, byQuestion(answers), total, totalMax, aspectOf.get(coverPage)))
  return { pages: out, unplaced }
}

// The lecturer's own ink (ScriptInk.items) as shapes. Items keep x, y as
// fractions of width and height; shapes use page widths.
export function inkItemsToShapes(items, aspect) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    if (it.k === 'pen' && Array.isArray(it.pts)) out.push({ t: 'stroke', pts: it.pts.map(([x, y]) => [x, y * aspect]), w: it.w || 0.0035 })
    else if (it.k === 'text' && it.t) out.push({ t: 'text', x: it.x, y: it.y * aspect, text: String(it.t).slice(0, 200), size: it.s || 0.032, anchor: 'start', rot: -2 })
    else if (it.k === 'tick') out.push({ t: 'tick', x: it.x, y: it.y * aspect, s: it.s || 0.044 })
    else if (it.k === 'cross') out.push({ t: 'cross', x: it.x, y: it.y * aspect, s: it.s || 0.032 })
  }
  return out
}

// Marks the lecturer dragged to a better spot, from every page's items.
export function movesFrom(inkByPage) {
  const moves = {}
  for (const [page, items] of Object.entries(inkByPage || {})) {
    for (const it of Array.isArray(items) ? items : []) {
      if (it.k === 'move' && it.a) moves[it.a] = { page: Number(page), x: it.x, y: it.y }
    }
  }
  return moves
}

// The remark says something is missing but the score is full, or praises
// an answer that got nothing: one of the two is probably wrong.
const NEGATIVE = /\b(missing|incomplete|incorrect|wrong|omitted|omits|lacks?|lacking|absent|no diagram|not (given|shown|stated|labelled|explained)|error|unclear|partly|partial)\b/i
const POSITIVE = /\b(correct|accurate|complete|excellent|well done|all .* (identified|given|correct)|good)\b/i
export function remarkConflict(score, max, remark) {
  const text = String(remark || '')
  const s = Number(score)
  const m = Number(max)
  if (!text.trim() || !Number.isFinite(s) || !Number.isFinite(m) || m <= 0) return false
  if (s >= m && NEGATIVE.test(text)) return true
  if (s <= 0 && POSITIVE.test(text) && !/\bin(correct|complete|accurate)\b/i.test(text)) return true
  return false
}
