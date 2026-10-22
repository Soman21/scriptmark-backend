import prisma from './prisma.js'

// One line in the Admin page's activity feed. Like notify(), it never
// throws: a failed log line must not undo the action it describes.
export async function logActivity({ type, actor = null, sessionId = null, text }) {
  try {
    await prisma.activityLog.create({
      data: { type, actorId: actor?.id || null, actorName: actor?.name || null, sessionId, text },
    })
  } catch (err) {
    console.error('Saving activity failed:', err)
  }
}
