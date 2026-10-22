import prisma from './prisma.js'

// Stored notifications are events: something happened once. A failure to
// save one must never break the action that caused it (approving a lecturer
// matters more than the bell), so errors are logged and swallowed.
export async function notify(userIds, { type, sessionId = null, actorId = null, text }) {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!ids.length) return
  try {
    await prisma.notification.createMany({ data: ids.map((userId) => ({ userId, type, sessionId, actorId, text })) })
  } catch (err) {
    console.error('Saving notification failed:', err)
  }
}

// Everyone who can let lecturers in: the creator and every approved
// Full access marker.
export async function sessionManagerIds(session) {
  const managers = await prisma.sessionMarker.findMany({
    where: { sessionId: session.id, status: 'APPROVED', accessLevel: 'FULL' },
    select: { userId: true },
  })
  return [session.createdById, ...managers.map((m) => m.userId)]
}

const label = (q) => `Q${q.number}${q.subLabel || ''}`

// Reminders are not stored. They are worked out from the sessions as they
// are now, so "no questions claimed" goes away the moment you claim one.
// sessions: [{ id, title, courseCode, status, createdById,
//   guide: { isDraft, questions: [{ number, subLabel, assignedMarkerId }] } | null,
//   markers: [{ userId, status, accessLevel }] }]
export function buildReminders(sessions, userId) {
  const reminders = []
  for (const s of sessions) {
    if (s.status === 'COMPLETED' || !s.guide || s.guide.isDraft) continue
    const questions = s.guide.questions
    if (!questions.length) continue
    const name = s.courseCode || s.title
    const me = s.markers.find((m) => m.userId === userId && m.status === 'APPROVED')
    const isCreator = s.createdById === userId
    const canManage = isCreator || me?.accessLevel === 'FULL'
    const unclaimed = questions.filter((q) => !q.assignedMarkerId)
    const mine = questions.filter((q) => q.assignedMarkerId === userId)

    if (!isCreator && me && mine.length === 0 && unclaimed.length) {
      reminders.push({
        id: `claim:${s.id}`,
        type: 'REMINDER_CLAIM',
        sessionId: s.id,
        session: name,
        text: `No questions claimed in ${name}`,
        link: `/sessions/${s.id}/claim-questions`,
      })
    }
    const others = s.markers.some((m) => m.status === 'APPROVED' && m.userId !== s.createdById)
    if (canManage && others && unclaimed.length) {
      reminders.push({
        id: `unclaimed:${s.id}`,
        type: 'REMINDER_UNCLAIMED',
        sessionId: s.id,
        session: name,
        text: `${unclaimed.map(label).join(', ')} unclaimed in ${name}`,
        link: `/sessions/${s.id}/claim-questions`,
      })
    }
  }
  return reminders
}

// After a score is confirmed: if nothing in the session is left to confirm,
// tell the coordinator once.
export async function notifyIfSessionConfirmed(sessionId) {
  try {
    const left = await prisma.scriptAnswer.count({ where: { script: { sessionId }, confirmedAt: null } })
    if (left > 0) return
    const total = await prisma.scriptAnswer.count({ where: { script: { sessionId } } })
    if (!total) return
    const session = await prisma.markingSession.findUnique({ where: { id: sessionId } })
    const already = await prisma.notification.findFirst({ where: { sessionId, type: 'SESSION_CONFIRMED' } })
    if (!session || already) return
    await notify([session.createdById], {
      type: 'SESSION_CONFIRMED',
      sessionId,
      text: `Every script in ${session.courseCode || session.title} is confirmed`,
    })
  } catch (err) {
    console.error('Session confirmed check failed:', err)
  }
}
