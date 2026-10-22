// Helpers for the visitor and click analytics on the Admin page. Nothing
// here identifies a person: paths lose their ids and labels lose numbers,
// so a reg number or a session id never lands in the table.

export const EVENT_TYPES = ['PAGE_VIEW', 'CLICK']
export const DEVICES = ['mobile', 'tablet', 'desktop']

const looksLikeId = (seg) => /^c[a-z0-9]{15,}$/i.test(seg) || (/\d/.test(seg) && seg.length >= 6)

export function normalizePath(path) {
  const clean = String(path || '/').split(/[?#]/)[0].slice(0, 200)
  const parts = clean.split('/').filter(Boolean)
  const out = parts.map((seg, i) => {
    if (i === 1 && (parts[0] === 'join' || parts[0] === 'courses')) return ':code'
    if (i === 1 && parts[0] === 'sessions') return ':id'
    return looksLikeId(seg) ? ':id' : seg
  })
  return '/' + out.join('/')
}

export function cleanLabel(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim()
  if (!text || /\d/.test(text)) return null
  return text.slice(0, 60)
}

// Only the site's host name is kept from where a visitor came from.
export function referrerHost(referrer, ownHost) {
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '')
    return host && host !== ownHost ? host : null
  } catch {
    return null
  }
}

// Days in the range as YYYY-MM-DD, oldest first, so days with no visits
// still show as zero on the chart.
export function dayRange(days, now = new Date()) {
  const out = []
  // Lagos is UTC+1 all year.
  const local = new Date(now.getTime() + 60 * 60 * 1000)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(local)
    d.setUTCDate(d.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}
