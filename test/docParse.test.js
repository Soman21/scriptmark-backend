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

// Drawings in a guide: pages with shapes or pictures go to the vision model
// (faked here) and its description is written into the text.
test('guide figures: a page with a drawn block diagram is described', async () => {
  const buf = await pdf((d) => {
    d.text('1. Define a signal. Analog Signals (1.25 Marks)')
    d.addPage().text('3 (i) Draw the block diagram of a communication system.')
    ;['Source', 'Encoder', 'Channel', 'Decoder', 'Sink'].forEach((b, i) => {
      d.rect(50 + i * 100, 150, 80, 40).stroke()
      if (i < 4) d.moveTo(130 + i * 100, 170).lineTo(150 + i * 100, 170).stroke()
    })
  })
  const seen = []
  const describe = async (url, pageText) => {
    seen.push(pageText)
    assert.match(url, /^data:image\/jpeg;base64,/)
    return [{ question: '3(i)', description: 'Five boxes, Source to Sink, arrows left to right.' }]
  }
  const out = await extractDocument(buf, 'application/pdf', { figures: true, describe, ocr: async () => '' })
  assert.equal(seen.length, 1)
  assert.match(seen[0], /block diagram/)
  assert.equal(out.figures, 1)
  assert.match(out.text, /\[DIAGRAM for 3\(i\): Five boxes, Source to Sink, arrows left to right\.\]/)
})

test('guide figures: off unless asked, and plain text pages are not sent', async () => {
  const buf = await pdf((d) => d.text(QUESTION))
  let calls = 0
  const describe = async () => { calls++; return [] }
  await extractDocument(buf, 'application/pdf', { describe })
  await extractDocument(buf, 'application/pdf', { figures: true, describe })
  assert.equal(calls, 0)
})

// A typed heading above a pasted photo of the answers: the page has text,
// so it does not look scanned, but the picture must still be read.
test('a page that is mostly a picture is read with OCR even with a typed heading', async () => {
  const img = await pageImage('1b. Answers continue here')
  const buf = await pdf((d) => {
    d.text('538 Data Communication. Marking Guide. Second Semester Examination.', 50, 30)
    d.image(img, 0, 80, { width: 595 })
  })
  let calls = 0
  const out = await extractDocument(buf, 'application/pdf', {
    ocr: async () => { calls++; return '538 Data Communication. Marking Guide. 2a. Simplex is one way. 2b. Half duplex takes turns.' },
  })
  assert.equal(calls, 1)
  assert.equal(out.ocrPages, 1)
  assert.match(out.text, /2b\. Half duplex/)
})

test('a typed page with a small picture keeps its typed text', async () => {
  const img = await pageImage('logo')
  const buf = await pdf((d) => {
    d.image(img, 50, 30, { width: 60 })
    d.text(QUESTION, 50, 120)
  })
  let calls = 0
  const out = await extractDocument(buf, 'application/pdf', { ocr: async () => { calls++; return 'x' } })
  assert.equal(calls, 0)
  assert.match(out.text, /Ohm's law/)
})

// Smallest .docx with one paragraph, one picture, one more paragraph.
async function docxWithPicture(before, png, after) {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  zip.file('word/media/image1.png', png)
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
<w:p><w:r><w:t>${before}</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5000000" cy="3000000"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>${after}</w:t></w:r></w:p>
</w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('Word guide: a pasted picture of answers is read with OCR in place', async () => {
  const png = await pageImage('answers')
  const buf = await docxWithPicture('1a. Analog signals are continuous.', png, '3. Draw a block diagram.')
  const out = await extractDocument(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', {
    figures: true,
    describe: async () => [],
    ocr: async () => '2a. Simplex is one way only. 2b. Half duplex takes turns.',
  })
  assert.equal(out.ocrPages, 1)
  assert.match(out.text, /1a\. Analog[\s\S]*2b\. Half duplex[\s\S]*3\. Draw/)
})
