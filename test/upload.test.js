// Tests for file uploads: a file over the limit gets a clear 413 message
// instead of "Unexpected server error.". Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { fileUpload } from '../src/lib/upload.js'

async function withServer(limitMb, fn) {
  const app = express()
  const upload = fileUpload(limitMb)
  app.post('/one', upload.single('pdf'), (req, res) => res.json({ size: req.file.size }))
  app.post('/many', upload.array('files', 2), (req, res) => res.json({ count: req.files.length }))
  app.use((err, req, res, next) => res.status(500).json({ error: 'Unexpected server error.' }))
  const server = app.listen(0)
  try {
    await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.close()
  }
}

function form(field, sizes) {
  const fd = new FormData()
  for (const s of sizes) fd.append(field, new Blob([Buffer.alloc(s)]), 'a.pdf')
  return fd
}

test('a file under the limit is accepted', async () => {
  await withServer(1, async (base) => {
    const res = await fetch(`${base}/one`, { method: 'POST', body: form('pdf', [1000]) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).size, 1000)
  })
})

test('a file over the limit gets 413 with the limit named', async () => {
  await withServer(1, async (base) => {
    const res = await fetch(`${base}/one`, { method: 'POST', body: form('pdf', [1024 * 1024 + 1]) })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.equal(body.code, 'FILE_TOO_LARGE')
    assert.equal(body.limitMb, 1)
    assert.equal(body.error, 'File is larger than 1 MB.')
  })
})

test('other upload errors get 400, not the general server error', async () => {
  await withServer(1, async (base) => {
    const res = await fetch(`${base}/many`, { method: 'POST', body: form('files', [10, 10, 10]) })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /^Upload failed/)
  })
})
