import { findUnresolvedScripts } from './roster.js'
import { withDuplicateFlags } from './duplicates.js'

// The "What needs me today" list on the AI Assistant page: one pass over
// every open session the user can see, turned into short items that each
// link to the page where the work is done. Built from data only, no AI,
// so the counts always match what the pages themselves show.

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

function questionLabel(q) {
  return `Q${q.number}${q.subLabel || ''}`
}

// session: { id, title, courseCode, status, createdById, classList,
//   guide: { questions: [{ id, number, subLabel, assignedMarkerId }] } | null,
//   markers: [{ userId, status, accessLevel }],
//   scripts: [{ id, status, regNumber, classListEntryId, answers: [{ questionId, suggestedScore, confirmedScore }] }] }
export function sessionTodoItems(session, userId, isAdmin = false) {
  const items = []
  const name = session.courseCode || session.title
  const base = `/sessions/${session.id}`
  const add = (kind, text, path, count, priority) =>
    items.push({ sessionId: session.id, session: name, kind, text, link: `${base}/${path}`, count, priority })

  const me = session.markers.find((m) => m.userId === userId && m.status === 'APPROVED')
  const canManage = isAdmin || session.createdById === userId || me?.accessLevel === 'FULL'
  const questions = session.guide?.questions || []
  const scripts = session.scripts

  if (canManage) {
    const waiting = session.markers.filter((m) => m.status === 'PENDING').length
    if (waiting) add('join', `${plural(waiting, 'lecturer is', 'lecturers are')} waiting to join`, 'claim-questions', waiting, 1)
  }

  if (!session.guide) {
    if (canManage) add('guide', 'Attach a marking guide before marking can start', 'marking', null, 2)
    return items
  }

  if (scripts.length === 0) {
    if (canManage) add('scan', 'No scripts scanned yet', 'scan', null, 3)
    return items
  }

  const unmarked = scripts.filter((s) => s.status === 'PENDING' || s.status === 'DIGITIZED').length
  if (unmarked && canManage) add('mark', `${plural(unmarked, 'script is', 'scripts are')} waiting to be marked`, 'marking', unmarked, 3)

  const myQuestionIds = new Set(questions.filter((q) => q.assignedMarkerId === userId).map((q) => q.id))
  let toConfirm = 0
  for (const s of scripts) {
    for (const a of s.answers) {
      if (myQuestionIds.has(a.questionId) && a.suggestedScore != null && a.confirmedScore == null) toConfirm++
    }
  }
  if (toConfirm) add('queue', `${plural(toConfirm, 'answer is', 'answers are')} waiting for you to confirm`, 'my-queue', toConfirm, 2)

  // Unclaimed questions only matter once other lecturers have joined;
  // a lecturer marking alone confirms everything from Results.
  const others = session.markers.some((m) => m.status === 'APPROVED' && m.userId !== session.createdById)
  if (canManage) {
    let rest = 0
    for (const s of scripts) {
      for (const a of s.answers) {
        if (!myQuestionIds.has(a.questionId) && a.suggestedScore != null && a.confirmedScore == null) rest++
      }
    }
    if (rest) {
      if (others) add('others', `${plural(rest, 'answer', 'answers')} on other markers' questions still to be confirmed`, 'coordinator', rest, 3)
      else add('confirm', `${plural(rest, 'answer still needs', 'answers still need')} confirming`, 'results', rest, 2)
    }
  }
  const unclaimed = questions.filter((q) => !q.assignedMarkerId)
  if (canManage && others && unclaimed.length) {
    add('claim', `${plural(unclaimed.length, 'question has', 'questions have')} no marker: ${unclaimed.map(questionLabel).join(', ')}`, 'claim-questions', unclaimed.length, 2)
  }

  if (canManage) {
    const flagged = scripts.filter((s) => s.status === 'FLAGGED').length
    if (flagged) add('flagged', `${plural(flagged, 'script is', 'scripts are')} flagged for a closer look`, 'results', flagged, 2)

    const conflicts = findUnresolvedScripts(scripts, session.classList).length
    if (conflicts) add('names', `${plural(conflicts, 'student name needs', 'student names need')} checking against the class list`, 'results', conflicts, 2)

    const twice = withDuplicateFlags(scripts).filter((s) => s.duplicateOf?.length).length
    if (twice) add('duplicates', `${plural(twice, 'script looks', 'scripts look')} scanned twice`, 'marking', twice, 2)

    const allConfirmed = scripts.every((s) => s.answers.length > 0 && s.answers.every((a) => a.confirmedScore != null))
    if (allConfirmed && !conflicts) add('export', 'Every script is confirmed and ready to export', 'export', scripts.length, 4)
  }

  return items
}

export function buildTodayList(sessions, userId, isAdmin = false) {
  const items = sessions
    .filter((s) => s.status !== 'COMPLETED')
    .flatMap((s) => sessionTodoItems(s, userId, isAdmin))
  return items.sort((a, b) => a.priority - b.priority)
}

export async function loadTodayList(prisma, user, sessionWhere) {
  const sessions = await prisma.markingSession.findMany({
    where: sessionWhere,
    select: {
      id: true,
      title: true,
      courseCode: true,
      status: true,
      createdById: true,
      classList: true,
      guide: { select: { questions: { select: { id: true, number: true, subLabel: true, assignedMarkerId: true }, orderBy: { order: 'asc' } } } },
      markers: { select: { userId: true, status: true, accessLevel: true } },
      scripts: {
        select: {
          id: true,
          status: true,
          regNumber: true,
          classListEntryId: true,
          answers: { select: { questionId: true, suggestedScore: true, confirmedScore: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
  return buildTodayList(sessions, user.id, user.role === 'ADMIN')
}
