import express from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'
import { EVENT_TYPES, DEVICES, normalizePath, cleanLabel, referrerHost } from '../lib/siteStats.js'

const router = express.Router()

let ownHost = ''
try {
  ownHost = new URL(process.env.FRONTEND_URL || 'http://localhost:5173').hostname.replace(/^www\./, '')
} catch {}

// POST /api/track  body: { visitorId, events: [{ type, path, label, device, referrer }] }
// Open to visitors who are not signed in, since the landing page counts too.
// A signed in request also records which account it was, for "active
// lecturers". Bad events are dropped quietly; tracking never shows an error.
router.post('/', async (req, res) => {
  try {
    const { visitorId, events } = req.body || {}
    if (!/^[a-z0-9-]{8,64}$/i.test(String(visitorId || '')) || !Array.isArray(events)) return res.status(204).end()

    let userId = null
    const header = req.headers.authorization || ''
    if (header.startsWith('Bearer ')) {
      try {
        userId = jwt.verify(header.slice(7), process.env.JWT_SECRET).id || null
      } catch {}
    }

    const rows = events
      .slice(0, 20)
      .filter((e) => e && EVENT_TYPES.includes(e.type))
      .map((e) => ({
        type: e.type,
        path: normalizePath(e.path),
        label: e.type === 'CLICK' ? cleanLabel(e.label) : null,
        visitorId,
        userId,
        device: DEVICES.includes(e.device) ? e.device : null,
        referrer: e.referrer ? referrerHost(e.referrer, ownHost) : null,
      }))
      .filter((r) => r.type === 'PAGE_VIEW' || r.label)
      .filter((r) => !r.path.startsWith('/admin'))

    if (rows.length) await prisma.analyticsEvent.createMany({ data: rows })
    res.status(204).end()
  } catch (err) {
    console.error('Tracking failed:', err)
    res.status(204).end()
  }
})

export default router
