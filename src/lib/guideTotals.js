// Guide totals: the exam total, the answer rule ("Question 1 and any three
// others"), what one student can score, and the Fix all suggestions for
// guides whose points, parts and question totals do not add up.
// Pure helpers (the AI is passed in), so they are easy to unit test.
import { bestTotal, cleanCountBest, checkGuideTotals } from './markingPoints.js'

const round2 = (n) => Math.round(n * 100) / 100
const near = (a, b) => Math.abs(a - b) < 0.005
const toNum = (v) => {
  const n = typeof v === 'string' ? Number(v.trim()) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const wordNum = (w) => WORDS[String(w).toLowerCase()] ?? toNum(w)

// Exam total, null when none is set. Must be above 0.
export function cleanExamTotal(value) {
  const n = toNum(value)
  return n != null && n > 0 ? n : null
}

// Answer rule: { compulsory: ['1'], any: 3 } means Question 1 and any three
// other questions. compulsory may be empty ("answer any five"). null means
// every question is answered.
export function cleanAnswerRule(rule) {
  if (!rule || typeof rule !== 'object') return null
  const compulsory = [...new Set((Array.isArray(rule.compulsory) ? rule.compulsory : []).map((n) => String(n).trim()).filter(Boolean))]
  const any = toNum(rule.any)
  if (any == null || !Number.isInteger(any) || any < 1) return null
  return { compulsory, any }
}

// Reads the exam total and the answer rule from a paper's or guide's text:
//   "Total Marks: 100", "Answer Question 1 and any three (3) other questions",
//   "Answer Question two (Compulsory) and any Four (4) other questions",
//   "Answer any five questions".
export function readExamRules(rawText) {
  const text = String(rawText || '')
  const totalMatch = text.match(/total\s+marks?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)
  const examTotal = totalMatch ? cleanExamTotal(totalMatch[1]) : null

  let answerRule = null
  const line = text.match(/answer\s+([^\n]*questions?)\b/i)
  if (line) {
    const body = line[1]
    const anyMatch = body.match(/\bany\s*\(?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*\)?/i)
    if (anyMatch) {
      const before = body.slice(0, anyMatch.index)
      const compulsory = [...before.matchAll(/question\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi)].map((m) => String(wordNum(m[1])))
      answerRule = cleanAnswerRule({ compulsory, any: wordNum(anyMatch[1]) })
    }
  }
  return { examTotal, answerRule }
}

// What one student can score: the compulsory questions plus the highest
// `any` of the others, each question counted by its parts' marks. With no
// rule, every question counts.
export function studentMax(questions, rule) {
  const totals = new Map()
  for (const q of questions || []) {
    const key = String(q.number ?? '').trim()
    totals.set(key, (totals.get(key) || 0) + (toNum(q.maxMarks) ?? 0))
  }
  const clean = cleanAnswerRule(rule)
  if (!clean) return round2([...totals.values()].reduce((s, t) => s + t, 0))
  let sum = 0
  const others = []
  for (const [number, total] of totals) {
    if (clean.compulsory.includes(number)) sum += total
    else others.push(total)
  }
  others.sort((a, b) => b - a)
  return round2(sum + others.slice(0, clean.any).reduce((s, t) => s + t, 0))
}

// Scales a part's points so the ones that count add up to `target`. Marks
// stay on quarters when every point and the target are quarters; the
// rounding left over goes on the largest point.
export function scalePoints(points, target, countBest) {
  const list = (points || []).map((p) => ({ ...p, marks: toNum(p.marks) ?? 0 }))
  const n = cleanCountBest(countBest, list.length)
  const now = bestTotal(list.map((p) => p.marks), n)
  if (!list.length || !(now > 0) || near(now, target)) return list
  const quarters = [...list.map((p) => p.marks), target].every((m) => near(m * 4, Math.round(m * 4)))
  const step = quarters ? 4 : 100
  const scaled = list.map((p) => ({ ...p, marks: Math.round((p.marks * target / now) * step) / step }))
  // Spread what rounding left over one step at a time, largest points
  // first, so no single point takes it all; anything still left (a point
  // would go below 0) goes on the largest point.
  const unit = 1 / step
  const order = scaled.map((_, i) => i).sort((a, b) => scaled[b].marks - scaled[a].marks || a - b)
  for (let i = 0, guard = 0; guard < 1000; guard++, i = (i + 1) % order.length) {
    const left = round2(target - bestTotal(scaled.map((p) => p.marks), n))
    if (near(left, 0)) break
    const k = order[i]
    const next = round2(scaled[k].marks + Math.sign(left) * unit)
    if (next >= 0) scaled[k] = { ...scaled[k], marks: next }
  }
  const left = round2(target - bestTotal(scaled.map((p) => p.marks), n))
  if (!near(left, 0)) {
    const big = order[0]
    scaled[big] = { ...scaled[big], marks: round2(Math.max(0, scaled[big].marks + left)) }
  }
  return scaled
}

const pointsTotal = (q) => bestTotal((q.steps || []).map((p) => p.marks), q.countBest)
const label = (q) => `Q${q.number}${q.subLabel || ''}`

// Fix all. questions: flat guide questions ({ number, subLabel, text,
// maxMarks, questionTotal, steps, countBest }). chooseParts(question, parts,
// target) is the AI: for a question whose parts cannot be made to add up
// from the guide alone, it returns new part marks [{ subLabel, marks,
// reason }] that add up to target. Returns { questions, changes }, where
// changes are { label, item, from, to, reason } for the review list.
// Nothing is saved; the lecturer applies and saves.
export async function fixGuideTotals(questions, chooseParts) {
  const out = (questions || []).map((q) => ({ ...q, maxMarks: toNum(q.maxMarks) ?? 0, steps: Array.isArray(q.steps) ? q.steps.map((p) => ({ ...p })) : [] }))
  const changes = []
  const groups = new Map()
  out.forEach((q) => {
    const key = String(q.number)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(q)
  })

  const setPart = (q, to, reason) => {
    if (near(q.maxMarks, to)) return
    changes.push({ label: label(q), item: 'part', from: q.maxMarks, to: round2(to), reason })
    q.maxMarks = round2(to)
  }
  const setPoints = (q, reason) => {
    if (!q.steps.length || near(pointsTotal(q), q.maxMarks)) return
    const next = scalePoints(q.steps, q.maxMarks, q.countBest)
    next.forEach((p, i) => {
      if (!near(p.marks, q.steps[i].marks)) changes.push({ label: label(q), item: `point ${i + 1}`, from: q.steps[i].marks, to: p.marks, reason })
    })
    q.steps = next
  }

  for (const parts of groups.values()) {
    const target = parts.map((p) => toNum(p.questionTotal)).find((t) => t != null && t > 0) ?? null
    const partsSum = () => round2(parts.reduce((s, p) => s + p.maxMarks, 0))
    const off = parts.filter((p) => p.steps.length && !near(pointsTotal(p), p.maxMarks))

    if (target == null) {
      // No question total: a part takes the total of its points, which are
      // what students are marked on.
      off.forEach((p) => setPart(p, pointsTotal(p), 'Matches its points'))
      continue
    }
    // A: parts take their points' totals. B: parts keep their marks and
    // the points are scaled. Use whichever makes the question add up,
    // preferring the printed part marks.
    const sumA = round2(parts.reduce((s, p) => s + (off.includes(p) ? pointsTotal(p) : p.maxMarks), 0))
    if (near(partsSum(), target)) {
      off.forEach((p) => setPoints(p, 'Matches the part mark'))
      continue
    }
    if (near(sumA, target)) {
      off.forEach((p) => setPart(p, pointsTotal(p), 'Matches its points'))
      continue
    }
    // Neither: start from A, then share the difference by judgement.
    off.forEach((p) => setPart(p, pointsTotal(p), 'Matches its points'))
    let picked = null
    try {
      picked = chooseParts ? await chooseParts(parts, target) : null
    } catch {
      picked = null
    }
    const valid = Array.isArray(picked) &&
      parts.every((p) => picked.some((x) => String(x.subLabel ?? '') === String(p.subLabel ?? '') && toNum(x.marks) != null && toNum(x.marks) >= 0)) &&
      near(round2(parts.reduce((s, p) => s + toNum(picked.find((x) => String(x.subLabel ?? '') === String(p.subLabel ?? '')).marks), 0)), target)
    if (valid) {
      parts.forEach((p) => {
        const x = picked.find((y) => String(y.subLabel ?? '') === String(p.subLabel ?? ''))
        setPart(p, toNum(x.marks), String(x.reason || 'Shared by weight').slice(0, 60))
      })
    } else {
      // No usable AI answer: the largest part takes the difference.
      const big = parts.reduce((best, p) => (p.maxMarks > best.maxMarks ? p : best), parts[0])
      setPart(big, Math.max(0, big.maxMarks + target - partsSum()), 'Largest part')
    }
    parts.forEach((p) => setPoints(p, 'Matches the part mark'))
  }

  return { questions: out, changes, warnings: checkGuideTotals(out) }
}

// Which questions count on one script under the answer rule. scores: Map
// of question number to that script's score for the question. The
// compulsory questions always count; of the rest, the `any` highest count
// (ties go to the lower question number). Students who answer extra
// questions are marked on all of them and the best ones count. With no
// rule, every question counts.
export function countedNumbers(scores, rule) {
  const numbers = [...scores.keys()]
  const clean = cleanAnswerRule(rule)
  if (!clean) return new Set(numbers)
  const others = numbers
    .filter((n) => !clean.compulsory.includes(n))
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, clean.any)
  return new Set([...numbers.filter((n) => clean.compulsory.includes(n)), ...others])
}

// A script's score: the questions that count, each the sum of its parts.
// answers: [{ score, number }].
export function ruleScore(answers, rule) {
  const scores = new Map()
  for (const a of answers || []) {
    const key = String(a.number ?? '').trim()
    scores.set(key, (scores.get(key) || 0) + (Number(a.score) || 0))
  }
  const counted = countedNumbers(scores, rule)
  return round2([...counted].reduce((sum, n) => sum + scores.get(n), 0))
}
