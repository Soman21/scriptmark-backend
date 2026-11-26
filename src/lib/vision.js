// Reads page images with the Gemini API. Replaces Google Cloud Vision, which
// needs a billing account. Keeps the same return shape ({ text, confidence })
// and adds `lines` with a box per line, so marked script ink can be placed.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_MODEL = 'gemini-3.5-flash'

const PROMPT = [
  'Read all the writing on this page of a handwritten exam script, top to bottom.',
  'Copy it exactly as written, including crossings out, numbers, symbols and spelling mistakes. Do not correct, summarise or add anything.',
  'Reply with JSON only: {"lines":[{"text":"...","box_2d":[ymin,xmin,ymax,xmax]}]}.',
  'One entry per written line. box_2d uses whole numbers from 0 to 1000 relative to the page (0,0 is top left).',
  'If the page has no writing, reply {"lines":[]}.',
].join(' ')

async function toImage(input) {
  if (Buffer.isBuffer(input)) return { data: input, mimeType: sniffMime(input) }
  const res = await fetch(input)
  if (!res.ok) throw new Error(`Could not download page image (${res.status})`)
  const data = Buffer.from(await res.arrayBuffer())
  const header = res.headers.get('content-type')
  return { data, mimeType: header && header.startsWith('image/') ? header.split(';')[0] : sniffMime(data) }
}

function sniffMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp'
  return 'image/jpeg'
}

function cleanBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null
  const [a, b, c, d] = box.map((n) => Math.min(1000, Math.max(0, Number(n))))
  if ([a, b, c, d].some((n) => Number.isNaN(n))) return null
  return { top: a / 1000, left: b / 1000, bottom: c / 1000, right: d / 1000 }
}

function parseLines(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('Gemini reply was not JSON')
    parsed = JSON.parse(raw.slice(start, end + 1))
  }
  const list = Array.isArray(parsed?.lines) ? parsed.lines : []
  return list
    .map((l) => ({ text: String(l?.text ?? '').trim(), box: cleanBox(l?.box_2d) }))
    .filter((l) => l.text)
}

export async function extractTextFromImage(imageUrl) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  const model = process.env.GEMINI_OCR_MODEL || DEFAULT_MODEL
  const image = await toImage(imageUrl)

  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inline_data: { mime_type: image.mimeType, data: image.data.toString('base64') } },
          ],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
  if (!raw) return { text: '', confidence: 0, lines: [] }

  const lines = parseLines(raw)
  const text = lines.map((l) => l.text).join('\n').trim()
  // Gemini gives no confidence score, so a fixed middling value is used and
  // the page still goes to review like any other read.
  return { text, confidence: text ? 0.8 : 0, lines }
}
