import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { adminEmails, isOwner, OWNER_EMAIL, loadAdminGrants } from '../lib/roles.js'
import { logActivity } from '../lib/activity.js'

const router = express.Router()
// Every route here is Admin only. The role is worked out on the server for
// each request (lib/roles.js), so hiding the menu item is not the guard.
router.use(requireAuth, requireRole('ADMIN'))

const configured = (...names) => names.every((n) => !!process.env[n])

// GET /api/admin/overview - totals, system status, recent activity,
// lecturers and sessions, in one request for the Admin page.
router.get('/overview', async (req, res) => {
  try {
    const started = Date.now()
    await prisma.$queryRaw`SELECT 1`
    const dbMs = Date.now() - started

    const [users, sessions, activeSessions, guides, scripts, marked, activity, lecturers, sessionList] = await Promise.all([
      prisma.user.count(),
      prisma.markingSession.count(),
      prisma.markingSession.count({ where: { status: 'ACTIVE' } }),
      prisma.markingGuide.count(),
      prisma.script.count(),
      prisma.scriptAnswer.count({ where: { OR: [{ confirmedAt: { not: null } }, { autoAccepted: true }] } }),
      prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
          _count: { select: { markingSessions: true, markerOfSessions: { where: { status: 'APPROVED' } } } },
        },
      }),
      prisma.markingSession.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          title: true,
          courseCode: true,
          examinationType: true,
          status: true,
          createdAt: true,
          createdBy: { select: { name: true } },
          _count: { select: { scripts: true, markers: { where: { status: 'APPROVED' } } } },
        },
      }),
    ])

    res.json({
      totals: { users, sessions, activeSessions, guides, scripts, marked },
      status: {
        database: { ok: true, ms: dbMs },
        uptimeSeconds: Math.round(process.uptime()),
        services: [
          { name: 'AI scoring', ok: configured('GROQ_API_KEY') },
          { name: 'Text recognition', ok: configured('GOOGLE_CREDENTIALS_JSON') },
          { name: 'File storage', ok: configured('SUPABASE_URL', 'SUPABASE_SECRET_KEY') },
          { name: 'Email', ok: configured('BREVO_SMTP_KEY') },
        ],
      },
      activity,
      lecturers: lecturers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        createdAt: u.createdAt,
        sessionsCreated: u._count.markingSessions,
        sessionsJoined: u._count.markerOfSessions,
      })),
      sessions: sessionList.map((s) => ({
        id: s.id,
        title: s.title,
        courseCode: s.courseCode,
        examinationType: s.examinationType,
        status: s.status,
        createdAt: s.createdAt,
        coordinator: s.createdBy?.name || null,
        scripts: s._count.scripts,
        lecturers: s._count.markers + 1,
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load the admin overview.' })
  }
})

// GET /api/admin/admins - who is Admin and why. Only the owner may change it.
router.get('/admins', async (req, res) => {
  try {
    const listed = adminEmails()
    const [grants, emailed] = await Promise.all([
      prisma.adminGrant.findMany({ include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } }),
      prisma.user.findMany({
        where: { OR: [OWNER_EMAIL, ...listed].map((e) => ({ email: { equals: e, mode: 'insensitive' } })) },
        select: { id: true, name: true, email: true },
      }),
    ])
    const admins = []
    const seen = new Set()
    for (const u of emailed.sort((a, b) => Number(isOwner(b.email)) - Number(isOwner(a.email)))) {
      seen.add(u.id)
      admins.push({ ...u, source: isOwner(u.email) ? 'OWNER' : 'EMAIL_LIST', removable: false })
    }
    for (const g of grants) {
      if (seen.has(g.userId)) continue
      admins.push({ ...g.user, source: 'GRANTED', removable: true, since: g.createdAt })
    }
    res.json({ admins, canChange: isOwner(req.user.email) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load admins.' })
  }
})

function requireOwner(req, res, next) {
  if (!isOwner(req.user.email)) return res.status(403).json({ error: 'Only the owner can change admins.' })
  next()
}

// POST /api/admin/admins  body: { email } - make an existing account Admin.
router.post('/admins', requireOwner, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim()
    if (!email) return res.status(400).json({ error: 'Email is required.' })
    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
    if (!user) return res.status(404).json({ error: 'No account uses that email.' })
    await prisma.adminGrant.upsert({ where: { userId: user.id }, update: {}, create: { userId: user.id, grantedById: req.user.id } })
    await loadAdminGrants(prisma)
    await logActivity({ type: 'ADMIN_ADDED', actor: req.user, text: `${req.user.name} made ${user.name} an admin` })
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not add the admin.' })
  }
})

// DELETE /api/admin/admins/:userId - take Admin away. The owner and anyone on
// the Admin email list can't be removed here.
router.delete('/admins/:userId', requireOwner, async (req, res) => {
  try {
    const grant = await prisma.adminGrant.findUnique({ where: { userId: req.params.userId }, include: { user: true } })
    if (!grant) return res.status(404).json({ error: 'That account is not a removable admin.' })
    await prisma.adminGrant.delete({ where: { userId: grant.userId } })
    // The stored role may say ADMIN from a sign in; put it back.
    await prisma.user.update({ where: { id: grant.userId }, data: { role: 'LECTURER' } })
    await loadAdminGrants(prisma)
    await logActivity({ type: 'ADMIN_REMOVED', actor: req.user, text: `${req.user.name} removed ${grant.user.name} as admin` })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not remove the admin.' })
  }
})

export default router
