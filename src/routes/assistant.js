import express from 'express'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { chatWithAssistantTools } from '../lib/groq.js'
import { accessibleSessionsWhere, canAccessSession } from '../lib/access.js'
import { findUnresolvedScripts } from '../lib/roster.js'
import { computeSessionAnalytics } from '../lib/analytics.js'

const router = express.Router()
router.use(requireAuth)

async function requireSessionAccess(user, sessionId) {
  const session = await canAccessSession(prisma, user, sessionId)
  if (!session) throw new Error('That session was not found, or you do not have access to it.')
  return session
}

async function toolListSessions(user) {
  const where = await accessibleSessionsWhere(prisma, user)
  const sessions = await prisma.markingSession.findMany({
    where,
    select: { id: true, title: true, courseCode: true, status: true, createdAt: true, _count: { select: { scripts: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      courseCode: s.courseCode,
      status: s.status,
      scriptCount: s._count.scripts,
      createdAt: s.createdAt,
    })),
  }
}

async function toolGetSessionProgress(user, { sessionId }) {
  const session = await requireSessionAccess(user, sessionId)
  const scripts = await prisma.script.findMany({ where: { sessionId } })
  const byStatus = {}
  scripts.forEach((s) => {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1
  })
  return {
    sessionTitle: session.title,
    totalScripts: scripts.length,
    byStatus,
    flaggedLowConfidence: scripts.filter((s) => s.hasLowConfidenceScore).length,
    unresolvedRosterConflicts: findUnresolvedScripts(scripts, session.classList).length,
  }
}

async function toolFindStudent(user, { query, sessionId }) {
  const where = await accessibleSessionsWhere(prisma, user)
  const sessionWhere = sessionId ? { id: sessionId, ...where } : where
  const accessibleSessions = await prisma.markingSession.findMany({ where: sessionWhere, select: { id: true, title: true } })
  if (sessionId && accessibleSessions.length === 0) {
    throw new Error('That session was not found, or you do not have access to it.')
  }
  const sessionIds = accessibleSessions.map((s) => s.id)
  const sessionTitleById = Object.fromEntries(accessibleSessions.map((s) => [s.id, s.title]))

  const scripts = await prisma.script.findMany({
    where: {
      sessionId: { in: sessionIds },
      OR: [
        { studentName: { contains: query, mode: 'insensitive' } },
        { regNumber: { contains: query, mode: 'insensitive' } },
      ],
    },
    include: { answers: { include: { question: true } } },
    take: 10,
  })

  return {
    matches: scripts.map((s) => ({
      sessionTitle: sessionTitleById[s.sessionId],
      sessionId: s.sessionId,
      studentName: s.studentName,
      regNumber: s.regNumber,
      status: s.status,
      totalScore: s.totalScore,
      caScore: s.caScore,
      answers: s.answers.map((a) => ({
        question: a.question ? `${a.question.number}${a.question.subLabel || ''}` : null,
        maxMarks: a.question?.maxMarks,
        suggestedScore: a.suggestedScore,
        confirmedScore: a.confirmedScore,
      })),
    })),
  }
}

async function toolGetGuideQuestions(user, { sessionId }) {
  const session = await requireSessionAccess(user, sessionId)
  if (!session.guideId) return { error: 'This session has no marking guide attached yet.' }
  const guide = await prisma.markingGuide.findUnique({
    where: { id: session.guideId },
    include: { questions: { orderBy: { order: 'asc' } } },
  })
  return {
    guideTitle: guide.title,
    questions: guide.questions.map((q) => ({
      number: q.number,
      subLabel: q.subLabel,
      text: q.text,
      maxMarks: q.maxMarks,
      isCalculationHeavy: q.isCalculationHeavy,
      steps: q.steps,
    })),
  }
}

async function toolGetAnalytics(user, { sessionId }) {
  await requireSessionAccess(user, sessionId)
  return computeSessionAnalytics(sessionId)
}

async function toolPrepareExport(user, { sessionId, format }) {
  const session = await requireSessionAccess(user, sessionId)
  const scripts = await prisma.script.findMany({ where: { sessionId } })
  const unresolved = findUnresolvedScripts(scripts, session.classList)
  if (unresolved.length > 0) {
    return {
      eligible: false,
      reason: `${unresolved.length} student${unresolved.length !== 1 ? 's have' : ' has'} an unresolved name conflict in the class list — resolve them on the Results page before exporting.`,
    }
  }
  return { eligible: true, sessionId, sessionTitle: session.title, format: format || 'both' }
}

async function executeTool(name, args, user) {
  switch (name) {
    case 'list_sessions':
      return toolListSessions(user)
    case 'get_session_progress':
      return toolGetSessionProgress(user, args)
    case 'find_student':
      return toolFindStudent(user, args)
    case 'get_guide_questions':
      return toolGetGuideQuestions(user, args)
    case 'get_analytics':
      return toolGetAnalytics(user, args)
    case 'prepare_export':
      return toolPrepareExport(user, args)
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

const MAX_TOOL_ITERATIONS = 4

// POST /api/assistant/chat - body: { messages: [{ role, content }, ...], activeSessionId? }
// Stateless: the frontend keeps the conversation and sends the whole history each time.
// activeSessionId, when given, is whichever session is currently open in the app - a hint,
// not a restriction, since the assistant can look up any session the user has access to.
router.post('/chat', async (req, res) => {
  try {
    const { messages, activeSessionId } = req.body
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'At least one message is required.' })
    }

    let working = activeSessionId
      ? [
          {
            role: 'system',
            content: `<activeSession>${activeSessionId}</activeSession> is the session currently open in the app, if relevant to what's asked.`,
          },
          ...messages,
        ]
      : [...messages]

    let action = null

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const message = await chatWithAssistantTools(working)

      if (!message.tool_calls || message.tool_calls.length === 0) {
        return res.json({ reply: message.content, action })
      }

      working.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls })

      // Sequential, not parallel - gpt-oss-120b on Groq doesn't support
      // parallel tool calls, and each tool needs the user's access checks
      // applied one at a time anyway.
      for (const call of message.tool_calls) {
        let result
        try {
          const args = JSON.parse(call.function.arguments || '{}')
          result = await executeTool(call.function.name, args, req.user)
          if (call.function.name === 'prepare_export' && result.eligible) {
            action = { type: 'export', sessionId: result.sessionId, sessionTitle: result.sessionTitle, format: result.format }
          }
        } catch (err) {
          result = { error: err.message }
        }
        working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      }
    }

    res.json({
      reply: "I wasn't able to finish looking that up in time - could you narrow down what you're asking?",
      action,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'The assistant could not respond: ' + err.message })
  }
})

export default router
