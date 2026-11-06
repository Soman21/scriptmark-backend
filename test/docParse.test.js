import { test } from 'node:test'
import assert from 'node:assert/strict'
import PDFDocument from 'pdfkit'
import * as mupdf from 'mupdf'
import { extractDocument } from '../src/lib/docParse.js'

function pdf(build) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    build(doc)
    doc.end()
  })
}

// A picture of a typed page, with no text layer, like a scanner produces.
async function pageImage(text) {
  const typed = await pdf((d) => d.fontSize(18).text(text, 72, 72))
  const page = mupdf.Document.openDocument(typed, 'application/pdf').loadPage(0)
  return Buffer.from(page.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB).asPNG())
}

const QUESTION = '1a. Define Ohm\'s law and state its limitations. (5 marks)'

test('typed PDF is read directly, no OCR', async () => {
  const buf = await pdf((d) => d.text(QUESTION))
  let calls = 0
  const out = await extractDocument(buf, 'application/pdf', { ocr: async () => { calls++; return '' } })
  assert.match(out.text, /Ohm's law/)
  assert.equal(out.ocrPages, 0)
  assert.equal(calls, 0)
})

test('scanned PDF pages are rendered and sent to OCR', async () => {
  const img = await pageImage(QUESTION)
  const buf = await pdf((d) => {
    d.image(img, 0, 0, { width: 595 })
    d.addPage().image(img, 0, 0, { width: 595 })
  })
  const seen = []
  const out = await extractDocument(buf, 'application/pdf', {
    ocr: async (png) => { seen.push(png.subarray(1, 4).toString()); return `OCR page ${seen.length}: ${QUESTION}` },
  })
  assert.equal(out.ocrPages, 2)
  assert.deepEqual(seen, ['PNG', 'PNG'])
  assert.match(out.text, /OCR page 1/)
  assert.match(out.text, /OCR page 2/)
})

test('mixed PDF only OCRs the scanned page', async () => {
  const img = await pageImage(QUESTION)
  const buf = await pdf((d) => {
    d.text('Section A. Answer all questions in this section carefully.')
    d.addPage().image(img, 0, 0, { width: 595 })
  })
  const out = await extractDocument(buf, 'application/pdf', { ocr: async () => 'from scan' })
  assert.equal(out.ocrPages, 1)
  assert.match(out.text, /Section A/)
  assert.match(out.text, /from scan/)
})

test('photo of a paper goes straight to OCR', async () => {
  const out = await extractDocument(Buffer.from('jpg'), 'image/jpeg', { ocr: async () => QUESTION })
  assert.equal(out.ocrPages, 1)
  assert.equal(out.text, QUESTION)
})

test('unsupported file type is refused', async () => {
  await assert.rejects(extractDocument(Buffer.from('x'), 'text/plain'), /PDF, Word/)
})
