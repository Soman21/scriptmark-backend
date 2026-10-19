import prisma from './prisma.js'
import { computeGrade } from './grading.js'

// Cohort level analytics: how a class did as a whole, broken down by the
// groups a reg number reveals (entry year, undergraduate or postgraduate),
// how well each question separated strong from weak students, and how
// sessions compare with each other. Totals follow the result sheet: exam
// score plus CA, graded on the institution scale, pass at 40 (grade E).

const PASS_MARK = 40
const GRADES = ['A', 'B', 'C', 'D', 'E', 'F']

function round(x, dp = 1) {
  if (x == null || !Number.isFinite(x)) return null
  const f = 10 ** dp
  return Math.round(x * f) / f
}

export function describeScores(values) {
  const n = values.length
  if (n === 0) return { n: 0, mean: null, median: null, sd: null, min: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / n
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  // Sample standard deviation (n - 1), as SPSS and Excel's STDEV report it.
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : null
  return { n, mean: round(mean), median: round(median), sd: round(sd), min: sorted[0], max: sorted[n - 1] }
}

// The first four digits of a UNIZIK reg number are the entry year; letters
// at the end (like FN) mark a postgraduate number.
export function regNumberGroups(regNumber) {
  const compact = String(regNumber || '').replace(/\s+/g, '').toUpperCase()
  const m = compact.match(/^((?:19|20)\d{2})\/?\d+([A-Z]*)$/)
  if (!m) return { entryYear: null, programme: null }
  return { entryYear: m[1], programme: m[2] ? 'Postgraduate' : 'Undergraduate' }
}

function finalTotal(script) {
  return script.totalScore + (script.caScore ?? 0)
}

function groupSummary(label, scripts) {
  const totals = scripts.map(finalTotal)
  return {
    group: label,
    n: scripts.length,
    mean: describeScores(totals).mean,
    passRate: scripts.length ? round(totals.filter((t) => t >= PASS_MARK).length / scripts.length, 3) : null,
  }
}

function groupBy(scripts, keyFn, order) {
  const map = new Map()
  for (const s of scripts) {
    const key = keyFn(s) ?? 'Unknown'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(s)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (order ? order(a, b) : String(a).localeCompare(String(b))))
    .map(([key, list]) => groupSummary(key, list))
}

// Classic item analysis. Facility is the average share of the marks the
// class earned on a question. Discrimination is the gap in that share
// between the top and bottom 27% of students by exam score; below 0.2 the
// question barely tells strong and weak students apart and is worth a look.
export function itemAnalysis(scripts) {
  const ranked = [...scripts].sort((a, b) => b.totalScore - a.totalScore)
  const k = Math.round(ranked.length * 0.27)
  const enough = k >= 2
  const upper = new Set(ranked.slice(0, k).map((s) => s.id))
  const lower = new Set(ranked.slice(-k).map((s) => s.id))

  const questions = new Map()
  for (const s of scripts) {
    for (const a of s.answers || []) {
      const q = a.question
      const score = a.confirmedScore ?? a.suggestedScore
      if (!q || !q.maxMarks || score == null) continue
      if (!questions.has(q.id)) questions.set(q.id, { q, all: [], upper: [], lower: [] })
      const entry = questions.get(q.id)
      const share = score / q.maxMarks
      entry.all.push(share)
      if (upper.has(s.id)) entry.upper.push(share)
      if (lower.has(s.id)) entry.lower.push(share)
    }
  }

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  return [...questions.values()]
    .sort((x, y) => String(x.q.number).localeCompare(String(y.q.number), undefined, { numeric: true }) || String(x.q.subLabel || '').localeCompare(String(y.q.subLabel || '')))
    .map(({ q, all, upper: up, lower: low }) => {
      const discrimination = enough && up.length && low.length ? round(avg(up) - avg(low), 2) : null
      return {
        question: `Q${q.number}${q.subLabel || ''}`,
        text: q.text,
        maxMarks: q.maxMarks,
        responses: all.length,
        facility: round(avg(all), 2),
        discrimination,
        needsReview: discrimination != null && discrimination < 0.2,
      }
    })
}

export function buildCohortReport(scripts) {
  const scored = scripts.filter((s) => s.totalScore != null)
  const totals = scored.map(finalTotal)
  const gradeCounts = Object.fromEntries(GRADES.map((g) => [g, 0]))
  for (const t of totals) gradeCounts[computeGrade(t)]++

  return {
    scoredScripts: scored.length,
    totalScripts: scripts.length,
    summary: {
      ...describeScores(totals),
      passRate: scored.length ? round(totals.filter((t) => t >= PASS_MARK).length / scored.length, 3) : null,
    },
    gradeDistribution: GRADES.map((grade) => ({ grade, count: gradeCounts[grade] })),
    byEntryYear: groupBy(scored, (s) => regNumberGroups(s.regNumber).entryYear),
    byProgramme: groupBy(scored, (s) => regNumberGroups(s.regNumber).programme),
    items: itemAnalysis(scored),
  }
}

// One row per session, for comparing a lecturer's courses side by side.
export function compareSessions(sessions) {
  return sessions.map((session) => {
    const scored = (session.scripts || []).filter((s) => s.totalScore != null)
    const totals = scored.map(finalTotal)
    return {
      id: session.id,
      title: session.title,
      courseCode: session.courseCode,
      academicSession: session.academicSession,
      semester: session.semester,
      scoredScripts: scored.length,
      mean: describeScores(totals).mean,
      sd: describeScores(totals).sd,
      passRate: scored.length ? round(totals.filter((t) => t >= PASS_MARK).length / scored.length, 3) : null,
    }
  })
}

export async function loadCohortReport(sessionId) {
  const scripts = await prisma.script.findMany({
    where: { sessionId },
    include: { answers: { include: { question: true } } },
  })
  return buildCohortReport(scripts)
}

export async function loadSessionComparison(where) {
  const sessions = await prisma.markingSession.findMany({
    where,
    select: {
      id: true,
      title: true,
      courseCode: true,
      academicSession: true,
      semester: true,
      createdAt: true,
      scripts: { select: { totalScore: true, caScore: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return compareSessions(sessions)
}
