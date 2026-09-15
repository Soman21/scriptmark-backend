// Uses Groq's free, OpenAI-compatible API to run an open-source LLM
// for suggesting scores. This is ALWAYS a suggestion — a human lecturer/reviewer
// must confirm the score before it counts (see results.js "/confirm" route).

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'openai/gpt-oss-120b' // llama-3.3-70b-versatile was deprecated and decommissioned by Groq on August 16, 2026; this is their recommended 1:1 replacement

const SYSTEM_PROMPT = `You are an assistant that helps a human lecturer grade exam scripts.
You NEVER assign a final grade — you only suggest a score and explain your reasoning.
A human always reviews and confirms the score afterward.

Some questions are split into subparts (e.g. "Question 1a", "Question 1b") — treat each
subpart as its own separate item to score, using its own max marks.

For each question given, read the student's extracted answer text and compare it to the
model answer and keywords. Judge conceptual correctness, not exact wording match.

For each question, also copy out the specific portion of the student's text that answers
THAT question (not the whole script) — this lets a human reviewer see exactly what you
scored, side by side with the expected answer.

Also rate your own confidence in the suggested score as "high", "medium", or "low".
Use "low" whenever the student's answer is ambiguous, the OCR text looks garbled or
incomplete, or the question and answer are hard to match up confidently.

Respond with ONLY a JSON object of this exact shape, and nothing else:
{"results": [{"questionId": "the question's id", "suggestedScore": number, "answerText": "the relevant portion of the student's text for this question", "confidence": "high" | "medium" | "low", "reasoning": "a short, specific explanation"}]}`

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

const PARSE_GUIDE_SYSTEM_PROMPT = `You are given the raw text of an existing exam marking scheme document,
uploaded by a lecturer. Your job is to extract it into a structured list of questions.

Rules:
- Preserve the original question numbering as written (e.g. "1", "2", "3").
- If a question has lettered subparts (e.g. "1a", "1b", "1c"), give each subpart its own
  entry, with "number" set to the shared number ("1") and "subLabel" set to just the letter
  ("a", "b", "c"). If a question has no subparts, leave subLabel as null.
- "text" is the question prompt itself.
- "modelAnswer" is the expected answer or marking notes for that question, exactly as given
  in the document. If the document only lists keywords/points rather than a full answer,
  use those as the model answer text.
- IMPORTANT: if this document is just a question paper with no answers or marking notes at
  all for a given question, leave "modelAnswer" as an empty string "" for that question,
  rather than writing an answer yourself. Do not invent an answer that is not actually
  present in the document in some form. A human will decide separately whether to have AI
  generate answers for anything left blank.
- "keywords" is a short comma separated list of key terms or concepts this answer should
  contain, based on the model answer. If modelAnswer is blank, leave keywords blank too.
- "maxMarks" is the mark allocated to that question or subpart, as a number. If subparts
  don't state individual marks but the parent question does, split the total evenly across
  subparts unless the document implies otherwise. Marks are usually printed even on a bare
  question paper, so still fill this in even when modelAnswer is blank.
- Ignore headers, footers, page numbers, and instructions not part of a specific question.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"title": "a short title for this guide, guessed from the document", "subject": "the subject or course name if mentioned, else null", "questions": [{"number": "1", "subLabel": null, "text": "...", "modelAnswer": "...", "keywords": "...", "maxMarks": 10}]}`

// rawText: plain text extracted from an uploaded PDF or DOCX marking scheme.
// Returns a structure the frontend can drop straight into the same editable
// question builder used for manual entry, so the lecturer reviews and can
// change anything before it's actually saved.
export async function parseMarkingSchemeDocument(rawText) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: PARSE_GUIDE_SYSTEM_PROMPT },
        { role: 'user', content: rawText.slice(0, 30000) }, // keep well within context limits
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
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
  return {
    title: parsed.title || '',
    subject: parsed.subject || '',
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
  }
}

const GENERATE_ANSWERS_SYSTEM_PROMPT = `You are given a list of exam questions that currently have
no model answer written for them (this usually happens when a lecturer uploaded a bare question
paper rather than a full marking scheme). Write a strong, exam-appropriate model answer for each
one, sized appropriately for its allocated marks, plus a short comma separated list of the key
terms or concepts that answer should contain.

Respond with ONLY a JSON object of this exact shape, nothing else, in the same order given:
{"answers": [{"index": 0, "modelAnswer": "...", "keywords": "..."}]}`

// questions: array of { index, number, subLabel, text, maxMarks } for just the questions that
// came back blank from parsing. Returns model answers for exactly those, to merge back in.
export async function generateModelAnswers(questions) {
  const questionsBlock = questions
    .map((q) => {
      const label = q.subLabel ? `Question ${q.number}${q.subLabel}` : `Question ${q.number}`
      return `Index: ${q.index}\n${label} (${q.maxMarks} marks): ${q.text}`
    })
    .join('\n\n')

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: GENERATE_ANSWERS_SYSTEM_PROMPT },
        { role: 'user', content: questionsBlock },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Groq API error (${res.status}): ${errText}`)
  }

  const data = await res.json()
  const content2 = data.choices?.[0]?.message?.content
  if (!content2) throw new Error('Groq returned an empty response.')

  const result = JSON.parse(content2)
  return Array.isArray(result.answers) ? result.answers : []
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