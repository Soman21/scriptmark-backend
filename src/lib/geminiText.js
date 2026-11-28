// Asks Gemini a text question and returns the answer shaped like a Groq chat
// reply, so the code that reads guides and class lists does not have to
// change how it reads the answer. Used for jobs that are not marking, so the
// free Groq allowance is kept for marking.

import { recordUsage } from './aiUsage.js'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_MODEL = 'gemini-3.5-flash'

export function geminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY)
}

// body: { messages: [{ role, content }], temperature, response_format }
// Returns { ok, status, json(), text() } like a fetch response.
export async function geminiChat(body, job = 'other') {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL
  const system = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const contents = body.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content) }] }))
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        temperature: body.temperature ?? 0.2,
        ...(body.response_format ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    recordUsage({ service: 'gemini', model, job, refused: true })
    return { ok: false, status: res.status, headers: res.headers, text: async () => errText }
  }
  const data = await res.json()
  recordUsage({ service: 'gemini', model, job, data })
  const candidate = data?.candidates?.[0]
  const content = (candidate?.content?.parts || []).map((p) => p.text || '').join('')
  const reply = {
    choices: [{ finish_reason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop', message: { content } }],
  }
  return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) }
}
