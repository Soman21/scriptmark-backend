import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import authRoutes from './routes/auth.js'
import guideRoutes from './routes/guides.js'
import sessionRoutes from './routes/sessions.js'
import resultRoutes from './routes/results.js'
import assistantRoutes from './routes/assistant.js'
import notificationRoutes from './routes/notifications.js'
import courseRoutes from './routes/courses.js'
import adminRoutes from './routes/admin.js'
import trackRoutes from './routes/track.js'
import prisma from './lib/prisma.js'
import { loadAdminGrants } from './lib/roles.js'
import { loadSuspended } from './lib/suspension.js'
import { syncInstitutions } from './lib/institutions.js'

const app = express()

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  })
)
// Confirming a large split sends every page's address in one request; the
// default 100 KB cap was hit at about 50 scripts of 16 pages.
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

app.use('/api/auth', authRoutes)
app.use('/api/guides', guideRoutes)
app.use('/api/sessions', sessionRoutes)
app.use('/api/results', resultRoutes)
app.use('/api/assistant', assistantRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/courses', courseRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/track', trackRoutes)

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Unexpected server error.' })
})

const PORT = process.env.PORT || 4000
// Admins made on the Admin page are held in memory for fast checks; load
// them now and refresh once a minute.
loadAdminGrants(prisma)
loadSuspended(prisma)
setInterval(() => {
  loadAdminGrants(prisma)
  loadSuspended(prisma)
}, 60000).unref()
// Faculties and departments come from src/lib/institutions.js.
syncInstitutions(prisma)

app.listen(PORT, () => {
  console.log(`ScriptMark API running on http://localhost:${PORT}`)
})
