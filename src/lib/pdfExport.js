import PDFDocument from 'pdfkit'

// Widths by column key; the columns themselves come from RESULT_COLUMNS.
const WIDTHS = { name: 130, regNumber: 90, ca: 45, exam: 50, total: 40, grade: 40, note: 120 }
const LEFT_MARGIN = 40
const ROW_HEIGHT = 22

function drawTableHeader(doc, y, columns) {
  let x = LEFT_MARGIN
  doc.font('Helvetica-Bold').fontSize(10)
  columns.forEach(([key, label]) => {
    doc.text(label, x, y, { width: WIDTHS[key] })
    x += WIDTHS[key]
  })
  doc
    .moveTo(LEFT_MARGIN, y + 16)
    .lineTo(LEFT_MARGIN + columns.reduce((sum, [key]) => sum + WIDTHS[key], 0), y + 16)
    .stroke()
  doc.font('Helvetica').fontSize(10)
  return y + ROW_HEIGHT
}

export function writeResultsPdf(res, session, columns, rows) {
  const doc = new PDFDocument({ margin: LEFT_MARGIN, size: 'A4' })
  doc.pipe(res)

  doc.font('Helvetica-Bold').fontSize(18).text(session.title)
  doc.font('Helvetica').fontSize(11)
  doc.text(`Department: ${session.department || 'Not set'}`)
  doc.text(`Faculty: ${session.faculty || 'Not set'}`)
  doc.moveDown(1)

  let y = drawTableHeader(doc, doc.y, columns)
  const pageBottom = doc.page.height - doc.page.margins.bottom

  rows.forEach((row) => {
    if (y + ROW_HEIGHT > pageBottom) {
      doc.addPage()
      y = drawTableHeader(doc, doc.page.margins.top, columns)
    }
    let x = LEFT_MARGIN
    columns.forEach(([key]) => {
      const value = row[key]
      doc.text(value == null ? '' : String(value), x, y, { width: WIDTHS[key] })
      x += WIDTHS[key]
    })
    y += ROW_HEIGHT
  })

  doc.end()
}
