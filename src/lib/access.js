// Single source of truth for "which sessions can this user see" — reused by
// the sessions list route and the AI assistant's tools, so the assistant can
// never surface a session the same user couldn't already see in the app.
// Visibility is based on actual membership, not role: created it, or an
// approved marker on it. Only Admin sees everything unconditionally.
export async function accessibleSessionsWhere(prisma, user) {
  if (user.role === 'ADMIN') return {}
  const memberships = await prisma.sessionMarker.findMany({
    where: { userId: user.id, status: 'APPROVED' },
    select: { sessionId: true },
  })
  return { OR: [{ createdById: user.id }, { id: { in: memberships.map((m) => m.sessionId) } }] }
}

// Convenience check for a single session id, used before a tool acts on a
// specific session a lecturer or reviewer names in chat.
export async function canAccessSession(prisma, user, sessionId) {
  const where = await accessibleSessionsWhere(prisma, user)
  const session = await prisma.markingSession.findFirst({ where: { id: sessionId, ...where } })
  return session
}

// A script is reachable exactly when its session is.
export async function canAccessScript(prisma, user, scriptId) {
  const script = await prisma.script.findUnique({ where: { id: scriptId } })
  if (!script) return { script: null, session: null }
  const session = await canAccessSession(prisma, user, script.sessionId)
  return { script, session }
}

// Guides follow the same rule as sessions: your own, or the guide of a
// session you can see (so a joined marker can read the guide they mark
// against). Only Admin sees every guide.
export async function accessibleGuidesWhere(prisma, user) {
  if (user.role === 'ADMIN') return {}
  const sessionWhere = await accessibleSessionsWhere(prisma, user)
  return { OR: [{ createdById: user.id }, { sessions: { some: sessionWhere } }] }
}

// Only the guide's author (or an Admin) may change or delete it.
export function canEditGuide(user, guide) {
  return user.role === 'ADMIN' || guide.createdById === user.id
}
