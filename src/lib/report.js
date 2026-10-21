// The examiner's report the AI Assistant drafts for one session. Every
// number in it is computed here from the same analytics and evaluation the
// app shows; the model only writes the short prose around those numbers.

export const REPORT_PROMPT = `You write a short examiner's report for a university lecturer about one marked exam.
You are given the facts: score spread, per question averages, and the marking reasons for weaker answers.
Use only these facts. Never invent numbers, names or questions. Do not name any student.
Write plain, formal British English in short sentences. Do not use hyphens or dashes of any kind.
Return JSON only: {"overview": "one paragraph of 3 to 5 sentences on how the class did overall",
"questions": [{"question": "Q1a", "comment": "one or two sentences on how students did and what they commonly missed"}],
"recommendations": ["two or three short suggestions for teaching or the next exam"]}.
Comment only on questions listed in the facts, and only where there is something useful to say.`

const pct = (n) => (n == null ? null : Math.round(n * 100))

function questionLabel(q) {
  return `Q${q.number}${q.subLabel || ''}`
}

export function buildReportFacts(session, analytics, evaluation) {
  const perQuestion = (analytics.perQuestion || [])
    .filter((q) => q.responseCount > 0)
    .map((q) => ({ question: questionLabel(q), text: q.text, maxMarks: q.maxMarks, averagePercent: q.averagePercent, responses: q.responseCount }))
  const ranked = [...perQuestion].filter((q) => q.averagePercent != null).sort((a, b) => a.averagePercent - b.averagePercent)
  // Weakest: under 60 percent, up to three, or just the lowest when the
  // class did well everywhere. Best: the top two that are not weakest.
  const weak = ranked.filter((q) => q.averagePercent < 60).slice(0, 3)
  const hardest = (weak.length ? weak : ranked.slice(0, 1)).map((q) => q.question)
  const easiest = [...ranked].reverse().filter((q) => !hardest.includes(q.question)).slice(0, 2).map((q) => q.question)
  const title = session.courseCode && !String(session.title || '').startsWith(session.courseCode) ? `${session.courseCode} ${session.title}` : session.title

  const human = evaluation?.overall || {}
  return {
    title,
    examinationType: session.examinationType || null,
    academicSession: session.academicSession || null,
    semester: session.semester || null,
    scripts: analytics.totalScripts,
    scored: analytics.scoredCount,
    average: analytics.average,
    highest: analytics.highest,
    maxTotal: perQuestion.reduce((sum, q) => sum + (q.maxMarks || 0), 0) || null,
    distribution: analytics.distribution,
    perQuestion,
    hardest,
    easiest,
    marking: {
      humanConfirmed: evaluation?.humanConfirmed ?? 0,
      autoAccepted: evaluation?.autoAcceptedExcluded ?? 0,
      exactAgreement: pct(human.exactAgreement),
      withinOneMark: pct(human.withinOneMark),
      changedAfterConfirm: evaluation?.overriddenAfterConfirm ?? 0,
    },
  }
}

// Reasons the marker gave for answers under half marks on the hardest
// questions: the raw material for "what students commonly missed".
export function weakAnswerReasons(answers, hardest, perQuestionLimit = 8) {
  const out = {}
  for (const a of answers) {
    if (!a.question || !a.reasoning) continue
    const label = questionLabel(a.question)
    if (!hardest.includes(label)) continue
    const score = a.confirmedScore ?? a.suggestedScore
    if (score == null || score >= a.question.maxMarks / 2) continue
    out[label] = out[label] || []
    if (out[label].length < perQuestionLimit) out[label].push(a.reasoning.slice(0, 300))
  }
  return out
}

export function reportContext(facts, reasons) {
  const lines = [
    `Exam: ${facts.title}${facts.examinationType ? ', ' + facts.examinationType : ''}.`,
    `Scripts: ${facts.scripts}, scored: ${facts.scored}. Average total: ${facts.average ?? 'none'}. Highest: ${facts.highest ?? 'none'}.`,
    `Score bands (percent of total): ${facts.distribution.map((d) => `${d.range}: ${d.value}`).join(', ')}.`,
    'Per question:',
    ...facts.perQuestion.map((q) => `${q.question} (${q.maxMarks} marks): average ${q.averagePercent} percent over ${q.responses} answers. ${String(q.text || '').slice(0, 160)}`),
    `Hardest: ${facts.hardest.join(', ') || 'none'}. Easiest: ${facts.easiest.join(', ') || 'none'}.`,
  ]
  for (const [q, list] of Object.entries(reasons)) {
    lines.push(`Marking reasons for weaker answers on ${q}:`, ...list.map((r) => `• ${r}`))
  }
  return lines.join('\n')
}

function clean(text) {
  return String(text || '')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\*\*/g, '')
    .trim()
}

// Keeps only comments on questions that are really in the facts, and
// strips dashes the model slips in.
export function cleanReport(raw, facts) {
  const known = new Set(facts.perQuestion.map((q) => q.question))
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .map((q) => ({ question: String(q?.question || '').trim().replace(/^question\s*/i, 'Q').replace(/^(?!Q)/, 'Q'), comment: clean(q?.comment) }))
    .filter((q) => known.has(q.question) && q.comment)
  const recommendations = (Array.isArray(raw?.recommendations) ? raw.recommendations : []).map(clean).filter(Boolean).slice(0, 4)
  return { overview: clean(raw?.overview), questions, recommendations }
}
