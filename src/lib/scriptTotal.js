import prisma from './prisma.js'
import { ruleScore } from './guideTotals.js'

// A script's total, the number shown on Results and used by Analytics:
// each answer's confirmed score (or the AI's suggestion while unconfirmed),
// counting only the questions the guide's answer rule allows ("Question 1
// and any three others": the best three of the rest).
export async function scriptTotal(scriptId) {
  const script = await prisma.script.findUnique({
    where: { id: scriptId },
    select: {
      answers: { select: { confirmedScore: true, suggestedScore: true, question: { select: { number: true } } } },
      session: { select: { guide: { select: { answerRule: true } } } },
    },
  })
  if (!script) return 0
  return ruleScore(
    script.answers.map((a) => ({ number: a.question?.number, score: a.confirmedScore ?? a.suggestedScore ?? 0 })),
    script.session?.guide?.answerRule || null
  )
}
