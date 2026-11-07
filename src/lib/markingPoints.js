// Marking points: the smallest unit of a marking guide. A question has
// parts (i, ii... or a, b...), each part has marking points, and each
// point carries its own mark, e.g. "Analog signals (1.25 Marks)".
// Stored on Question.steps as [{ description, marks, note, diagram }]:
//   note     null, "DIAGRAM" (a labelled drawing is expected; labels are
//            required for full marks) or "LABELS_OPTIONAL" (a drawing is
//            expected; labels are not needed)
//   diagram  text description of the drawing in the guide itself, written
//            by the vision model when the guide was uploaded (editable)
//
// Pure helpers only (no database), so they are easy to unit test.

export const POINT_NOTES = ['DIAGRAM', 'LABELS_OPTIONAL']

// Marks are kept to the nearest quarter: guides use 0.25, 0.5, 0.75, 1.25.
export function roundQuarter(n) {
  return Math.round(Number(n) * 4) / 4
}

const near = (a, b) => Math.abs(a - b) < 1e-6
const toNum = (v) => {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// Normalises points from the editor or the AI guide parser. Blank
// descriptions are dropped; marks become numbers; unknown notes become null.
export function cleanPoints(points) {
  if (!Array.isArray(points)) return []
  return points
    .map((p) => ({
      description: String(p?.description ?? '').trim(),
      marks: Math.max(0, toNum(p?.marks) ?? 0),
      note: POINT_NOTES.includes(p?.note) ? p.note : null,
      diagram: typeof p?.diagram === 'string' && p.diagram.trim() ? p.diagram.trim() : null,
    }))
    .filter((p) => p.description)
}

// "Any five" questions: the guide lists every accepted answer (say 7
// points) and only the student's best five count. Question.countBest holds
// that number; null means every point counts.
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

// A count only makes sense when it is fewer than the points listed.
export function cleanCountBest(value, pointCount) {
  const n = toNum(value)
  if (n == null || !Number.isInteger(n) || n < 1 || n >= pointCount) return null
  return n
}

// Reads "any five", "any 3", "any two (2)" from a question's text. Returns
// the number when the guide lists more points than that, else null.
export function countBestFrom(text, pointCount) {
  const m = String(text || '').match(/\bany\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i)
  if (!m) return null
  const word = m[1].toLowerCase()
  return cleanCountBest(COUNT_WORDS[word] ?? Number(word), pointCount)
}

// Positions of the points that count: the countBest highest values (ties
// go to the earlier point), or all of them when countBest is null.
export function countedPoints(values, countBest) {
  const nums = (values || []).map((v) => toNum(v) ?? 0)
  const all = nums.map((_, i) => i)
  const n = cleanCountBest(countBest, nums.length)
  if (n == null) return all
  return all
    .sort((a, b) => nums[b] - nums[a] || a - b)
    .slice(0, n)
    .sort((a, b) => a - b)
}

// Total of the points that count.
export function bestTotal(values, countBest) {
  const nums = (values || []).map((v) => toNum(v) ?? 0)
  return roundTo(countedPoints(nums, countBest).reduce((sum, i) => sum + nums[i], 0))
}

// Checks a guide's arithmetic before any marking happens. questions are
// flat Question rows ({ number, subLabel, maxMarks, questionTotal, steps }).
// Returns a list of { label, kind, expected, actual }:
//   POINTS  the points of a part do not add up to the part's mark
//   PARTS   the parts of a question do not add up to its printed total
export function checkGuideTotals(questions) {
  const warnings = []
  const byNumber = new Map()
  for (const q of questions || []) {
    const points = Array.isArray(q.steps) ? q.steps : []
    const max = toNum(q.maxMarks) ?? 0
    if (points.length) {
      // With "best 5 of 7" the part is out of the 5 highest point marks.
      const sum = bestTotal(points.map((p) => p.marks), q.countBest)
      if (!near(sum, max)) warnings.push({ label: `Q${q.number}${q.subLabel || ''}`, kind: 'POINTS', expected: max, actual: roundTo(sum) })
    }
    const key = String(q.number)
    if (!byNumber.has(key)) byNumber.set(key, [])
    byNumber.get(key).push(q)
  }
  for (const [number, parts] of byNumber) {
    const total = parts.map((p) => toNum(p.questionTotal)).find((t) => t != null && t > 0)
    if (total == null) continue
    const sum = parts.reduce((s, p) => s + (toNum(p.maxMarks) ?? 0), 0)
    if (!near(sum, total)) warnings.push({ label: `Q${number}`, kind: 'PARTS', expected: total, actual: roundTo(sum) })
  }
  return warnings
}

function roundTo(n) {
  return Math.round(n * 100) / 100
}

// Whether a part may be answered with a drawing or a table, so the page
// images get a look from the vision model (OCR cannot read a drawing, and
// reads a table across the page, mixing its columns). True when any point
// accepts a diagram, the question asks for a drawing or a comparison that
// students usually set out as a table, or the guide's answer is a table.
const DRAWING_WORDS = /\b(draw|sketch|diagram|illustrate|label(?:led)?|block diagram|circuit|graph|plot)\b/i
const TABLE_WORDS = /\b(table|tabulate|tabular|compare|comparison|differentiate|distinguish|contrast)\b/i
const MARKDOWN_TABLE = /^\s*\|.*\|\s*$/m
export function needsDiagramLook(question) {
  const points = Array.isArray(question?.steps) ? question.steps : []
  if (points.some((p) => POINT_NOTES.includes(p?.note))) return true
  const text = String(question?.text || '')
  return DRAWING_WORDS.test(text) || TABLE_WORDS.test(text) || MARKDOWN_TABLE.test(String(question?.modelAnswer || ''))
}

// Racle's rules (6 Nov 2026): a related but incorrect attempt at a point,
// and a drawing with no labels, each earn an attempt mark of about a fifth
// of the point, to the nearest quarter (at least 0.25).
export function attemptMark(marks) {
  if (!(marks > 0)) return 0
  return Math.min(marks, Math.max(0.25, roundQuarter(marks / 5)))
}

// Applies that rule after the AI has marked: when the vision model saw
// that the student's drawing has no labels, every point that expects a
// labelled drawing is capped at its attempt mark. Returns the new
// breakdown (unchanged when nothing applies) and whether anything changed.
export function capUnlabelledDrawing(breakdown, labelled) {
  if (!Array.isArray(breakdown) || labelled !== false) return { breakdown, changed: false }
  let changed = false
  const next = breakdown.map((p) => {
    if (p.note !== 'DIAGRAM') return p
    const cap = attemptMark(p.marks)
    if (!(p.awarded > cap)) return p
    changed = true
    return { ...p, awarded: cap, result: pointResult(cap, p.marks), reasoning: `${p.reasoning ? p.reasoning + ' ' : ''}Drawing has no labels, attempt mark only.`.trim() }
  })
  return { breakdown: next, changed }
}

// "full" | "partial" | "none" for one point's award.
export function pointResult(awarded, marks) {
  if (!(awarded > 0)) return 'none'
  return near(awarded, marks) || awarded > marks ? 'full' : 'partial'
}

// Lecturer marks entered point by point. points: the answer's stored
// breakdown; scores: one number per point. Returns { breakdown, total } or
// { error }. countBest: only that many of the best points count.
export function applyPointScores(points, scores, countBest = null) {
  if (!Array.isArray(points) || !points.length) return { error: 'This answer has no marking points.' }
  if (!Array.isArray(scores) || scores.length !== points.length) return { error: 'Enter a mark for every point.' }
  const breakdown = []
  for (let i = 0; i < points.length; i++) {
    const s = toNum(scores[i])
    const marks = toNum(points[i].marks) ?? 0
    if (s == null || s < 0 || s > marks + 1e-9) return { error: `Point ${i + 1} must be between 0 and ${marks}.` }
    breakdown.push({ ...points[i], confirmed: s })
  }
  return { breakdown, total: bestTotal(breakdown.map((p) => p.confirmed), countBest) }
}

// Point level agreement between the AI and a lecturer, for the evaluation
// report: only points a lecturer marked one by one count, so a blanket
// Confirm all of the AI's marks does not inflate the figure.
export function pointAgreement(answers) {
  const pairs = []
  for (const a of answers || []) {
    for (const p of Array.isArray(a.stepBreakdown) ? a.stepBreakdown : []) {
      const ai = toNum(p.awarded)
      const lecturer = toNum(p.confirmed)
      if (ai == null || lecturer == null) continue
      pairs.push({ ai, lecturer, marks: toNum(p.marks) ?? 0, drawn: !!a.diagramDescription })
    }
  }
  const summarise = (list) => {
    if (!list.length) return { n: 0 }
    const same = list.filter((p) => pointResult(p.ai, p.marks) === pointResult(p.lecturer, p.marks)).length
    const exact = list.filter((p) => near(p.ai, p.lecturer)).length
    const mae = list.reduce((s, p) => s + Math.abs(p.ai - p.lecturer), 0) / list.length
    return { n: list.length, exactAgreement: roundTo(exact / list.length), sameResult: roundTo(same / list.length), mae: roundTo(mae) }
  }
  return { ...summarise(pairs), diagram: summarise(pairs.filter((p) => p.drawn)) }
}

// Marks printed in the guide's own headings, read straight from the text so
// the AI parser cannot drop or average them. The parser has been seen to
// split a question's total evenly over its parts (17.5 / 4 = 4.38) even when
// each part heading printed its own mark, and any mark is allowed, not just
// quarters (2.5, 5.5, 17.5, 4.38 all work).
//   parts   { "1c": 4, "6b": 3 }   from part headings such as
//           "(1c) Identify the relationships. (4 Marks)", "1c) ... [4 marks]"
//   totals  { "1": 17.5 }          from "Question 1 (17.5 Marks)"
// A part heading may wrap onto up to three more lines; the mark must be on the
// heading itself, before any bullet or [bracketed note] line.
const MARK = String.raw`[(\[]\s*(\d+(?:\.\d+)?)\s*marks?\s*[)\]]`
const NEXT_LINE = String.raw`\n(?![ \t\f]*(?:[•o▪\-*\[]|\(?\d+[ \t]*\(?[a-z]\)|question\b))[^\n]*?`
const PART_HEADING = new RegExp(String.raw`^[ \t\f]*\(?(\d+)[ \t]*\(?([a-z])\)[^\n]*?(?:${NEXT_LINE}){0,3}?${MARK}`, 'gim')
const QUESTION_TOTAL = new RegExp(String.raw`^[ \t\f]*question[ \t]+(\d+)\b[^\n]*?${MARK}`, 'gim')

export function printedMarks(rawText) {
  const text = String(rawText || '')
  const parts = {}
  const totals = {}
  for (const m of text.matchAll(PART_HEADING)) {
    const key = `${m[1]}${m[2].toLowerCase()}`
    if (!(key in parts)) parts[key] = Number(m[3])
  }
  for (const m of text.matchAll(QUESTION_TOTAL)) {
    if (!(m[1] in totals)) totals[m[1]] = Number(m[2])
  }
  return { parts, totals }
}

// Puts the printed heading marks onto the parsed questions. Questions the
// headings do not name keep what the parser read.
export function applyPrintedMarks(questions, rawText) {
  const { parts, totals } = printedMarks(rawText)
  return (questions || []).map((q) => {
    const number = String(q.number ?? '').trim()
    const key = `${number}${String(q.subLabel ?? '').trim().toLowerCase()}`
    const out = { ...q }
    if (q.subLabel && key in parts) out.maxMarks = parts[key]
    if (number in totals) out.questionTotal = totals[number]
    return out
  })
}
