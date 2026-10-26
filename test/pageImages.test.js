// Tests for the PDF split: pages come out one at a time as colour JPEG, and
// memory does not grow with the page count. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mupdf from 'mupdf'
import { pageImages, PAGE_MIME_TYPE } from '../src/lib/pdfSplit.js'
import { mapLimit } from '../src/lib/mapLimit.js'

// A small PDF of `count` A4 pages, each with some text on it.
function makePdf(count) {
  const doc = new mupdf.PDFDocument()
  for (let i = 0; i < count; i++) {
    const font = doc.addSimpleFont(new mupdf.Font('Times-Roman'))
    const resources = doc.addObject({ Font: { F1: font } })
    const contents = `BT /F1 24 Tf 72 720 Td (Page ${i + 1} answer) Tj ET`
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, resources, contents))
  }
  const buf = doc.saveToBuffer('compress').asUint8Array()
  return Buffer.from(buf)
}

test('every page comes out as a JPEG, in order', () => {
  const pages = [...pageImages(makePdf(3))]
  assert.equal(pages.length, 3)
  assert.equal(PAGE_MIME_TYPE, 'image/jpeg')
  for (const p of pages) {
    // JPEG files start with FF D8 FF.
    assert.deepEqual([...p.subarray(0, 3)], [0xff, 0xd8, 0xff])
  }
})

test('pages are rendered only when asked for', () => {
  const pages = pageImages(makePdf(5))
  const first = pages.next()
  assert.equal(first.done, false)
  pages.return() // stopping early frees the document without rendering the rest
})

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let running = 0
  let most = 0
  const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
    running++
    most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, n * 3))
    running--
    return n * 10
  })
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0])
  assert.equal(most, 2)
})
