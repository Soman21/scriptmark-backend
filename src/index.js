import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import authRoutes from './routes/auth.js'
import guideRoutes from './routes/guides.js'
import sessionRoutes from './routes/sessions.js'
import resultRoutes from './routes/results.js'

const app = express()

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  })
)
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

app.use('/api/auth', authRoutes)
app.use('/api/guides', guideRoutes)
app.use('/api/sessions', sessionRoutes)
app.use('/api/results', resultRoutes)

// Fallback error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'Unexpected server error.' })
})

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`ScriptMark API running on http://localhost:${PORT}`)
})
