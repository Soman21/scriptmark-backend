import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { buildReminders } from '../lib/notifications.js'

const router = express.Router()
router.use(requireAuth)

// GET /api/notifications - the bell: the latest stored events plus the
// reminders that apply right now. A join request carries `pending` so the
// bell only offers Grant access while the request is still waiting (it may
// already have been decided from the email or by another coordinator).
router.get('/', async (req, res) => {
  try {
    const stored = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })

    const sessionIds = [...new Set(stored.map((n) => n.sessionId).filter(Boolean))]
    const actorIds = [...new Set(stored.map((n) => n.actorId).filter(Boolean))]
    const [sessions, waiting] = await Promise.all([
      prisma.markingSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true, title: true, courseCode: true } }),
      prisma.sessionMarker.findMany({
        where: { sessionId: { in: sessionIds }, userId: { in: actorIds }, status: 'PENDING' },
        select: { sessionId: true, userId: true },
      }),
    ])
    const sessionName = new Map(sessions.map((s) => [s.id, s.courseCode || s.title]))
    const isWaiting = new Set(waiting.map((w) => `${w.sessionId}:${w.userId}`))

    const items = stored.map((n) => ({
      id: n.id,
      type: n.type,
      text: n.text,
      sessionId: n.sessionId,
      session: sessionName.get(n.sessionId) || null,
      actorId: n.actorId,
      read: !!n.readAt,
      createdAt: n.createdAt,
      pending: n.type === 'JOIN_REQUEST' && isWaiting.has(`${n.sessionId}:${n.actorId}`),
      link: n.sessionId ? `/sessions/${n.sessionId}` : null,
    }))

    // Reminders only for sessions the user is actually in.
    const memberships = await prisma.sessionMarker.findMany({ where: { userId: req.user.id, status: 'APPROVED' }, select: { sessionId: true } })
    const mySessions = await prisma.markingSession.findMany({
      where: { OR: [{ createdById: req.user.id }, { id: { in: memberships.map((m) => m.sessionId) } }] },
      select: {
        id: true,
        title: true,
        courseCode: true,
        status: true,
        createdById: true,
        guide: { select: { isDraft: true, questions: { select: { number: true, subLabel: true, assignedMarkerId: true }, orderBy: { order: 'asc' } } } },
        markers: { select: { userId: true, status: true, accessLevel: true } },
      },
    })
    const reminders = buildReminders(mySessions, req.user.id)

    res.json({ items, reminders, unread: items.filter((i) => !i.read).length + reminders.length })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load notifications.' })
  }
})

// POST /api/notifications/read - mark every stored notification read, used
// when the bell is opened. Reminders can't be read away; they clear when
// the work is done.
router.post('/read', async (req, res) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not update notifications.' })
  }
})

export default router
