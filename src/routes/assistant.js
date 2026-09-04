import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { chatWithAssistant } from '../lib/groq.js'

const router = express.Router()
router.use(requireAuth)

// POST /api/assistant/chat - body: { messages: [{ role, content }, ...] }
// Stateless: the frontend keeps the conversation and sends the whole history each time.
router.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'At least one message is required.' })
    }

    const reply = await chatWithAssistant(messages)
    res.json({ reply })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'The assistant could not respond: ' + err.message })
  }
})

export default router
