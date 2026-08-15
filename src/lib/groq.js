// Uses Groq's free, OpenAI-compatible API to run an open-source LLM (Llama 3.3 70B)
// for suggesting scores. This is ALWAYS a suggestion — a human lecturer/reviewer
// must confirm the score before it counts (see results.js "/confirm" route).

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = 'llama-3.3-70b-versatile'

const SYSTEM_PROMPT = `You are an assistant that helps a human lecturer grade exam scripts.
You NEVER assign a final grade — you only suggest a score and explain your reasoning.
A human always reviews and confirms the score afterward.

Some questions are split into sub-parts (e.g. "Question 1a", "Question 1b") — treat each
sub-part as its own separate item to score, using its own max marks.

For each question given, read the student's extracted answer text and compare it to the
model answer and keywords. Judge conceptual correctness, not exact wording match.

Respond with ONLY a JSON object of this exact shape, and nothing else:
{"results": [{"questionId": "the question's id", "suggestedScore": number, "reasoning": "a short, specific explanation"}]}`

// questions: array of { id, text, modelAnswer, keywords, maxMarks }
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