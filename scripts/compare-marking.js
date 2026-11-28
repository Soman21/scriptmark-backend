// Compares the two trial ways of saving AI tokens on scripts that are
// already marked, WITHOUT saving anything. Run it yourself, locally, from
// the backend folder (it needs DATABASE_URL and GROQ_API_KEY in .env):
//
//   node scripts/compare-marking.js <sessionId> [scripts] [modes]
//
//   sessionId  the id in the app's address bar on the session's pages
//   scripts    how many marked scripts to try (default 1)
//   modes      comma list from: base, low, section, both (default low,section)
//                base     today's way, marked again
//                low      the AI thinks less (reasoning effort low)
//                section  each request carries only its questions' sections
//                both     low and section together
//
// For every part it prints the lecturer's confirmed score, the AI score
// already saved, and the score from each mode, then the tokens each mode
// used and how far its scores are from the lecturer's (or, when the
// lecturer has not confirmed yet, from the saved AI score). It also writes
// the same rows to compare-marking-<date>.csv in this folder.
//
// Each mode marks the scripts again, so it uses the free Groq allowance:
// about 25K to 45K tokens a script a mode. One script with two modes is a
// good first try. Nothing in the database is changed.

import 'dotenv/config'
import fs from 'fs'
import prisma from '../src/lib/prisma.js'
import { scoreScriptAgainstGuide } from '../src/lib/groq.js'
import { trimForMarking } from '../src/lib/trimScriptText.js'
import { trackUsage } from '../src/lib/aiUsage.js'
import { capUnlabelledDrawing, bestTotal } from '../src/lib/markingPoints.js'

const MODES = {
  base: {},
  low: { reasoningEffort: 'low' },
  section: { bySection: true },
  both: { reasoningEffort: 'low', bySection: true },
}

const [sessionId, countArg, modesArg] = process.argv.slice(2)
if (!sessionId) {
  console.error('Usage: node scripts/compare-marking.js <sessionId> [scripts] [modes]')
  process.exit(1)
}
const modes = (modesArg || 'low,section').split(',').map((m) => m.trim()).filter((m) => MODES[m])
const count = Number(countArg) || 1

const label = (q) => `${q.number}${q.subLabel || ''}`
const fmt = (n) => (n === null || n === undefined ? '' : String(Math.round(n * 100) / 100))

async function main() {
  const session = await prisma.markingSession.findUnique({ where: { id: sessionId } })
  if (!session?.guideId) throw new Error('Session not found, or it has no marking guide.')
  const questions = await prisma.question.findMany({ where: { guideId: session.guideId } })
  questions.sort((a, b) => Number(a.number) - Number(b.number) || String(a.subLabel || '').localeCompare(String(b.subLabel || '')))
  const scripts = await prisma.script.findMany({
    where: { sessionId, ocrText: { not: null }, answers: { some: {} } },
    include: { answers: true },
    orderBy: { uploadedAt: 'asc' },
    take: count,
  })
  if (scripts.length === 0) throw new Error('No marked scripts in this session yet.')

  const rows = [['script', 'part', 'max', 'lecturer', 'saved AI', ...modes]]
  const totals = Object.fromEntries(modes.map((m) => [m, { input: 0, output: 0, calls: 0, diff: 0, n: 0 }]))

  for (const script of scripts) {
    const name = script.regNumber || script.studentName || script.id
    console.log(`\nScript ${name}`)
    const answers = new Map(script.answers.map((a) => [a.questionId, a]))
    const extras = {}
    for (const q of questions) {
      const a = answers.get(q.id)
      const working = q.isCalculationHeavy && a?.visionTranscript
      if (working || a?.diagramDescription) extras[q.id] = { working: working || null, diagram: a?.diagramDescription || null }
    }
    const byMode = {}
    for (const mode of modes) {
      process.stdout.write(`  marking with ${mode}... `)
      const { result, usage } = await trackUsage(() =>
        scoreScriptAgainstGuide(trimForMarking(script.ocrText), questions, { ...MODES[mode], extras })
      )
      const t = totals[mode]
      for (const u of usage) {
        t.input += u.input
        t.output += u.output
        t.calls += u.calls
      }
      byMode[mode] = new Map(
        result.map((r) => {
          const a = answers.get(r.questionId)
          const q = questions.find((x) => x.id === r.questionId)
          // The same label rule marking applies to a drawing with no labels.
          if (a?.diagramDescription?.startsWith('No labels.') && r.stepBreakdown) {
            const { breakdown, changed } = capUnlabelledDrawing(r.stepBreakdown, false)
            if (changed) return [r.questionId, bestTotal(breakdown.map((p) => p.awarded), q?.countBest)]
          }
          return [r.questionId, r.suggestedScore]
        })
      )
      console.log(`${usage.reduce((n, u) => n + u.input + u.output, 0).toLocaleString('en-GB')} tokens`)
    }
    for (const q of questions) {
      const a = answers.get(q.id)
      const truth = a?.confirmedAt && !a.autoAccepted ? a.confirmedScore : a?.suggestedScore
      const row = [name, label(q), q.maxMarks, fmt(a?.confirmedAt && !a.autoAccepted ? a.confirmedScore : null), fmt(a?.suggestedScore)]
      for (const mode of modes) {
        const s = byMode[mode].get(q.id)
        row.push(fmt(s))
        if (typeof truth === 'number' && typeof s === 'number') {
          totals[mode].diff += Math.abs(s - truth)
          totals[mode].n++
        }
      }
      rows.push(row)
    }
  }

  console.log('')
  console.table(rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))))
  console.log('\nSummary (difference is from the lecturer\'s score, or the saved AI score where not confirmed):')
  for (const mode of modes) {
    const t = totals[mode]
    console.log(
      `  ${mode.padEnd(8)} ${t.calls} calls, ${t.input.toLocaleString('en-GB')} in, ${t.output.toLocaleString('en-GB')} out, ` +
        `average difference ${t.n ? (t.diff / t.n).toFixed(2) : '?'} marks a part`
    )
  }
  const file = `compare-marking-${new Date().toISOString().slice(0, 10)}.csv`
  fs.writeFileSync(file, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'))
  console.log(`\nSaved ${file}`)
}

main()
  .catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
