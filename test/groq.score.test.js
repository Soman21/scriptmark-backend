// Tests for scoreScriptAgainstGuide's retry and validation, using a fake
// fetch so no real Groq requests are made. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { scoreScriptAgainstGuide, validateScoreResults, AI_DAILY_LIMIT } from '../src/lib/groq.js'

const questions = [
  { id: 'q1', number: '1', subLabel: null, text: 'Define OCR', modelAnswer: 'Optical character recognition', keywords: 'OCR', maxMarks: 10 },
  {
    id: 'q2',
    number: '2',
    subLabel: null,
    text: 'Solve 2x + 4 = 10',
    modelAnswer: 'x = 3',
    keywords: 'x = 3',
    maxMarks: 5,
    steps: [
      { description: 'Subtract 4', marks: 2 },
      { description: 'Divide by 2', marks: 3 },
    ],
  },
]

const good = [
  { questionId: 'q1', suggestedScore: 8, answerText: 'OCR reads text', confidence: 'high', reasoning: 'Mostly right' },
  {
    questionId: 'q2',
    suggestedScore: 5,
    answerText: '2x = 6, x = 3',
    confidence: 'high',
    reasoning: 'Correct',
    stepBreakdown: [
      { description: 'Subtract 4', marks: 2, awarded: 2, reasoning: 'ok' },
      { description: 'Divide by 2', marks: 3, awarded: 3, reasoning: 'ok' },
    ],
  },
]

// Each queued item is either a results array (sent as a 200 JSON reply),
// a raw string (sent as the model's content, to fake malformed JSON), or
// { status, headers } for an HTTP error.
let queue
let calls
const realFetch = globalThis.fetch
const noSleep = { sleep: async (ms) => { sleeps.push(ms) } }
let sleeps

function reply(item) {
  if (item && item.status) {
    return {
      ok: false,
      status: item.status,
      headers: new Headers(item.headers || {}),
      text: async () => item.body || 'fake error body',
    }
  }
  const content = typeof item === 'string' ? item : JSON.stringify({ results: item })
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

beforeEach(() => {
  queue = []
  calls = 0
  sleeps = []
  globalThis.fetch = async () => {
    calls++
    if (queue.length === 0) throw new Error('fake fetch called more times than expected')
    return reply(queue.shift())
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('clean reply is returned after a single call', async () => {
  queue.push(good)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 1)
  assert.deepEqual(results.map((r) => r.suggestedScore), [8, 5])
  assert.deepEqual(results.map((r) => r.confidence), ['high', 'high'])
})

test('retries on 429 using Retry-After, then succeeds', async () => {
  queue.push({ status: 429, headers: { 'retry-after': '7' } }, good)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [7000])
  assert.equal(results[0].suggestedScore, 8)
})

test('retries on 503 with backoff, then succeeds', async () => {
  queue.push({ status: 503 }, { status: 503 }, good)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [1000, 2000])
  assert.equal(results.length, 2)
})

test('stops at once when the daily allowance is used up, with a code the queue can pause on', async () => {
  const body = 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199655'
  queue.push({ status: 429, headers: { 'retry-after': '71' }, body }, good)
  await assert.rejects(scoreScriptAgainstGuide('text', questions, noSleep), (err) => err.code === AI_DAILY_LIMIT)
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
})

test('a per minute 429 is still retried', async () => {
  queue.push({ status: 429, headers: { 'retry-after': '3' }, body: 'Rate limit reached on tokens per minute (TPM)' }, good)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 2)
  assert.equal(results.length, 2)
})

test('does not retry a 401 (bad key)', async () => {
  queue.push({ status: 401 }, good)
  await assert.rejects(scoreScriptAgainstGuide('text', questions, noSleep), /Groq API error \(401\)/)
  assert.equal(calls, 1)
})

test('throws after 3 rate limited attempts with nothing usable', async () => {
  queue.push({ status: 429 }, { status: 429 }, { status: 429 })
  await assert.rejects(scoreScriptAgainstGuide('text', questions, noSleep), /Groq API error \(429\)/)
  assert.equal(calls, 3)
})

test('retries malformed JSON, then succeeds', async () => {
  queue.push('{"results": [ this is not json', good)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 2)
  assert.equal(results[1].suggestedScore, 5)
})

test('retries an out of range score, and the retry is used when clean', async () => {
  const bad = [{ ...good[0], suggestedScore: 12 }, good[1]]
  queue.push(bad, good)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 2)
  assert.equal(results[0].suggestedScore, 8)
  assert.equal(results[0].confidence, 'high')
})

test('out of range on every attempt is capped and forced to low confidence', async () => {
  const bad = [{ ...good[0], suggestedScore: 12 }, good[1]]
  queue.push(bad, bad, bad)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(calls, 3)
  assert.equal(results[0].suggestedScore, 10)
  assert.equal(results[0].confidence, 'low')
  assert.match(results[0].reasoning, /outside 0 to 10/)
  // The clean question is left alone.
  assert.equal(results[1].confidence, 'high')
})

test('missing question gets a null score placeholder at low confidence', async () => {
  queue.push([good[0]], [good[0]], [good[0]])
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(results.length, 2)
  assert.equal(results[1].questionId, 'q2')
  assert.equal(results[1].suggestedScore, null)
  assert.equal(results[1].confidence, 'low')
})

test('keeps the attempt with the fewest problems', async () => {
  const twoBad = [{ ...good[0], suggestedScore: -3 }, { ...good[1], suggestedScore: 'lots' }]
  const oneBad = [{ ...good[0], suggestedScore: 11 }, good[1]]
  queue.push(twoBad, oneBad, twoBad)
  const results = await scoreScriptAgainstGuide('text', questions, noSleep)
  assert.equal(results[0].suggestedScore, 10)
  assert.equal(results[1].suggestedScore, 5)
  assert.equal(results[1].confidence, 'high')
})

test('validate: unknown and duplicate ids are dropped', () => {
  const { results, problems } = validateScoreResults(
    [good[0], { ...good[0], suggestedScore: 1 }, { ...good[0], questionId: 'made-up' }, good[1]],
    questions,
  )
  assert.deepEqual(results.map((r) => r.questionId), ['q1', 'q2'])
  assert.equal(results[0].suggestedScore, 8)
  assert.equal(problems.length, 2)
})

test('validate: numeric strings are accepted as numbers', () => {
  const { results, problems } = validateScoreResults([{ ...good[0], suggestedScore: '7.5' }, good[1]], questions)
  assert.equal(results[0].suggestedScore, 7.5)
  assert.equal(problems.length, 0)
})

test('validate: non numeric score becomes null and low confidence', () => {
  const { results } = validateScoreResults([{ ...good[0], suggestedScore: 'eight' }, good[1]], questions)
  assert.equal(results[0].suggestedScore, null)
  assert.equal(results[0].confidence, 'low')
})

test('validate: step awards are capped and the score follows the step total', () => {
  const r = {
    ...good[1],
    suggestedScore: 5,
    stepBreakdown: [
      { description: 'Subtract 4', marks: 2, awarded: 4, reasoning: '' },
      { description: 'Divide by 2', marks: 3, awarded: 1, reasoning: '' },
    ],
  }
  const { results } = validateScoreResults([good[0], r], questions)
  assert.deepEqual(results[1].stepBreakdown.map((s) => s.awarded), [2, 1])
  assert.equal(results[1].suggestedScore, 3)
  assert.equal(results[1].confidence, 'low')
})

test('validate: unrecognised confidence label becomes low', () => {
  const { results } = validateScoreResults([{ ...good[0], confidence: 'very sure' }, good[1]], questions)
  assert.equal(results[0].confidence, 'low')
})
