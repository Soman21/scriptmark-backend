// Uses Groq's free, OpenAI-compatible API to run an open-source LLM
// for suggesting scores. This is ALWAYS a suggestion — a human lecturer/reviewer
// must confirm the score before it counts (see results.js "/confirm" route).

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'openai/gpt-oss-120b' // llama-3.3-70b-versatile was deprecated and decommissioned by Groq on August 16, 2026; this is their recommended 1:1 replacement

// Vision capable model, used ONLY for calculation heavy questions (see
// transcribeCalculationFromImage below). Standard OCR (Google Vision) is
// unreliable on mathematical notation, fractions, exponents, and multi step
// working, so flagged questions get a second look from this model against
// the actual page image instead of the OCR text. Kept as a separate constant
// from MODEL since it is a different model on the same free Groq account.
const VISION_MODEL = 'qwen/qwen3.8-27b'

const SYSTEM_PROMPT = `You are an assistant that helps a human lecturer grade exam scripts.
You NEVER assign a final grade — you only suggest a score and explain your reasoning.
A human always reviews and confirms the score afterward.

Some questions are split into subparts (e.g. "Question 1a", "Question 1b") — treat each
subpart as its own separate item to score, using its own max marks.

For each question given, read the student's extracted answer text and compare it to the
model answer and keywords. Judge conceptual correctness, not exact wording match.

Some questions include a STEP RUBRIC: a list of specific steps, each with its own marks,
that together add up to the question's max marks. When a question has a step rubric, do
not give one holistic score — instead judge each step separately against what the student
wrote, decide how many of that step's marks to award, and give a short reason for each
step's award. The question's suggestedScore is then the sum of the marks you awarded
across its steps. This lets a student earn credit for correct working even when a later
step or the final answer is wrong. Questions with no step rubric are scored holistically
as before.

For each question, also copy out the specific portion of the student's text that answers
THAT question (not the whole script) — this lets a human reviewer see exactly what you
scored, side by side with the expected answer.

Also rate your own confidence in the suggested score as "high", "medium", or "low".
Use "low" whenever the student's answer is ambiguous, the OCR text looks garbled or
incomplete, or the question and answer are hard to match up confidently.

Respond with ONLY a JSON object of this exact shape, and nothing else. Omit "stepBreakdown"
entirely for a question that has no step rubric; include it, with one entry per step in the
same order given, ONLY for a question that has one:
{"results": [{"questionId": "the question's id", "suggestedScore": number, "answerText": "the relevant portion of the student's text for this question", "confidence": "high" | "medium" | "low", "reasoning": "a short, specific explanation", "stepBreakdown": [{"description": "the step as given", "marks": number, "awarded": number, "reasoning": "short reason for this step's award"}]}]}`

// questions: array of { id, number, subLabel, text, modelAnswer, keywords, maxMarks, steps? }
// steps, when present, is an array of { description, marks } that should sum to maxMarks.
// ocrText: the full text extracted from the student's script via OCR (already substituted
// with the vision model's re transcription for any calculation heavy question, see
// transcribeCalculationFromImage — this function itself does not know or care which).
export async function scoreScriptAgainstGuide(ocrText, questions) {
  const questionsBlock = questions
    .map((q) => {
      const label = q.subLabel ? `Question ${q.number}${q.subLabel}` : `Question ${q.number}`
      const stepsBlock =
        Array.isArray(q.steps) && q.steps.length > 0
          ? `\nStep Rubric:\n${q.steps.map((s, i) => `  ${i + 1}. ${s.description} (${s.marks} marks)`).join('\n')}`
          : ''
      return `Question ID: ${q.id}\n${label}: ${q.text}\nModel Answer: ${q.modelAnswer}\nKeywords: ${q.keywords}\nMax Marks: ${q.maxMarks}${stepsBlock}`
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

// Re transcribes a calculation heavy question's answer directly from the page
// image(s), since standard OCR reliably mangles fractions, exponents, and
// multi step working. Only called for questions flagged isCalculationHeavy.
// imageUrls: array of page image URLs covering (at least) the pages this
// question's answer appears on. questionContext: { text, maxMarks } for the
// question being re transcribed, so the model knows what it's looking for.
// Returns the re transcribed text, or null if nothing usable came back —
// callers should fall back to the original OCR text in that case rather than
// treating a null as an empty answer.
export async function transcribeCalculationFromImage(imageUrls, questionContext) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return null

  const systemPrompt = `You are given page image(s) from a handwritten exam script, for a single
calculation heavy question. Standard OCR often mangles mathematical notation such as
fractions, exponents, square roots, and multi step working, so you are asked to read the
image directly instead.

Transcribe ONLY the student's working and answer for the question described below, as
plain text. Represent mathematical notation in a readable plain text form (e.g. write a
fraction as "a/b", an exponent as "x^2", a square root as "sqrt(x)"), preserving every
step of the working in the order written, not just the final answer. Do not solve the
problem, correct the student's working, or add anything the student did not write. If the
image is unreadable or does not contain this question's answer, respond with an empty
transcript rather than guessing.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"transcript": "the re transcribed working and answer, or empty string if unreadable"}`

  const userContent = [
    {
      type: 'text',
      text: `Question (${questionContext?.maxMarks ?? '?'} marks): ${questionContext?.text ?? ''}`,
    },
    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]

  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      console.error(`Groq vision API error (${res.status}):`, await res.text())
      return null
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) return null

    const parsed = JSON.parse(content)
    const transcript = typeof parsed.transcript === 'string' ? parsed.transcript.trim() : ''
    return transcript || null
  } catch (err) {
    console.error('Vision transcription failed:', err)
    return null
  }
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
- "isCalculationHeavy" is true if answering the question mainly involves numeric
  calculation or mathematical working, such as solving an equation, evaluating a formula,
  or a multi step derivation, where a student's handwritten answer would contain
  fractions, exponents, or similar notation. It is false for questions answered mainly in
  prose, definitions, or short factual statements, even within a technical subject.
- Ignore headers, footers, page numbers, and instructions not part of a specific question.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"title": "a short title for this guide, guessed from the document", "subject": "the subject or course name if mentioned, else null", "questions": [{"number": "1", "subLabel": null, "text": "...", "modelAnswer": "...", "keywords": "...", "maxMarks": 10, "isCalculationHeavy": false}]}`

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

const PARSE_CLASS_LIST_SYSTEM_PROMPT = `You are given text from a document listing students — either a typed
official class list, or the text as read from a handwritten exam attendance sheet filled in by
students on the day of an exam, in pen. Either way, extract every distinct student row you can find.

A row is usable only if it has BOTH a name and a registration number — skip a row with just one
of the two rather than guessing the other. Reg numbers commonly look like "2021/123456" but the
exact format varies, extract whatever is actually written even if it looks unusual, do not
reformat or correct it. Ignore headers, column titles, page numbers, and signature columns.

Respond with ONLY a JSON object of this exact shape, nothing else:
{"students": [{"name": "...", "regNumber": "..."}]}`

// rawText: either typed document text (docParse) or OCR'd attendance sheet text (vision).
// The prompt above is written to work for either without needing to know which.
export async function parseClassList(rawText) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: PARSE_CLASS_LIST_SYSTEM_PROMPT },
        { role: 'user', content: rawText.slice(0, 30000) },
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
  return Array.isArray(parsed.students) ? parsed.students : []
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


const ASSISTANT_SYSTEM_PROMPT = `You are the ScriptMark AI Assistant, built into an exam script marking
system used by lecturers, reviewers, and admins at a Nigerian university.

ScriptMark lets a lecturer: create marking guides with numbered questions (which can have lettered
subparts like 1a, 1b, some with a calculation-heavy flag or a step-by-step marking rubric), start a
marking session for a course/exam, scan or photograph student scripts, which get digitized with OCR,
then scored by an LLM, which a human always reviews and confirms before it counts. A session can also
have a class list / attendance roster uploaded, which corrects OCR-guessed student names and reg
numbers by matching on reg number. Results can be exported as Excel or PDF once any name conflicts in
the roster are resolved.

You have tools available to look up REAL data: a lecturer or reviewer's own sessions, a session's
marking progress, a specific student's scores, a guide's questions, a session's analytics, and you can
prepare a result sheet export. Use a tool whenever answering the question accurately requires real
data you don't already have in the conversation — never guess or make up scores, counts, or names.
If a question could refer to more than one session and it isn't clear which, ask which one rather
than guessing, and prefer the session mentioned in <activeSession> below if one is given and the
person doesn't specify otherwise. Some tools require a session id you get by first calling
list_sessions, or by using the id given in <activeSession>.

You are read-only over grading data: you can look things up and explain them, and you can draft
suggested marking-guide questions, model answers, or keywords for the lecturer to review, but you can
never confirm a score, resolve a roster name conflict, or otherwise save anything on the lecturer's
behalf — those stay human actions, exactly as everywhere else in ScriptMark. If a lecturer asks you to
do one of these, tell them plainly you can't, and point them to where in the app they do it themselves
(Results page for scores, the class list review panel for name conflicts).

If you're missing information you need to answer well, for example which course or session someone
means, or a student's name or reg number, ask for it directly rather than guessing.

Beyond the app itself, you can also help with general educational questions, and can walk a lecturer
through how to do something in ScriptMark, including drafting a marking guide's questions and model
answers for them to review and save themselves in the guide builder. Answer plainly and at whatever
length actually answers the question well, rather than being needlessly brief.`

const ASSISTANT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description:
        "Lists the marking sessions the current user can see (their own, plus any they're an approved marker on). Use this first if you don't already know a session's id.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_session_progress',
      description:
        'Returns marking progress for one session: how many scripts total, how many digitized/scored/reviewed, how many flagged for low confidence, and how many have an unresolved roster name conflict.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'The session id, from list_sessions or <activeSession>.' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_student',
      description:
        "Finds a student's script(s) by name or reg number (partial match is fine), across sessions the user can see, or within one session if sessionId is given. Returns each match's session, status, and per-question scores.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A student name or reg number, or part of one.' },
          sessionId: { type: 'string', description: 'Optional, narrows the search to one session.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_guide_questions',
      description: "Returns a session's marking guide questions: text, max marks, whether calculation-heavy, and step rubric if any.",
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_analytics',
      description: 'Returns class-level analytics for a session: average score, score distribution, and per-question average performance.',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'prepare_export',
      description:
        "Checks whether a session's results are ready to export (no unresolved roster name conflicts) and, if so, signals the app to show the lecturer a download button. Does not itself return a file.",
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          format: { type: 'string', enum: ['xlsx', 'pdf', 'both'], description: 'Defaults to both if not specified.' },
        },
        required: ['sessionId'],
      },
    },
  },
]

// One Groq round trip, returning the raw assistant message (which may carry
// tool_calls instead of, or alongside, content) so the caller can execute
// tools and loop. Kept separate from the tool-execution loop itself, which
// needs Prisma access and therefore lives in the assistant route, not here.
export async function chatWithAssistantTools(messages) {
  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }, ...messages],
      tools: ASSISTANT_TOOLS,
      temperature: 0.6,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Groq API error (${res.status}): ${errText}`)
  }

  const data = await res.json()
  const message = data.choices?.[0]?.message
  if (!message) throw new Error('Groq returned an empty response.')
  return message
}