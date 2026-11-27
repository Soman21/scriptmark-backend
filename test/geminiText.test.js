import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseClassList, parseMarkingSchemeDocument } from '../src/lib/groq.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.GEMINI_API_KEY
})

const gemini = (text, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] })

function route({ geminiStatus = 200, geminiBody = gemini('{"students":[{"name":"A","regNumber":"1"}]}') } = {}) {
  const calls = []
  globalThis.fetch = async (url, req) => {
    const body = JSON.parse(req.body)
    if (String(url).includes('generativelanguage')) {
      calls.push({ to: 'gemini', body, headers: req.headers })
      return { ok: geminiStatus === 200, status: geminiStatus, headers: { get: () => null }, text: async () => 'down', json: async () => geminiBody }
    }
    calls.push({ to: 'groq', model: body.model, body })
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"students":[{"name":"B","regNumber":"2"}]}' } }] }) }
  }
  return calls
}

test('with a Gemini key, a class list is read by Gemini and the main Groq model is not used', async () => {
  process.env.GEMINI_API_KEY = 'k'
  const calls = route()
  const students = await parseClassList('some text')
  assert.deepEqual(students, [{ name: 'A', regNumber: '1' }])
  assert.deepEqual(calls.map((c) => c.to), ['gemini'])
  assert.equal(calls[0].headers['x-goog-api-key'], 'k')
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json')
  assert.ok(calls[0].body.systemInstruction.parts[0].text.length > 0)
  assert.equal(calls[0].body.contents[0].role, 'user')
})

test('when Gemini fails, the backup Groq model is used, never the main one', async () => {
  process.env.GEMINI_API_KEY = 'k'
  const calls = route({ geminiStatus: 503 })
  const students = await parseClassList('some text')
  assert.deepEqual(students, [{ name: 'B', regNumber: '2' }])
  assert.deepEqual(calls.map((c) => c.to), ['gemini', 'groq'])
  assert.equal(calls[1].model, 'openai/gpt-oss-20b')
})

test('without a Gemini key the main Groq model is used as before', async () => {
  const calls = route()
  await parseClassList('some text')
  assert.deepEqual(calls.map((c) => [c.to, c.model]), [['groq', 'openai/gpt-oss-120b']])
})

test('a Gemini reply cut off at its limit is reported as too long, like Groq', async () => {
  process.env.GEMINI_API_KEY = 'k'
  route({ geminiBody: gemini('{"questions":[', 'MAX_TOKENS') })
  await assert.rejects(parseMarkingSchemeDocument('Question 1\nno parts at all', { sleep: async () => {} }), /too long/)
})
