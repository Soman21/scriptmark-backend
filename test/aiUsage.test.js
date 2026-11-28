// Tests for the AI usage counter. Run with: npm test
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { recordUsage, trackUsage, usageToday, usageSummary, tokensFrom, resetUsage } from '../src/lib/aiUsage.js'
import { scoreScriptAgainstGuide, resetScoringModel } from '../src/lib/groq.js'

beforeEach(() => resetUsage())

test('reads token counts from Groq and Gemini replies', () => {
  assert.deepEqual(tokensFrom({ usage: { prompt_tokens: 100, completion_tokens: 20 } }), { input: 100, output: 20 })
  assert.deepEqual(tokensFrom({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, thoughtsTokenCount: 7 } }), { input: 50, output: 12 })
  assert.deepEqual(tokensFrom(null), { input: 0, output: 0 })
})

test('counts calls per script inside trackUsage and per day', async () => {
  recordUsage({ service: 'gemini', model: 'g', job: 'page reading', data: { usageMetadata: { promptTokenCount: 10 } } })
  const { result, usage } = await trackUsage(async () => {
    recordUsage({ service: 'groq', model: 'm', job: 'marking', refused: true })
    await new Promise((r) => setTimeout(r, 1))
    recordUsage({ service: 'groq', model: 'm', job: 'marking', data: { usage: { prompt_tokens: 900, completion_tokens: 100 } } })
    return 'done'
  })
  assert.equal(result, 'done')
  assert.deepEqual(usage, [{ service: 'groq', model: 'm', job: 'marking', calls: 2, refused: 1, input: 900, output: 100 }])
  assert.equal(usageToday().rows.length, 2)
  assert.match(usageSummary(usage), /^2 calls, 900 in, 100 out\. groq m marking: 2 calls \(1 refused\)/)
})

test('a marking request is counted with the tokens Groq reports', async () => {
  resetScoringModel()
  const real = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      usage: { prompt_tokens: 1234, completion_tokens: 56 },
      choices: [{ message: { content: JSON.stringify({ results: [{ questionId: 'q1', suggestedScore: 1, answerText: '', confidence: 'high', reasoning: 'ok' }] }) } }],
    }),
  })
  try {
    const { usage } = await trackUsage(() =>
      scoreScriptAgainstGuide('text', [{ id: 'q1', number: '1', text: 'Q', modelAnswer: 'A', keywords: '', maxMarks: 2 }])
    )
    assert.equal(usage.length, 1)
    assert.equal(usage[0].job, 'marking')
    assert.equal(usage[0].input, 1234)
    assert.equal(usage[0].output, 56)
  } finally {
    globalThis.fetch = real
  }
})
