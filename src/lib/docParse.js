// Extracts plain text from a marking scheme or question paper a lecturer
// uploads, so it can be sent to Groq to parse into structured questions.
// Typed PDFs and Word files are read directly. Scanned PDFs (pages that are
// only a picture, with no text layer) and photos of the paper are read with
// the same Google Vision OCR used for answer scripts.
import * as mupdf from 'mupdf'
import mammoth from 'mammoth'
import JSZip from 'jszip'
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

// Upper bound on pages or pictures sent to the vision model to describe
// drawings, per upload. One call each; a guide rarely has more.
const MAX_FIGURES = 10
// A PDF page with at least this many drawn lines or shapes is treated as
// possibly holding a diagram drawn with shapes (Word drawings exported to
// PDF are vector shapes, not pictures). Tables also have lines; the vision
// model is told to ignore them.
const MIN_FIGURE_PATHS = 6

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

async function defaultDescribe(imageUrl, pageText) {
  const { describeGuideFigures } = await import('./groq.js')
  return describeGuideFigures(imageUrl, pageText)
}

// Returns { text, ocrPages, figures, wordShapes }. ocrPages is how many
// pages were read by OCR, 0 for a typed document.
//
// With options.figures (used for marking guides), drawings in the document
// are also described in words by the vision model and written into the
// text as "[DIAGRAM for 3(i): ...]" lines, so the guide parser can attach
// each description to its marking point. figures is how many drawings were
// described. wordShapes is true when a Word file has diagrams drawn with
// Word shapes, which cannot be read from the .docx (upload it as PDF).
export async function extractDocument(buffer, mimetype, { ocr = defaultOcr, figures = false, describe = defaultDescribe } = {}) {
  if (mimetype === 'application/pdf') {
    return extractFromPdf(buffer, ocr, figures ? describe : null)
  }
  if (WORD_TYPES.includes(mimetype)) {
    if (figures) return extractFromWordWithFigures(buffer, describe)
    const result = await mammoth.extractRawText({ buffer })
    return { text: result.value, ocrPages: 0, figures: 0, wordShapes: false }
  }
  if (mimetype && mimetype.startsWith('image/')) {
    let text = (await ocr(buffer)) || ''
    let count = 0
    if (figures) {
      const found = await describe(`data:${mimetype};base64,${buffer.toString('base64')}`, text)
      count = found.length
      if (found.length) text += '\n' + found.map(figureLine).join('\n')
    }
    return { text, ocrPages: 1, figures: count, wordShapes: false }
  }
  throw new Error('Please upload a PDF, Word (.docx) or image file.')
}

export function figureLine(f) {
  return `[DIAGRAM${f.question ? ` for ${f.question}` : ''}: ${f.description.replace(/\s+/g, ' ')}]`
}

// Kept for existing callers (class list upload) that only want the text.
export async function extractTextFromDocument(buffer, mimetype, options) {
  const { text } = await extractDocument(buffer, mimetype, options)
  return text
}

function readableChars(text) {
  return (text || '').replace(/\s+/g, '').length
}

// Counts what a PDF page draws: vector shapes (paths) and pictures.
function pageDrawing(page) {
  const counts = { paths: 0, images: 0 }
  const device = new mupdf.Device({
    fillPath() { counts.paths++ },
    strokePath() { counts.paths++ },
    fillImage() { counts.images++ },
    fillImageMask() { counts.images++ },
  })
  try {
    page.run(device, mupdf.Matrix.identity)
  } finally {
    device.close()
  }
  return counts
}

async function extractFromPdf(buffer, ocr, describe) {
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

  // Pages that may hold a drawing: scanned pages (a picture of the page may
  // include a hand drawn diagram), pages with pictures, and pages with
  // enough drawn shapes. Each goes to the vision model once.
  let figures = 0
  if (describe) {
    const candidates = []
    for (let i = 0; i < pageCount; i++) {
      if (scanned.includes(i)) { candidates.push(i); continue }
      const d = pageDrawing(doc.loadPage(i))
      if (d.images > 0 || d.paths >= MIN_FIGURE_PATHS) candidates.push(i)
    }
    await mapLimit(candidates.slice(0, MAX_FIGURES), OCR_CONCURRENCY, async (i) => {
      const pixmap = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB)
      const jpeg = Buffer.from(pixmap.asJPEG(85))
      const found = await describe(`data:image/jpeg;base64,${jpeg.toString('base64')}`, pages[i])
      figures += found.length
      if (found.length) pages[i] += '\n' + found.map(figureLine).join('\n')
    })
  }

  return { text: pages.join('\n\n'), ocrPages: scanned.length, figures, wordShapes: false }
}

// Word: pictures are pulled out in place with mammoth and each is described
// by the vision model where it sits in the text. Diagrams drawn with Word's
// own shapes, SmartArt or the drawing canvas are not pictures and cannot be
// rendered here, so they are only detected and reported.
async function extractFromWordWithFigures(buffer, describe) {
  const images = []
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const n = images.length
        images.push({ contentType: image.contentType, base64: await image.read('base64') })
        return { src: `figure:${n}` }
      }),
    }
  )

  // HTML to plain text, keeping a placeholder where each picture was.
  let text = html
    .replace(/<img[^>]*src="figure:(\d+)"[^>]*>/g, '\n[[FIGURE $1]]\n')
    .replace(/<\/(p|h[1-6]|li|tr)>/g, '\n')
    .replace(/<\/td>/g, '\t')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

  let figures = 0
  const usable = images.map((img, n) => ({ ...img, n })).filter((img) => /^image\/(png|jpe?g|gif|webp)$/.test(img.contentType || ''))
  const descriptions = new Map()
  await mapLimit(usable.slice(0, MAX_FIGURES), OCR_CONCURRENCY, async (img) => {
    // Text just before the picture tells the model which question it is under.
    const at = text.indexOf(`[[FIGURE ${img.n}]]`)
    const context = text.slice(Math.max(0, at - 1500), at)
    const found = await describe(`data:${img.contentType};base64,${img.base64}`, context)
    figures += found.length
    descriptions.set(img.n, found.map(figureLine).join('\n'))
  })
  text = text.replace(/\[\[FIGURE (\d+)\]\]/g, (_, n) => descriptions.get(Number(n)) || '')

  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), ocrPages: 0, figures, wordShapes: await hasWordShapes(buffer) }
}

// True when the document body contains Word shapes, SmartArt or a drawing
// canvas (wps, wpg, wpc, dgm, VML), the usual ways a diagram is drawn in Word.
async function hasWordShapes(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const body = await zip.file('word/document.xml')?.async('string')
    return /<(wps:wsp|wpg:wgp|wpc:wpc|v:shape|v:group|v:rect|v:line)\b|dgm:relIds/.test(body || '')
  } catch {
    return false
  }
}
