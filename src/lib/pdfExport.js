import PDFDocument from 'pdfkit'
import { computeGrade } from './grading.js'

const COLUMNS = [
  { label: 'Student Name', width: 150 },
  { label: 'Reg Number', width: 110 },
  { label: 'CA Score', width: 70 },
  { label: 'Exam Score', width: 80 },
  { label: 'Total', width: 60 },
  { label: 'Grade', width: 55 },
]
const LEFT_MARGIN = 40
const ROW_HEIGHT = 22

function drawTableHeader(doc, y) {
  let x = LEFT_MARGIN
  doc.font('Helvetica-Bold').fontSize(10)
  COLUMNS.forEach((col) => {
    doc.text(col.label, x, y, { width: col.width })
    x += col.width
  })
  doc
    .moveTo(LEFT_MARGIN, y + 16)
    .lineTo(LEFT_MARGIN + COLUMNS.reduce((sum, c) => sum + c.width, 0), y + 16)
    .stroke()
  doc.font('Helvetica').fontSize(10)
  return y + ROW_HEIGHT
}

// Writes a results report as a PDF directly to the given writable stream (res).
export function writeResultsPdf(res, session, scripts) {
  const doc = new PDFDocument({ margin: LEFT_MARGIN, size: 'A4' })
  doc.pipe(res)

  doc.font('Helvetica-Bold').fontSize(18).text(session.title)
  doc.font('Helvetica').fontSize(11)
  doc.text(`Department: ${session.department || '—'}`)
  doc.text(`Faculty: ${session.faculty || '—'}`)
  doc.moveDown(1)

  let y = doc.y
  y = drawTableHeader(doc, y)

  const pageBottom = doc.page.height - doc.page.margins.bottom

  scripts.forEach((s) => {
    if (y + ROW_HEIGHT > pageBottom) {
      doc.addPage()
      y = doc.page.margins.top
      y = drawTableHeader(doc, y)
    }

    const examScore = s.totalScore ?? null
    const ca = s.caScore ?? null
    const total = examScore != null ? examScore + (ca || 0) : null
    const grade = examScore != null ? computeGrade(total) : ''

    let x = LEFT_MARGIN
    const rowValues = [
      s.studentName || s.studentIdentifier || 'Unnamed',
      s.regNumber || '—',
      ca != null ? String(ca) : '—',
      examScore != null ? String(examScore) : '—',
      total != null ? String(total) : '—',
      grade || '—',
    ]
    rowValues.forEach((value, i) => {
      doc.text(value, x, y, { width: COLUMNS[i].width })
      x += COLUMNS[i].width
    })
    y += ROW_HEIGHT
  })

  doc.end()
}
