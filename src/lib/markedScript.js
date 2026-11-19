import PDFDocument from 'pdfkit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import prisma from './prisma.js'
import { findAnchors, findCover } from './markedLayout.js'
import { composeInk, inkItemsToShapes, movesFrom, pathOf, INK } from './markInk.js'
import { countedNumbers, ruleScore, studentMax } from './guideTotals.js'

// The handwriting font for the ink (Caveat, SIL Open Font License, see
// assets/fonts/Caveat-OFL.txt), embedded in every marked PDF.
const FONT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts/Caveat-Bold.ttf')

const isConfirmed = (a) => a.confirmedScore != null

// A part the student actually answered: the AI copied out an answer for it,
// or it has marks. The AI writes "Not answered" for parts left blank.
function answeredText(a, ocrText) {
  const text = (a.extractedText || '').trim()
  if (!text || text === (ocrText || '').trim()) return ''
  return text
}
function isAnswered(a, ocrText, score) {
  if (Number(score) > 0) return true
  if (/^\s*not answered/i.test(a.reasoning || '')) return false
  return Boolean(answeredText(a, ocrText))
}

// Everything the Marked view and the PDF need for one script.
// scores: 'confirmed' uses the saved scores (the PDF); the Marked view
// sends its own draft scores to composeInk in the browser.
export async function loadMarkedScript(scriptId) {
  const script = await prisma.script.findUnique({
    where: { id: scriptId },
    include: {
      pages: { orderBy: { pageNumber: 'asc' } },
      ink: true,
      answers: { include: { question: true } },
      session: { select: { id: true, title: true, guide: { select: { answerRule: true } } } },
    },
  })
  if (!script) return null
  const rule = script.session?.guide?.answerRule || null
  const pages = script.pages.length
    ? script.pages.map((p) => ({ pageNumber: p.pageNumber, imageUrl: p.imageUrl, lines: Array.isArray(p.ocrLines) ? p.ocrLines : null }))
    : script.imageUrl
    ? [{ pageNumber: 1, imageUrl: script.imageUrl, lines: null }]
    : []
  const answers = [...script.answers].sort(
    (a, b) => (a.question?.order ?? 0) - (b.question?.order ?? 0) || String(a.question?.number).localeCompare(String(b.question?.number), undefined, { numeric: true }) || String(a.question?.subLabel || '').localeCompare(String(b.question?.subLabel || ''))
  )
  const cover = pages.length > 1 ? findCover(pages[0].lines) : null
  const anchors = findAnchors(
    pages,
    answers.map((a) => ({ id: a.id, number: a.question?.number, subLabel: a.question?.subLabel, text: answeredText(a, script.ocrText) })),
    { skipPages: cover ? [pages[0].pageNumber] : [] }
  )
  const ink = {}
  for (const row of script.ink) ink[row.pageNumber] = row.items
  return {
    script,
    rule,
    pages,
    answers,
    anchors,
    cover,
    ink,
    hasPositions: pages.some((p) => p.lines && p.lines.length),
    ready: answers.length > 0 && answers.every(isConfirmed),
  }
}

// What the browser needs to draw the Marked view (no page text, only
// positions), plus each answer's answered flag.
export function markedViewJson(data) {
  const { script, pages, answers, anchors, cover, ink, hasPositions, ready, rule } = data
  return {
    scriptId: script.id,
    ready,
    hasPositions,
    missingPositions: pages.filter((p) => !p.lines).length,
    coverPage: pages[0]?.pageNumber ?? 1,
    pages: pages.map((p) => ({ pageNumber: p.pageNumber, imageUrl: p.imageUrl })),
    anchors,
    cover,
    ink,
    answerRule: rule,
    answered: Object.fromEntries(answers.map((a) => [a.id, isAnswered(a, script.ocrText, a.confirmedScore ?? a.suggestedScore)])),
  }
}

// The shapes to draw from the saved (confirmed) scores.
export function inkFromSaved(data, aspects) {
  const { script, pages, answers, anchors, cover, ink, rule } = data
  const scores = answers.map((a) => ({ number: a.question?.number, score: Number(a.confirmedScore ?? 0) }))
  const byNumber = new Map()
  for (const s of scores) byNumber.set(String(s.number ?? '').trim(), (byNumber.get(String(s.number ?? '').trim()) || 0) + s.score)
  const counted = countedNumbers(byNumber, rule)
  return composeInk({
    pages: pages.map((p) => ({ pageNumber: p.pageNumber, aspect: aspects.get(p.pageNumber) })),
    anchors,
    moves: movesFrom(ink),
    cover,
    coverPage: pages[0]?.pageNumber ?? 1,
    total: ruleScore(scores, rule),
    totalMax: studentMax(answers.map((a) => a.question || {}), rule),
    answers: answers.map((a) => ({
      id: a.id,
      number: a.question?.number,
      subLabel: a.question?.subLabel,
      score: a.confirmedScore ?? 0,
      max: a.question?.maxMarks ?? 0,
      remark: a.remark,
      answered: isAnswered(a, script.ocrText, a.confirmedScore),
      counted: counted.has(String(a.question?.number ?? '').trim()),
    })),
  })
}

async function fetchImage(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load a page image (${res.status}).`)
  return Buffer.from(await res.arrayBuffer())
}

const PAGE_WIDTH = 595.28 // A4 width in points

function drawShape(doc, shape, W) {
  if (shape.t === 'text') {
    const size = shape.size * W
    doc.save()
    doc.font('Hand').fontSize(size).fillColor(INK)
    const width = doc.widthOfString(shape.text)
    const x = shape.x * W - (shape.anchor === 'middle' ? width / 2 : shape.anchor === 'end' ? width : 0)
    const baseline = shape.y * W
    if (shape.rot) doc.rotate(shape.rot, { origin: [shape.x * W, baseline] })
    // pdfkit places text by its top; SVG and the shapes use the baseline.
    const ascent = (doc._font.ascender / 1000) * size
    doc.text(shape.text, x, baseline - ascent, { lineBreak: false })
    doc.restore()
    return
  }
  const cmds = pathOf(shape)
  if (!cmds.length) return
  doc.save()
  for (const c of cmds) {
    const v = c.slice(1).map((n) => n * W)
    if (c[0] === 'M') doc.moveTo(v[0], v[1])
    else if (c[0] === 'L') doc.lineTo(v[0], v[1])
    else if (c[0] === 'Q') doc.quadraticCurveTo(v[0], v[1], v[2], v[3])
    else if (c[0] === 'C') doc.bezierCurveTo(v[0], v[1], v[2], v[3], v[4], v[5])
  }
  doc.lineWidth((shape.w || (shape.t === 'line' ? 0.0026 : 0.0032)) * W).lineCap('round').lineJoin('round').strokeColor(INK).stroke()
  doc.restore()
}

// Adds one script's pages, with its ink, to an open PDF document.
export async function addMarkedScript(doc, data) {
  const images = []
  for (const p of data.pages) {
    const buffer = await fetchImage(p.imageUrl)
    const img = doc.openImage(buffer)
    images.push({ pageNumber: p.pageNumber, img })
  }
  const aspects = new Map(images.map(({ pageNumber, img }) => [pageNumber, img.height / img.width]))
  const { pages: shapes } = inkFromSaved(data, aspects)
  for (const { pageNumber, img } of images) {
    const W = PAGE_WIDTH
    const H = W * aspects.get(pageNumber)
    doc.addPage({ size: [W, H], margin: 0 })
    doc.image(img, 0, 0, { width: W, height: H })
    for (const s of shapes[pageNumber] || []) drawShape(doc, s, W)
    for (const s of inkItemsToShapes(data.ink[pageNumber], aspects.get(pageNumber))) drawShape(doc, s, W)
  }
}

export function newMarkedPdf(title) {
  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: title, Producer: 'ScriptMark' } })
  doc.registerFont('Hand', FONT)
  return doc
}

// "2021364080 ECE542 Marked.pdf". Only safe characters.
export function markedFileName(script, session, ext = 'pdf') {
  const who = script.regNumber || script.studentName || script.id
  const course = (session?.title || '').split(/[,\s]+/).slice(0, 2).join('')
  return `${who} ${course} Marked`.replace(/[^A-Za-z0-9 ._()]/g, '').replace(/\s+/g, ' ').trim() + `.${ext}`
}

// Collects a finished PDF into a Buffer (used for zip files).
export function pdfBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
}
