// Counts every AI call and the tokens it used, from the service's own
// numbers (Groq and Cloudflare send "usage", Gemini sends "usageMetadata").
// Two views:
//  - per script: markScript runs inside trackUsage, so every call made while
//    marking one script, wherever in the code it happens, is added to that
//    script's tally, and one log line sums it up at the end;
//  - per day: totals for today since the server started, for the Admin API.
// Held in memory only, like the marking queue. Nothing here changes what is
// sent to the AI; it only records it, for the thesis (Chapter 4) and to see
// how close a day is to the free limits.
import { AsyncLocalStorage } from 'node:async_hooks'

const current = new AsyncLocalStorage()
let today = { date: dateKey(), rows: new Map() }

function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function emptyRow(service, model, job) {
  return { service, model, job, calls: 0, refused: 0, input: 0, output: 0 }
}

function add(rows, entry) {
  const key = `${entry.service}|${entry.model}|${entry.job}`
  if (!rows.has(key)) rows.set(key, emptyRow(entry.service, entry.model, entry.job))
  const row = rows.get(key)
  row.calls++
  if (entry.refused) row.refused++
  row.input += entry.input
  row.output += entry.output
}

// The token counts in a reply body, whichever service sent it.
export function tokensFrom(data) {
  const u = data?.usage
  if (u) return { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 }
  const g = data?.usageMetadata
  if (g) {
    return {
      input: Number(g.promptTokenCount) || 0,
      // Gemini counts its thinking apart from the answer; both use the allowance.
      output: (Number(g.candidatesTokenCount) || 0) + (Number(g.thoughtsTokenCount) || 0),
    }
  }
  return { input: 0, output: 0 }
}

// One call. data is the parsed reply body (or null when the call was
// refused, for example 413 too large or 429 busy).
export function recordUsage({ service, model, job, data = null, refused = false }) {
  const { input, output } = tokensFrom(data)
  const entry = { service, model: model || '', job, input, output, refused }
  if (today.date !== dateKey()) today = { date: dateKey(), rows: new Map() }
  add(today.rows, entry)
  const tally = current.getStore()
  if (tally) add(tally, entry)
}

// Runs fn with its own tally. Returns { result, usage } where usage is the
// list of rows for every call made inside fn. If fn throws, the error is
// passed on with the usage attached as err.aiUsage.
export async function trackUsage(fn) {
  const tally = new Map()
  try {
    const result = await current.run(tally, fn)
    return { result, usage: [...tally.values()] }
  } catch (err) {
    if (err && typeof err === 'object') err.aiUsage = [...tally.values()]
    throw err
  }
}

export function usageToday() {
  return { date: today.date, rows: [...today.rows.values()] }
}

// "groq openai/gpt-oss-120b marking: 3 calls (1 refused), 21,400 in, 3,100 out; ..."
export function usageSummary(rows) {
  if (!rows?.length) return 'no AI calls'
  const n = (x) => x.toLocaleString('en-GB')
  const totalIn = rows.reduce((s, r) => s + r.input, 0)
  const totalOut = rows.reduce((s, r) => s + r.output, 0)
  const calls = rows.reduce((s, r) => s + r.calls, 0)
  const parts = rows.map(
    (r) => `${r.service} ${r.model} ${r.job}: ${r.calls} call${r.calls === 1 ? '' : 's'}${r.refused ? ` (${r.refused} refused)` : ''}, ${n(r.input)} in, ${n(r.output)} out`
  )
  return `${calls} calls, ${n(totalIn)} in, ${n(totalOut)} out. ${parts.join('; ')}`
}

// Only for tests.
export function resetUsage() {
  today = { date: dateKey(), rows: new Map() }
}
