// Extracts plain text from a marking scheme or question paper a lecturer
// uploads, so it can be sent to Groq to parse into structured questions.
// Typed PDFs and Word files are read directly. Scanned PDFs (pages that are
// only a picture, with no text layer) and photos of the paper are read with
// the same Google Vision OCR used for answer scripts.
import * as mupdf from 'mupdf'
import mammoth from 'mammoth'
import { mapLimit } from './mapLimit.js'

// A page with fewer readable characters than this in its text layer is
// treated as scanned. Scanned PDFs sometimes carry a page number or a
// scanner stamp as real text, so "no text at all" is too strict a test.
const MIN_TEXT_CHARS = 25
// Upper bound on scanned pages sent to OCR for one upload. A question paper
// or marking guide is a few pages; this stops a wrong file (a whole bundle
// of scripts) from running up the OCR bill.
const MAX_OCR_PAGES = 30
const OCR_CONCURRENCY = 4
// Render at 2x (about 144 dpi), the same scale used for answer script pages.
const RENDER_SCALE = 2

const WORD_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]

// Loaded on first use only, because vision.js reads Google credentials at
// import time and typed documents never need it.
async function defaultOcr(buffer) {
  const { extractTextFromImage } = await import('./vision.js')
  const { text } = await extractTextFromImage(buffer)
  return text
}

// Returns { text, ocrPages }. ocrPages is how many pages were read by OCR,
// 0 for a typed document.
export async function extractDocument(buffer, mimetype, { ocr = defaultOcr } = {}) {
  if (mimetype === 'application/pdf') {
    return extractFromPdf(buffer, ocr)
  }
  if (WORD_TYPES.includes(mimetype)) {
    const result = await mammoth.extractRawText({ buffer })
    return { text: result.value, ocrPages: 0 }
  }
  if (mimetype && mimetype.startsWith('image/')) {
    return { text: (await ocr(buffer)) || '', ocrPages: 1 }
  }
  throw new Error('Please upload a PDF, Word (.docx) or image file.')
}

// Kept for existing callers (class list upload) that only want the text.
export async function extractTextFromDocument(buffer, mimetype, options) {
  const { text } = await extractDocument(buffer, mimetype, options)
  return text
}

function readableChars(text) {
  return (text || '').replace(/\s+/g, '').length
}

async function extractFromPdf(buffer, ocr) {
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf')
  const pageCount = doc.countPages()
  const pages = []
  const scanned = []
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i)
    const text = page.toStructuredText('preserve-whitespace').asText()
    pages.push(text)
    if (readableChars(text) < MIN_TEXT_CHARS) scanned.push(i)
  }

  if (scanned.length > MAX_OCR_PAGES) {
    throw new Error(`This file has ${scanned.length} scanned pages. Upload at most ${MAX_OCR_PAGES}.`)
  }

  // Render each scanned page to an image and OCR it, a few at a time.
  // Pages that already had a text layer keep it, so a typed paper with one
  // scanned diagram page still reads correctly.
  await mapLimit(scanned, OCR_CONCURRENCY, async (i) => {
    const pixmap = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB)
    const png = Buffer.from(pixmap.asPNG())
    const text = await ocr(png)
    if (readableChars(text) > readableChars(pages[i])) pages[i] = text
  })

  return { text: pages.join('\n\n'), ocrPages: scanned.length }
}
