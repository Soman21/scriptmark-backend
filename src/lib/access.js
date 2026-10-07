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
