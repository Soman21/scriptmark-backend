import { test } from 'node:test'
import assert from 'node:assert/strict'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])

async function run(reply, status = 200) {
  process.env.GEMINI_API_KEY = 'k'
  const calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return {
      ok: status === 200,
      status,
      text: async () => 'bad',
      json: async () => reply,
    }
  }
  const { extractTextFromImage } = await import('../src/lib/vision.js')
  return { calls, call: () => extractTextFromImage(png) }
}

const wrap = (obj) => ({ candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] })

test('joins lines and scales boxes', async () => {
  const { call, calls } = await run(wrap({ lines: [{ text: ' Q1 ', box_2d: [100, 50, 150, 900] }, { text: 'ans', box_2d: [200, 50, 250, 400] }] }))
  const r = await call()
  assert.equal(r.text, 'Q1\nans')
  assert.deepEqual(r.lines[0].box, { top: 0.1, left: 0.05, bottom: 0.15, right: 0.9 })
  assert.equal(r.confidence, 0.8)
  assert.match(calls[0].url, /generateContent/)
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'k')
})

test('empty page gives empty text and zero confidence', async () => {
  const { call } = await run(wrap({ lines: [] }))
  assert.deepEqual(await call(), { text: '', confidence: 0, lines: [] })
})

test('reads JSON wrapped in other text, drops bad boxes', async () => {
  const { call } = await run(wrap('here: {"lines":[{"text":"x","box_2d":[1,2]}]} done'))
  const r = await call()
  assert.equal(r.text, 'x')
  assert.equal(r.lines[0].box, null)
})

test('api error throws', async () => {
  const { call } = await run({}, 400)
  await assert.rejects(call, /Gemini 400/)
})

test('a busy reply waits and reads the page again', async () => {
  process.env.GEMINI_API_KEY = 'k'
  const replies = [
    { ok: false, status: 503, text: async () => 'overloaded' },
    { ok: false, status: 429, text: async () => '{"retryDelay": "3s"}' },
    { ok: true, status: 200, json: async () => wrap({ lines: [{ text: 'hi' }] }) },
  ]
  globalThis.fetch = async () => replies.shift()
  const waits = []
  const { extractTextFromImage } = await import('../src/lib/vision.js')
  const r = await extractTextFromImage(png, { sleep: async (ms) => waits.push(ms) })
  assert.equal(r.text, 'hi')
  assert.deepEqual(waits, [2000, 3500])
})

test('a daily limit pauses instead of retrying', async () => {
  process.env.GEMINI_API_KEY = 'k'
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: false, status: 429, text: async () => 'Quota exceeded: GenerateRequestsPerDayPerProjectPerModel' }
  }
  const { extractTextFromImage } = await import('../src/lib/vision.js')
  await assert.rejects(extractTextFromImage(png, { sleep: async () => {} }), (err) => err.code === 'AI_DAILY_LIMIT')
  assert.equal(calls, 1)
})
