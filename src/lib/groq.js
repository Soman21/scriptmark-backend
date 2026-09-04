// Uses Groq's free, OpenAI-compatible API to run an open-source LLM (Llama 3.3 70B)
// for suggesting scores. This is ALWAYS a suggestion — a human lecturer/reviewer
// must confirm the score before it counts (see results.js "/confirm" route).

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'llama-3.3-70b-versatile'

const SYSTEM_PROMPT = `You are an assistant that helps a human lecturer grade exam scripts.
You NEVER assign a final grade — you only suggest a score and explain your reasoning.
A human always reviews and confirms the score afterward.

Some questions are split into subparts (e.g. "Question 1a", "Question 1b") — treat each
subpart as its own separate item to score, using its own max marks.

For each question given, read the student's extracted answer text and compare it to the
model answer and keywords. Judge conceptual correctness, not exact wording match.

Respond with ONLY a JSON object of this exact shape, and nothing else:
{"results": [{"questionId": "the question's id", "suggestedScore": number, "reasoning": "a short, specific explanation"}]}`

// questions: array of { id, number, subLabel, text, modelAnswer, keywords, maxMarks }
// ocrText: the full text extracted from the student's script via OCR
export async function scoreScriptAgainstGuide(ocrText, questions) {
  const questionsBlock = questions
    .map((q) => {
      const label = q.subLabel ? `Question ${q.number}${q.subLabel}` : `Question ${q.number}`
      return `Question ID: ${q.id}\n${label}: ${q.text}\nModel Answer: ${q.modelAnswer}\nKeywords: ${q.keywords}\nMax Marks: ${q.maxMarks}`
    })
    .join('\n\n')

  const userPrompt = `MARKING GUIDE:\n${questionsBlock}\n\nSTUDENT'S EXTRACTED SCRIPT TEXT (from OCR):\n${ocrText}`

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Groq API error (${res.status}): ${errText}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('Groq returned an empty response.')

  const parsed = JSON.parse(content)
  return parsed.results || []
}

// Reads the front page of a script and tries to pick out the student's name
// and registration number, since students write these by hand at the top of
// the page. Returns null for either field if it cannot find them confidently —
// the lecturer then just types them in manually.
export async function extractStudentInfo(pageText) {
  if (!pageText || !pageText.trim()) return { name: null, regNumber: null }

  const systemPrompt = `You are given OCR text from the front page of a handwritten exam script,
with line breaks preserved roughly in top to bottom reading order.

REGISTRATION NUMBER: usually has a printed label right next to it, such as "Reg No",
"Registration Number", "Matric No", or similar, and often follows a pattern like
YYYY/NNNNNN. This is usually reliable to find — look for text right after such a label.

STUDENT NAME: has NO printed label. Students simply handwrite their name somewhere near
the very top of the page, before any numbered exam questions begin. Look for a short
line of two to four capitalized words, with no digits, that is not the course title,
department, faculty, date, or the start of an answer. This is inherently a guess, not a
labeled field, so only return a name if the line is clearly name shaped and positioned
near the top. If nothing fits confidently, use null rather than guessing.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"name": "the student's name or null", "regNumber": "the registration number or null"}`

  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: pageText },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    })
    if (!res.ok) return { name: null, regNumber: null }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return { name: null, regNumber: null }

    const parsed = JSON.parse(content)
    return { name: parsed.name || null, regNumber: parsed.regNumber || null }
  } catch (err) {
    console.error('Student info extraction failed:', err)
    return { name: null, regNumber: null }
  }
}

const ASSISTANT_SYSTEM_PROMPT = `You are the ScriptMark AI Assistant, a helpful guide built into an
exam script marking system used by lecturers, reviewers, and admins at a university.

ScriptMark lets a lecturer: create marking guides with numbered questions (which can have
lettered subparts like 1a, 1b), start a marking session for a course/exam, scan or photograph
student scripts (one or many pages per script), which get digitized with OCR, then scored
suggestions from an LLM, which a human always reviews and confirms before it counts. Reviewers
can confirm or flag scores. Results (with Continuous Assessment scores and computed grades) can
be exported as Excel or PDF.

Answer questions about how to use ScriptMark, explain what a feature does, and help troubleshoot
common confusion, in a friendly, concise way. If asked something outside ScriptMark's scope,
answer briefly and helpfully as a general assistant would. Keep answers short unless asked for detail.`

// messages: array of { role: "user" | "assistant", content: string }, oldest first
export async function chatWithAssistant(messages) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }, ...messages],
      temperature: 0.6,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Groq API error (${res.status}): ${errText}`)
  }

  const data = await res.json()
  const reply = data.choices?.[0]?.message?.content
  if (!reply) throw new Error('Groq returned an empty response.')
  return reply
}
