import express from 'express'
import JSZip from 'jszip'
import { Prisma } from '@prisma/client'
import prisma from '../lib/prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { canAccessScript, canAccessSession } from '../lib/access.js'
import { loadMarkedScript, markedViewJson, addMarkedScript, newMarkedPdf, markedFileName, pdfBuffer } from '../lib/markedScript.js'
import { mapLimit } from '../lib/mapLimit.js'

// Marked scripts: the student's pages with the marks in red ink. The PDF is
// never stored. It is drawn from the confirmed scores each time it is asked
// for, so it always matches Results; the page images are never changed.
const router = express.Router()
router.use(requireAuth)

// How many scripts go into one download. Render's free plan has 512 MB of
// memory; each script is about 5 MB of page images, held while its file is
// made, so the browser asks for a class in groups of this size.
export const SCRIPTS_PER_DOWNLOAD = 10

async function scriptFor(req, res) {
  const { script, session } = await canAccessScript(prisma, req.user, req.params.id)
  if (!script) {
    res.status(404).json({ error: 'Script not found.' })
    return null
  }
  if (!session) {
    res.status(403).json({ error: 'You do not have permission to view this script.' })
    return null
  }
  return script
}

// GET /api/marked/scripts/:id - what the Marked view draws: page images,
// where each mark goes, the cover layout and the lecturer's own ink.
router.get('/scripts/:id', async (req, res) => {
  try {
    if (!(await scriptFor(req, res))) return
    res.json(markedViewJson(await loadMarkedScript(req.params.id)))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not load the marked script.' })
  }
})

// GET /api/marked/scripts/:id/pdf - the marked script as a PDF. ?inline=1
// opens it in the browser (for Print) instead of saving it.
router.get('/scripts/:id/pdf', async (req, res) => {
  try {
    if (!(await scriptFor(req, res))) return
    const data = await loadMarkedScript(req.params.id)
    if (!data.ready) return res.status(409).json({ error: 'Confirm all scores first.' })
    const doc = newMarkedPdf(markedFileName(data.script, data.script.session))
    await addMarkedScript(doc, data)
    const name = markedFileName(data.script, data.script.session)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${name}"`)
    doc.pipe(res)
    doc.end()
  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.status(500).json({ error: 'Could not make the marked script: ' + err.message })
    else res.end()
  }
})

const KINDS = new Set(['pen', 'text', 'tick', 'cross', 'move'])
const frac = (n) => Math.min(1, Math.max(0, Math.round(Number(n) * 10000) / 10000 || 0))

// Keeps only well formed ink items, with numbers rounded and in range.
export function cleanInk(items) {
  if (!Array.isArray(items)) return null
  const out = []
  for (const it of items.slice(0, 1000)) {
    if (!it || !KINDS.has(it.k)) continue
    if (it.k === 'pen') {
      const pts = Array.isArray(it.pts) ? it.pts.slice(0, 2000).map((p) => [frac(p?.[0]), frac(p?.[1])]) : []
      if (pts.length >= 2) out.push({ k: 'pen', pts, w: Math.min(0.02, Math.max(0.001, Number(it.w) || 0.0035)) })
    } else if (it.k === 'text') {
      const t = String(it.t || '').trim().slice(0, 200)
      if (t) out.push({ k: 'text', x: frac(it.x), y: frac(it.y), t })
    } else if (it.k === 'move') {
      if (typeof it.a === 'string' && it.a) out.push({ k: 'move', a: it.a.slice(0, 40), x: frac(it.x), y: frac(it.y) })
    } else {
      out.push({ k: it.k, x: frac(it.x), y: frac(it.y) })
    }
  }
  return out
}

// PUT /api/marked/scripts/:id/ink/:page - body: { items }. Replaces the
// lecturer's ink on that page. An empty list clears it.
router.put('/scripts/:id/ink/:page', async (req, res) => {
  try {
    const script = await scriptFor(req, res)
    if (!script) return
    const pageNumber = Number(req.params.page)
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return res.status(400).json({ error: 'Unknown page.' })
    const items = cleanInk(req.body?.items)
    if (!items) return res.status(400).json({ error: 'items must be a list.' })
    const key = { scriptId_pageNumber: { scriptId: script.id, pageNumber } }
    if (items.length === 0) {
      await prisma.scriptInk.deleteMany({ where: { scriptId: script.id, pageNumber } })
    } else {
      await prisma.scriptInk.upsert({
        where: key,
        create: { scriptId: script.id, pageNumber, items, updatedById: req.user.id },
        update: { items, updatedById: req.user.id },
      })
    }
    res.json({ pageNumber, items })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not save the ink.' })
  }
})

// POST /api/marked/scripts/:id/readPositions - for scripts read before
// positions were kept: reads the pages again with Google Vision (one call
// per page with no positions) so marks can sit beside the answers. Never
// automatic, since it uses the Vision allowance.
router.post('/scripts/:id/readPositions', async (req, res) => {
  try {
    const script = await scriptFor(req, res)
    if (!script) return
    const { extractTextFromImage } = await import('../lib/vision.js')
    const pages = await prisma.scriptPage.findMany({ where: { scriptId: script.id, ocrLines: { equals: Prisma.DbNull } } })
    await mapLimit(pages, 4, async (page) => {
      const result = await extractTextFromImage(page.imageUrl)
      await prisma.scriptPage.update({ where: { id: page.id }, data: { ocrLines: result.lines } })
    })
    res.json(markedViewJson(await loadMarkedScript(script.id)))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not read the page positions: ' + err.message })
  }
})

// GET /api/marked/sessions/:id/ready - every script in the session and
// whether all its scores are confirmed (only those can be downloaded).
router.get('/sessions/:id/ready', async (req, res) => {
  try {
    if (!(await canAccessSession(prisma, req.user, req.params.id))) {
      return res.status(403).json({ error: 'You do not have permission to view this session.' })
    }
    const scripts = await prisma.script.findMany({
      where: { sessionId: req.params.id, answers: { some: {} } },
      select: { id: true, studentName: true, regNumber: true, answers: { select: { confirmedScore: true } } },
      orderBy: [{ regNumber: 'asc' }, { uploadedAt: 'asc' }],
    })
    res.json({
      perDownload: SCRIPTS_PER_DOWNLOAD,
      scripts: scripts.map((s) => ({
        id: s.id,
        studentName: s.studentName,
        regNumber: s.regNumber,
        ready: s.answers.every((a) => a.confirmedScore != null),
      })),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Could not list the marked scripts.' })
  }
})

// POST /api/marked/sessions/:id/download - body: { scriptIds, format }.
// format 'separate': a zip with one PDF per student. 'combined': one PDF
// with the scripts one after another, for printing. At most
// SCRIPTS_PER_DOWNLOAD scripts; scripts not fully confirmed are skipped.
router.post('/sessions/:id/download', async (req, res) => {
  try {
    const session = await canAccessSession(prisma, req.user, req.params.id)
    if (!session) return res.status(403).json({ error: 'You do not have permission to view this session.' })
    const ids = Array.isArray(req.body?.scriptIds) ? [...new Set(req.body.scriptIds.map(String))] : []
    if (ids.length === 0) return res.status(400).json({ error: 'No scripts chosen.' })
    if (ids.length > SCRIPTS_PER_DOWNLOAD) return res.status(400).json({ error: `At most ${SCRIPTS_PER_DOWNLOAD} scripts per download.` })
    const format = req.body?.format === 'combined' ? 'combined' : 'separate'
    const owned = await prisma.script.findMany({ where: { id: { in: ids }, sessionId: req.params.id }, select: { id: true } })
    const order = ids.filter((id) => owned.some((s) => s.id === id))

    if (format === 'combined') {
      const doc = newMarkedPdf('Marked scripts')
      let added = 0
      for (const id of order) {
        const data = await loadMarkedScript(id)
        if (!data?.ready) continue
        await addMarkedScript(doc, data)
        added++
      }
      if (added === 0) return res.status(409).json({ error: 'None of these scripts are fully confirmed.' })
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'attachment; filename="Marked Scripts.pdf"')
      doc.pipe(res)
      doc.end()
      return
    }

    const zip = new JSZip()
    const names = new Set()
    for (const id of order) {
      const data = await loadMarkedScript(id)
      if (!data?.ready) continue
      const doc = newMarkedPdf(markedFileName(data.script, data.script.session))
      const done = pdfBuffer(doc)
      await addMarkedScript(doc, data)
      doc.end()
      let name = markedFileName(data.script, data.script.session)
      while (names.has(name)) name = name.replace(/\.pdf$/, ' (2).pdf')
      names.add(name)
      // Page images are JPEG already, so squeezing them again saves nothing.
      zip.file(name, await done, { compression: 'STORE' })
    }
    if (names.size === 0) return res.status(409).json({ error: 'None of these scripts are fully confirmed.' })
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="Marked Scripts.zip"')
    res.end(buffer)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.status(500).json({ error: 'Could not make the download: ' + err.message })
    else res.end()
  }
})

export default router
