import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageThumbnails, scoreAgainstCover, coverThreshold, groupsFromScores } from '../src/lib/coverDetect.js'

const W = 90
const H = 120

// A printed cover: thick frame, a few boxes, a table at the bottom.
function cover(noise = 0, seed = 1) {
  let r = seed
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
  const g = new Uint8Array(W * H).fill(230)
  const box = (x0, y0, x1, y1, t = 2) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x - x0 < t || x1 - x < t || y - y0 < t || y1 - y < t) g[y * W + x] = 40
  }
  box(6, 8, 84, 112, 4)
  box(14, 30, 76, 38)
  box(14, 46, 76, 54)
  box(50, 70, 78, 106)
  for (let y = 74; y < 106; y += 4) for (let x = 50; x < 78; x++) g[y * W + x] = 60
  for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, g[i] + (rand() - 0.5) * noise))
  return g
}

// A handwritten page: faint ruled lines and random dark strokes.
function lined(seed) {
  let r = seed
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280)
  const g = new Uint8Array(W * H).fill(238)
  for (let y = 12; y < H; y += 4) for (let x = 0; x < W; x++) g[y * W + x] = 200
  for (let k = 0; k < 400; k++) {
    const x = Math.floor(rand() * (W - 10)) + 8
    const y = Math.floor(rand() * (H - 14)) + 12
    for (let d = 0; d < 4; d++) g[y * W + Math.min(W - 1, x + d)] = 50
  }
  return g
}

function rotate90(g) {
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[x * H + (H - 1 - y)] = g[y * W + x]
  return { grey: out, w: H, h: W }
}

test('covers match each other, even turned sideways, and answer pages do not', () => {
  const pages = [
    { grey: cover(), w: W, h: H },
    { grey: lined(2), w: W, h: H },
    { grey: lined(3), w: W, h: H },
    rotate90(cover(30, 7)),
    { grey: lined(4), w: W, h: H },
    { grey: cover(40, 9), w: W, h: H },
    { grey: lined(5), w: W, h: H },
  ]
  const scores = scoreAgainstCover(pages)
  assert.ok(scores[3] > 0.8 && scores[5] > 0.8, `covers: ${scores}`)
  for (const i of [1, 2, 4, 6]) assert.ok(scores[i] < 0.4, `page ${i}: ${scores[i]}`)
  assert.deepEqual(groupsFromScores(scores), [
    { start: 0, end: 2 },
    { start: 3, end: 4 },
    { start: 5, end: 6 },
  ])
})

test('the cut off follows the gap in the scores and falls back to one half', () => {
  assert.equal(coverThreshold([1, 0.1, 0.05, 0.95, 0.12, 0.9]).toFixed(2), '0.51')
  assert.equal(coverThreshold([1, 0.7, 0.72, 0.68]), 0.5)
  assert.deepEqual(groupsFromScores([1, 0.1, 0.2]), [{ start: 0, end: 2 }])
})

test('a thumbnail is the same size whichever way the page was scanned', () => {
  const t = pageThumbnails(cover(), W, H)
  assert.equal(t.length, 4)
  assert.ok(t.every((x) => x.length === t[0].length))
})
