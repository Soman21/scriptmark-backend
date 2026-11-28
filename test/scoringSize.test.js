// Tests that a marking request clearly over the minute limit is split
// before it is sent. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreScriptAgainstGuide, estimateInputTokens, resetScoringModel } from '../src/lib/groq.js'

const parts = ['1', '2', '3'].map((n) => ({ id: `q${n}`, number: n, subLabel: null, text: 'Explain', modelAnswer: 'y'.repeat(6000), keywords: '', maxMarks: 5 }))

test('a big request goes out in parts and is never refused', async () => {
  resetScoringModel()
  const real = globalThis.fetch
  const sizes = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const ids = [...body.messages[1].content.matchAll(/Question ID: (q\d)/g)].map((m) => m[1])
    sizes.push(ids.length)
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ results: ids.map((id) => ({ questionId: id, suggestedScore: 1, answerText: '', confidence: 'high', reasoning: 'ok' })) }) } }] }),
    }
  }
  try {
    const script = 'z'.repeat(14000)
    assert.ok(estimateInputTokens(script, parts) > 7200)
    const results = await scoreScriptAgainstGuide(script, parts)
    assert.deepEqual(results.map((r) => r.questionId), ['q1', 'q2', 'q3'])
    assert.ok(sizes.length >= 2, `sent ${sizes.length} requests`)
    assert.equal(sizes.reduce((a, b) => a + b, 0), 3)
  } finally {
    globalThis.fetch = real
  }
})
