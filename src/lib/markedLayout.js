// Where red ink goes on a marked script, worked out from the positions of
// the OCR lines on each page (ScriptPage.ocrLines, see ocrLines.js).
//
// anchors: for each answered part, the page and height of the LAST line of
// the student's answer, so the mark sits at the end of the answer the way a
// lecturer writes it, in the page's right margin.
// cover: on the UNIZIK booklet front, the Examiner's use only box (for the
// circled total) and the Question number / Mark table (a row per question,
// then TOTAL).
//
// All positions are fractions of the page width (x) and height (y).
// Nothing here costs an AI or OCR call: the lines were saved when the page
// was read for marking.

const STOP = new Set(['the', 'and', 'for', 'are', 'that', 'this', 'with', 'from', 'which', 'into', 'its', 'can', 'has', 'have', 'was', 'were', 'will', 'not', 'but', 'also', 'one', 'each'])

export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t))
}

// Right hand margin of a page: the printed "Do not write on this margin"
// column of the UNIZIK booklet when OCR read it, otherwise near the edge.
export function marginX(lines) {
  const label = (lines || []).find(([t, x]) => /margin/i.test(t) && x > 0.55)
  const x = label ? label[1] + label[3] / 2 : 0.9
  return Math.min(Math.max(x, 0.75), 0.94)
}

// A line that starts with this part's label: "1a", "1(a)", "(1a)", "Q1a",
// "Question 1 (a)". For a part with no letter, "1." or "Q1".
function labelPattern(number, subLabel) {
  const n = String(number).trim().replace(/[^0-9a-z]/gi, '')
  if (!n) return null
  const sub = String(subLabel || '').trim().replace(/[^0-9a-z]/gi, '')
  const head = `^[\\s(\\[]*(?:q(?:uestion|n|ue)?\\.?\\s*)?${n}`
  return sub ? new RegExp(`${head}\\s*[(.\\s]*${sub}\\b`, 'i') : new RegExp(`${head}(?:[.)\\s]|$)`, 'i')
}

function readingOrder(pages) {
  const out = []
  for (const p of pages) {
    const lines = Array.isArray(p.lines) ? [...p.lines].sort((a, b) => a[2] - b[2]) : []
    lines.forEach((line, i) => out.push({ page: p.pageNumber, i, line }))
  }
  return out
}

// The run of lines that best matches the answer text the AI copied out for
// this part. A line matches when at least half of its words appear in the
// answer (and at least two, or one long one). Up to two lines in between
// may not match (crossed out words, a line OCR got wrong).
// A line that starts with ANOTHER part's label ("1b" while looking for 1a)
// starts that part's answer, so it ends any run.
function bestRun(ordered, answerTokens, otherLabels = []) {
  const set = new Set(answerTokens)
  let best = null
  let run = null
  let gap = 0
  for (const item of ordered) {
    if (otherLabels.some((re) => re.test(item.line[0]))) {
      run = null
      gap = 0
      continue
    }
    const lt = tokens(item.line[0])
    const hits = lt.filter((t) => set.has(t)).length
    const match = lt.length > 0 && hits >= Math.ceil(lt.length / 2) && (hits >= 2 || (lt.length === 1 && lt[0].length >= 5))
    if (match) {
      if (run && (gap > 2 || run.lastPage !== item.page && gap > 0)) run = null
      if (!run) run = { weight: 0, last: item, lastPage: item.page }
      run.weight += hits
      run.last = item
      run.lastPage = item.page
      gap = 0
      if (!best || run.weight > best.weight) best = { ...run }
    } else if (run) {
      gap++
      if (gap > 2) run = null
    }
  }
  return best
}

const MIN_RUN_WEIGHT = 3

// answers: [{ id, number, subLabel, text }], only parts the student answered.
// pages: [{ pageNumber, lines }]. Returns { [answerId]: { page, x, y, by } }
// where by says how the place was found ('text' or 'label').
export function findAnchors(pages, answers, options = {}) {
  const skipPages = new Set(options.skipPages || [])
  const usable = pages.filter((p) => Array.isArray(p.lines) && p.lines.length && !skipPages.has(p.pageNumber))
  const ordered = readingOrder(usable)
  const margins = new Map(usable.map((p) => [p.pageNumber, marginX(p.lines)]))
  const anchors = {}
  const labels = answers.map((a) => labelPattern(a.number, a.subLabel))
  for (const [i, a] of answers.entries()) {
    const others = labels.filter((re, j) => re && j !== i && String(re) !== String(labels[i]))
    const run = bestRun(ordered, tokens(a.text), others)
    let spot = null
    if (run && run.weight >= MIN_RUN_WEIGHT) {
      const [, , y, , h] = run.last.line
      spot = { page: run.last.page, y: y + h / 2, by: 'text' }
    } else {
      const pattern = labelPattern(a.number, a.subLabel)
      const hit = pattern && ordered.find((o) => pattern.test(o.line[0]))
      if (hit) spot = { page: hit.page, y: hit.line[2] + hit.line[4] / 2, by: 'label' }
    }
    if (spot) anchors[a.id] = { ...spot, x: margins.get(spot.page) }
  }
  spreadOut(anchors)
  return anchors
}

// Two marks that would land on top of each other on the same page are
// pushed apart, the lower one moving down.
const MIN_GAP = 0.065
function spreadOut(anchors) {
  const byPage = new Map()
  for (const [id, a] of Object.entries(anchors)) {
    if (!byPage.has(a.page)) byPage.set(a.page, [])
    byPage.get(a.page).push(a)
  }
  for (const list of byPage.values()) {
    list.sort((a, b) => a.y - b.y)
    for (let i = 1; i < list.length; i++) {
      if (list[i].y - list[i - 1].y < MIN_GAP) list[i].y = Math.min(list[i - 1].y + MIN_GAP, 0.97)
    }
  }
}

// The booklet front. Returns null when the page does not look like it.
export function findCover(lines) {
  if (!Array.isArray(lines) || !lines.length) return null
  const cx = (l) => l[1] + l[3] / 2
  const cy = (l) => l[2] + l[4] / 2
  const examiner = lines.find((l) => /examiner'?s?\s*(use|only)/i.test(l[0]) || (/examiner/i.test(l[0]) && l[1] > 0.5))
  const header = lines.find((l) => /question/i.test(l[0]) && l[1] > 0.45 && l[2] > 0.4)
  const total = lines.find((l) => /^\s*total\s*$/i.test(l[0]) && l[1] > 0.45)
  const markHead = header && lines.find((l) => /^\s*(remarks?|marks?)\s*$/i.test(l[0]) && l[1] > header[1] && Math.abs(l[2] - header[2]) < 0.04)
  if (!examiner && !(header && total)) return null
  const cover = {}
  if (examiner) cover.totalAt = { x: cx(examiner), y: examiner[2] + examiner[4] + 0.05 }
  if (header && total) {
    const top = header[2] + header[4]
    const qx0 = header[1] - 0.03
    const qx1 = header[1] + header[3] + 0.03
    cover.markX = markHead ? cx(markHead) : header[1] + header[3] + 0.06
    cover.numberX = cx(header)
    cover.totalY = cy(total)
    cover.top = top
    cover.rows = lines
      .filter((l) => cy(l) > top && cy(l) < total[2] && cx(l) > qx0 && cx(l) < qx1 && /^\s*\(?\d{1,2}[a-z]?\)?\s*$/i.test(l[0]))
      .map((l) => ({ number: l[0].replace(/[^0-9]/g, ''), y: cy(l) }))
      .sort((a, b) => a.y - b.y)
  }
  return cover
}
