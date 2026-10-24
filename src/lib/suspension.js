// Suspended accounts, kept in memory like Admin grants (lib/roles.js) so
// every request can be refused without a database query. Loaded at start
// up, changed at once by the Admin page, and refreshed once a minute.
let suspendedIds = new Set()

export async function loadSuspended(prisma) {
  try {
    const rows = await prisma.user.findMany({ where: { suspendedAt: { not: null } }, select: { id: true } })
    suspendedIds = new Set(rows.map((r) => r.id))
  } catch (err) {
    console.error('Loading suspended accounts failed:', err)
  }
}

export const isSuspended = (userId) => !!userId && suspendedIds.has(userId)

export function setSuspended(userId, suspended) {
  if (suspended) suspendedIds.add(userId)
  else suspendedIds.delete(userId)
}

export const SUSPENDED_MESSAGE = 'This account has been suspended. Contact the ScriptMark admin.'

// Last active: written at most once every 5 minutes per account, and never
// waited on, so it costs nothing on a normal request.
const lastTouched = new Map()
const TOUCH_EVERY_MS = 5 * 60 * 1000

export function touchLastActive(prisma, userId, now = Date.now()) {
  if (!userId || now - (lastTouched.get(userId) || 0) < TOUCH_EVERY_MS) return
  lastTouched.set(userId, now)
  prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date(now) } }).catch(() => {})
}
