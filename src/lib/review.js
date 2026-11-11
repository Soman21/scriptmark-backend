// The marking assistant beside a script in Results. It talks the lecturer
// through one script and may propose a new score for one question, but it
// never saves anything: a proposal only fills the score box, and the
// lecturer still presses Confirm.

const MAX_TEXT = 4000

export function buildReviewContext(script) {
  const blocks = script.answers.map((a) => {
    const q = a.question
    const steps = Array.isArray(q.steps) && q.steps.length ? `\nStep rubric:\n${q.steps.map((s, i) => `  ${i + 1}. ${s.description} (${s.marks} marks)`).join('\n')}${q.countBest ? `\nOnly the best ${q.countBest} of these ${q.steps.length} points count.` : ''}` : ''
    const confirmed = a.confirmedAt
      ? `${a.confirmedScore} (${a.autoAccepted ? 'auto accepted because the AI was highly confident' : 'confirmed by a lecturer'})`
      : 'not confirmed yet'
    const student = (a.visionTranscript || a.extractedText || '').slice(0, MAX_TEXT)
    // A question the student did not answer (common with "answer any
    // three") needs no guide text: one line keeps the request small enough
    // for the free AI plans.
    const notAnswered = !student.trim() || (Number(a.suggestedScore) === 0 && /^not answered/i.test(String(a.reasoning || '').trim()))
    if (notAnswered) {
      return `Question ID: ${q.id}\nQuestion ${q.number}${q.subLabel || ''} (${q.maxMarks} marks): not answered by the student. Write it only as "Q${q.number}${q.subLabel || ''}, 0/${q.maxMarks}". Current score: ${confirmed}`
    }
    return [
      `Question ID: ${q.id}`,
      `Question ${q.number}${q.subLabel || ''} (${q.maxMarks} marks): ${q.text}`,
      `Model answer: ${q.modelAnswer || '(none given)'}`,
      `Keywords: ${q.keywords || '(none)'}${steps}`,
      `<student_answer>\n${student}\n</student_answer>`,
      `AI suggested score: ${a.suggestedScore ?? 'none'} out of ${q.maxMarks}, ${a.confidence || 'unknown'} confidence`,
      `AI reasoning: ${a.reasoning || '(none)'}`,
      `Current score: ${confirmed}`,
    ].join('\n')
  })
  const who = [script.studentName, script.regNumber].filter(Boolean).join(', ') || 'unnamed student'
  return `Script of ${who}.\n\n${blocks.join('\n\n')}`
}

// Keeps only a usable reply, and a proposal only for a question on this
// script with a score inside its marks.
// The model is told to write plain prose, but it sometimes slips back into
// lists. This takes off list markers, bold stars and long dashes so the
// panel always reads as plain sentences.
export function plainReply(text) {
  return String(text)
    .split('\n')
    .map((line) => line
      .replace(/^\s*(?:[•●▪◦*\-–—]|\d+[.)])(?:\s+|$)/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^#+\s*/, '')
      .replace(/\s*[–—]\s*/g, ', ')
      .trim())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join('\n')
    .trim()
}

export function cleanReviewReply(raw, answers) {
  const reply = typeof raw?.reply === 'string' && raw.reply.trim() ? plainReply(raw.reply) || null : null
  let proposal = null
  const p = raw?.proposal
  if (p && typeof p === 'object') {
    const answer = answers.find((a) => a.question.id === p.questionId)
    const score = typeof p.score === 'number' ? p.score : Number(p.score)
    if (answer && Number.isFinite(score)) {
      const max = Number(answer.question.maxMarks) || 0
      proposal = {
        answerId: answer.id,
        questionId: answer.question.id,
        label: `Question ${answer.question.number}${answer.question.subLabel || ''}`,
        score: Math.min(Math.max(Math.round(score * 2) / 2, 0), max),
        maxMarks: max,
        reason: typeof p.reason === 'string' ? p.reason.trim().slice(0, 300) : '',
      }
    }
  }
  return { reply, proposal }
}
