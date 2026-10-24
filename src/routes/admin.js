import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { adminEmails, isOwner, OWNER_EMAIL, loadAdminGrants, effectiveRole } from '../lib/roles.js'
import { setSuspended } from '../lib/suspension.js'
import { logActivity } from '../lib/activity.js'
import { dayRange } from '../lib/siteStats.js'

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
          role: true,
          createdAt: true,
          lecturerId: true,
          suspendedAt: true,
          lastActiveAt: true,
          department: { select: { name: true, faculty: { select: { name: true } } } },
          _count: { select: { markingSessions: true } },
          // A coordinator can also have a marker row on their own session;
          // those are counted as created, not joined.
          markerOfSessions: { where: { status: 'APPROVED' }, select: { session: { select: { createdById: true } } } },
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
        lecturerId: u.lecturerId,
        faculty: u.department?.faculty.name || null,
        department: u.department?.name || null,
        admin: effectiveRole(u.email, u.role, u.id) === 'ADMIN',
        suspended: !!u.suspendedAt,
        lastActiveAt: u.lastActiveAt,
        sessionsCreated: u._count.markingSessions,
        sessionsJoined: u.markerOfSessions.filter((m) => m.session.createdById !== u.id).length,
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

// GET /api/admin/lecturers/:id - one lecturer: profile, sessions, how much
// they have marked, and their own activity.
router.get('/lecturers/:id', async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        department: { include: { faculty: true } },
        institution: true,
        markingSessions: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, title: true, courseCode: true, examinationType: true, status: true, createdAt: true },
        },
        markerOfSessions: {
          where: { status: 'APPROVED' },
          orderBy: { createdAt: 'desc' },
          select: {
            createdAt: true,
            accessLevel: true,
            session: { select: { id: true, title: true, courseCode: true, examinationType: true, status: true, createdById: true } },
          },
        },
      },
    })
    if (!u) return res.status(404).json({ error: 'Lecturer not found.' })

    const [answersMarked, questionsClaimed, guides, activity] = await Promise.all([
      // Confirmed by a person (not auto accepted) on questions this lecturer claimed.
      prisma.scriptAnswer.count({
        where: { question: { assignedMarkerId: u.id }, confirmedAt: { not: null }, autoAccepted: false },
      }),
      prisma.question.count({ where: { assignedMarkerId: u.id } }),
      prisma.markingGuide.count({ where: { createdById: u.id } }),
      prisma.activityLog.findMany({ where: { actorId: u.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ])

    const joined = u.markerOfSessions.filter((m) => m.session.createdById !== u.id)
    const role = effectiveRole(u.email, u.role, u.id)
    res.json({
      lecturer: {
        id: u.id,
        name: u.name,
        email: u.email,
        lecturerId: u.lecturerId,
        institution: u.institution?.name || null,
        faculty: u.department?.faculty.name || null,
        department: u.department?.name || null,
        admin: role === 'ADMIN',
        owner: isOwner(u.email),
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        suspendedAt: u.suspendedAt,
        suspendReason: u.suspendReason,
      },
      stats: {
        sessionsCreated: u.markingSessions.length,
        sessionsJoined: joined.length,
        guides,
        questionsClaimed,
        answersMarked,
      },
      sessionsCreated: u.markingSessions,
      sessionsJoined: joined.map(({ session: { createdById, ...s }, createdAt, accessLevel }) => ({ ...s, joinedAt: createdAt, accessLevel })),
      activity,
      canSuspend: canSuspend(req.user, u).ok,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load the lecturer.' })
  }
})

// Who may suspend whom: never yourself, never the owner, and only the owner
// may suspend another Admin.
function canSuspend(actor, target) {
  if (actor.id === target.id) return { ok: false, error: 'You cannot suspend your own account.' }
  if (isOwner(target.email)) return { ok: false, error: 'The owner account cannot be suspended.' }
  if (effectiveRole(target.email, target.role, target.id) === 'ADMIN' && !isOwner(actor.email)) {
    return { ok: false, error: 'Only the owner can suspend an admin.' }
  }
  return { ok: true }
}

// POST /api/admin/lecturers/:id/suspend  body: { reason }
// The account keeps all its work but is signed out and cannot sign in.
router.post('/lecturers/:id/suspend', async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim()
    if (!reason) return res.status(400).json({ error: 'Give a reason for the suspension.' })
    if (reason.length > 300) return res.status(400).json({ error: 'Keep the reason under 300 characters.' })
    const target = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!target) return res.status(404).json({ error: 'Lecturer not found.' })
    const check = canSuspend(req.user, target)
    if (!check.ok) return res.status(403).json({ error: check.error })

    await prisma.user.update({ where: { id: target.id }, data: { suspendedAt: new Date(), suspendReason: reason } })
    setSuspended(target.id, true)
    await logActivity({ type: 'LECTURER_SUSPENDED', actor: req.user, text: `${req.user.name} suspended ${target.name}` })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not suspend the lecturer.' })
  }
})

// POST /api/admin/lecturers/:id/restore - lets a suspended account sign in again.
router.post('/lecturers/:id/restore', async (req, res) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!target) return res.status(404).json({ error: 'Lecturer not found.' })
    if (!target.suspendedAt) return res.status(400).json({ error: 'This account is not suspended.' })
    const check = canSuspend(req.user, target)
    if (!check.ok) return res.status(403).json({ error: check.error })

    await prisma.user.update({ where: { id: target.id }, data: { suspendedAt: null, suspendReason: null } })
    setSuspended(target.id, false)
    await logActivity({ type: 'LECTURER_RESTORED', actor: req.user, text: `${req.user.name} restored ${target.name}` })
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not restore the lecturer.' })
  }
})

const n = (v) => Number(v || 0)
// Postgres stores UTC; the dashboard speaks Lagos time.
const LOCAL = `(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Lagos')`

// GET /api/admin/analytics?days=7|30|90 - visitors, page views and clicks
// recorded by the app's own tracker (POST /api/track).
router.get('/analytics', async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30
    const range = dayRange(days)
    // Midnight Lagos time on the first day, as UTC.
    const since = new Date(`${range[0]}T00:00:00+01:00`)

    const [totals, daily, pages, clicks, devices, referrers, hours, signups] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(DISTINCT "visitorId") AS visitors,
                COUNT(*) FILTER (WHERE type = 'PAGE_VIEW') AS views,
                COUNT(*) FILTER (WHERE type = 'CLICK') AS clicks,
                COUNT(DISTINCT "userId") AS lecturers
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1`,
        since
      ),
      prisma.$queryRawUnsafe(
        `SELECT to_char(${LOCAL}, 'YYYY-MM-DD') AS day, COUNT(DISTINCT "visitorId") AS visitors,
                COUNT(*) FILTER (WHERE type = 'PAGE_VIEW') AS views
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1 GROUP BY day`,
        since
      ),
      prisma.$queryRawUnsafe(
        `SELECT path, COUNT(*) AS views, COUNT(DISTINCT "visitorId") AS visitors
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1 AND type = 'PAGE_VIEW'
         GROUP BY path ORDER BY views DESC LIMIT 10`,
        since
      ),
      prisma.$queryRawUnsafe(
        `SELECT label, path, COUNT(*) AS clicks
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1 AND type = 'CLICK'
         GROUP BY label, path ORDER BY clicks DESC LIMIT 10`,
        since
      ),
      prisma.$queryRawUnsafe(
        `SELECT COALESCE(device, 'unknown') AS device, COUNT(DISTINCT "visitorId") AS visitors
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1 GROUP BY 1 ORDER BY visitors DESC`,
        since
      ),
      prisma.$queryRawUnsafe(
        `SELECT referrer, COUNT(DISTINCT "visitorId") AS visitors
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1 AND referrer IS NOT NULL
         GROUP BY referrer ORDER BY visitors DESC LIMIT 8`,
        since
      ),
      prisma.$queryRawUnsafe(
        `SELECT EXTRACT(HOUR FROM ${LOCAL})::int AS hour, COUNT(*) AS views
         FROM "AnalyticsEvent" WHERE "createdAt" >= $1 AND type = 'PAGE_VIEW' GROUP BY hour`,
        since
      ),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
    ])

    const t = totals[0] || {}
    const byDay = new Map(daily.map((d) => [d.day, d]))
    const byHour = new Map(hours.map((h) => [n(h.hour), n(h.views)]))
    const visitors = n(t.visitors)
    const views = n(t.views)
    res.json({
      days,
      totals: {
        visitors,
        views,
        clicks: n(t.clicks),
        lecturers: n(t.lecturers),
        signups,
        viewsPerVisitor: visitors ? Math.round((views / visitors) * 10) / 10 : 0,
        signupRate: visitors ? Math.round((signups / visitors) * 1000) / 10 : 0,
      },
      daily: range.map((day) => ({ day, visitors: n(byDay.get(day)?.visitors), views: n(byDay.get(day)?.views) })),
      pages: pages.map((p) => ({ path: p.path, views: n(p.views), visitors: n(p.visitors) })),
      clicks: clicks.map((c) => ({ label: c.label, path: c.path, clicks: n(c.clicks) })),
      devices: devices.map((d) => ({ device: d.device, visitors: n(d.visitors) })),
      referrers: referrers.map((r) => ({ referrer: r.referrer, visitors: n(r.visitors) })),
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, views: byHour.get(hour) || 0 })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load analytics.' })
  }
})

export default router
