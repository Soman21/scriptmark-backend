import prisma from './prisma.js'

// Real cohort-level stats for a session, computed from actual
// confirmed/suggested scores. Extracted out of the analytics route so the
// AI assistant's get_analytics tool computes the exact same numbers a
// lecturer would see on the Analytics page, rather than a second,
// potentially-drifting copy of the same logic.
export async function computeSessionAnalytics(sessionId) {
  const scripts = await prisma.script.findMany({
    where: { sessionId },
    include: { answers: { include: { question: true } } },
  })

  const scored = scripts.filter((s) => s.totalScore != null)
  const totalScripts = scripts.length
  const flaggedCount = scripts.filter((s) => s.status === 'FLAGGED').length
  const lowConfidenceCount = scripts.filter((s) => s.hasLowConfidenceScore).length

  const average = scored.length ? scored.reduce((sum, s) => sum + s.totalScore, 0) / scored.length : null
  const highest = scored.length ? Math.max(...scored.map((s) => s.totalScore)) : null

  const buckets = [0, 0, 0, 0, 0]
  scored.forEach((s) => {
    const maxPossible = s.answers.reduce((sum, a) => sum + (a.question?.maxMarks || 0), 0)
    if (!maxPossible) return
    const pct = (s.totalScore / maxPossible) * 100
    const bucketIndex = Math.min(4, Math.floor(pct / 20))
    buckets[bucketIndex]++
  })

  const questionStats = {}
  scripts.forEach((s) => {
    s.answers.forEach((a) => {
      if (!a.question) return
      const key = a.question.id
      if (!questionStats[key]) {
        questionStats[key] = {
          number: a.question.number,
          subLabel: a.question.subLabel,
          text: a.question.text,
          maxMarks: a.question.maxMarks,
          scores: [],
        }
      }
      const score = a.confirmedScore ?? a.suggestedScore
      if (score != null) questionStats[key].scores.push(score)
    })
  })
  const perQuestion = Object.values(questionStats).map((q) => ({
    number: q.number,
    subLabel: q.subLabel,
    text: q.text,
    maxMarks: q.maxMarks,
    averagePercent: q.scores.length
      ? Math.round((q.scores.reduce((a, b) => a + b, 0) / q.scores.length / q.maxMarks) * 100)
      : null,
    responseCount: q.scores.length,
  }))

  return {
    totalScripts,
    scoredCount: scored.length,
    flaggedCount,
    lowConfidenceCount,
    average: average != null ? Math.round(average * 10) / 10 : null,
    highest,
    distribution: [
      { range: '0-20', value: buckets[0] },
      { range: '21-40', value: buckets[1] },
      { range: '41-60', value: buckets[2] },
      { range: '61-80', value: buckets[3] },
      { range: '81-100', value: buckets[4] },
    ],
    perQuestion,
  }
}
