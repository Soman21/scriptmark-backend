// Why a script could not be marked, in a few words for the Marking page.
// Before this the page only said "Needs attention" and the real error went
// to the server log, where the lecturer cannot see it.
//
// Kept in memory, like the marking runs themselves: Render runs one server
// process. After a restart the reason is gone but the script stays FLAGGED,
// and pressing Mark again tries it once more and records a fresh reason.
export const markFailures = new Map() // scriptId -> { reason, detail, at }

export function failureReason(err) {
  const msg = String(err?.message || err || '')
  const status = Number(msg.match(/\((\d{3})\)/)?.[1])
  if (status === 413 || /request too large|reduce your message size/i.test(msg)) return 'Too long for AI plan limit'
  if (status === 401 || status === 403) return 'AI key rejected'
  if (status === 429) return 'AI rate limit reached'
  if (status >= 500) return 'AI service unavailable'
  if (/vision|ocr|annotate/i.test(msg)) return 'Page reading failed'
  if (/json|results/i.test(msg)) return 'AI reply unreadable'
  return 'Marking error'
}

export function recordFailure(scriptId, err) {
  markFailures.set(scriptId, { reason: failureReason(err), detail: String(err?.message || err).slice(0, 300), at: new Date() })
}
