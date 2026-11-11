// The assistants run on Cloudflare Workers AI when it is set up, and fall
// back to Groq's backup model. Uses a fake fetch. Run with: npm test
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { assistantChat, reviewScriptChat } from '../src/lib/groq.js'

const realFetch = globalThis.fetch
let sent

function ok(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) }
}

beforeEach(() => {
  sent = []
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_API_TOKEN = 'token'
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  delete process.env.CLOUDFLARE_API_TOKEN
})

test('assistant questions go to Cloudflare when it is set up', async () => {
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) })
    return ok('Hello')
  }
  const message = await assistantChat({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(message.content, 'Hello')
  assert.equal(message.servedBy, 'cloudflare')
  assert.equal(sent.length, 1)
  assert.match(sent[0].url, /api\.cloudflare\.com\/client\/v4\/accounts\/acct\/ai\/v1\/chat\/completions/)
  assert.equal(sent[0].body.model, '@cf/openai/gpt-oss-120b')
  // Cloudflare's default of 256 tokens is used up by the model's thinking.
  assert.equal(sent[0].body.max_tokens, 4096)
})

test('Cloudflare allowance used up: the question goes to the Groq backup model', async () => {
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) })
    if (url.includes('cloudflare')) return { ok: false, status: 429, text: async () => 'daily free allocation used' }
    return ok('From Groq')
  }
  const message = await assistantChat({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(message.servedBy, 'groq')
  assert.match(sent[1].url, /api\.groq\.com/)
  assert.equal(sent[1].body.model, 'openai/gpt-oss-20b')
})

test('without Cloudflare set up, assistants use the Groq backup model, not the marking model', async () => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID
  globalThis.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) })
    return ok('From Groq')
  }
  await assistantChat({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.model, 'openai/gpt-oss-20b')
})

test('the marking assistant reads its JSON reply even with text around it', async () => {
  globalThis.fetch = async () => ok('Sure: {"reply":"Looks right","proposal":null}')
  const out = await reviewScriptChat('context', [{ role: 'user', content: 'check q1' }])
  assert.deepEqual(out, { reply: 'Looks right', proposal: null })
})
