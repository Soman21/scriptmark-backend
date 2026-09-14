// Extracts plain text from a marking scheme document a lecturer uploads, so
// it can be sent to Groq to parse into structured questions. This is direct
// text extraction from a native digital document, NOT OCR, since a marking
// scheme is typed, not a scanned handwritten script.
import * as mupdf from 'mupdf'
import mammoth from 'mammoth'

export async function extractTextFromDocument(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    return extractTextFromPdf(buffer)
  }
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  }
  throw new Error('Please upload a PDF or Word (.docx) document.')
}

function extractTextFromPdf(buffer) {
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf')
  const pageCount = doc.countPages()
  const pages = []
  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i)
    const structuredText = page.toStructuredText('preserve-whitespace')
    pages.push(structuredText.asText())
  }
  return pages.join('\n\n')
}