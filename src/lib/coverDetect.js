import * as mupdf from 'mupdf'

// Finds where each student's script starts in one big scanned PDF without
// any OCR: every script opens on the same printed answer booklet cover, so
// a cover page looks alike from student to student while the handwritten
// pages inside do not. Each page is shrunk to a tiny grey thumbnail and
// compared with a known cover. This runs in a fraction of a second per
// page and costs nothing.

export const THUMB_W = 24
export const THUMB_H = 32

// grey: Uint8Array of w*h luminance values. Returns a portrait THUMB_W x
// THUMB_H Float32Array, normalised to mean 0 and spread 1, so lighting and
// paper colour matter less than layout.
export function thumbnail(grey, w, h, rotation = 0) {
  const out = new Float32Array(THUMB_W * THUMB_H)
  // Rotation is applied by reading the source in a different order.
  const rw = rotation % 180 === 0 ? w : h
  const rh = rotation % 180 === 0 ? h : w
  for (let ty = 0; ty < THUMB_H; ty++) {
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x0 = Math.floor((tx * rw) / THUMB_W), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * rw) / THUMB_W))
      const y0 = Math.floor((ty * rh) / THUMB_H), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * rh) / THUMB_H))
      let sum = 0, n = 0
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          let sx, sy
          if (rotation === 0) { sx = x; sy = y }
          else if (rotation === 90) { sx = y; sy = h - 1 - x }
          else if (rotation === 180) { sx = w - 1 - x; sy = h - 1 - y }
          else { sx = w - 1 - y; sy = x }
          sum += grey[sy * w + sx]; n++
        }
      }
      out[ty * THUMB_W + tx] = sum / n
    }
  }
  let mean = 0
  for (const v of out) mean += v
  mean /= out.length
  let sd = 0
  for (const v of out) sd += (v - mean) ** 2
  sd = Math.sqrt(sd / out.length) || 1
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / sd
  return out
}

export function correlation(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s / a.length
}

// Best match over the four ways a page can be fed into a scanner.
export function coverSimilarity(reference, page) {
  return Math.max(...page.map((t) => correlation(reference, t)))
}

export function pageThumbnails(grey, w, h) {
  return [0, 90, 180, 270].map((r) => thumbnail(grey, w, h, r))
}

// pages: [{ grey, w, h }]. coverIndex: a page the lecturer knows is a cover
// (the first page of the PDF by default). Returns a similarity per page.
export function scoreAgainstCover(pages, coverIndex = 0) {
  const thumbs = pages.map((p) => pageThumbnails(p.grey, p.w, p.h))
  const ref = thumbs[coverIndex][0]
  return thumbs.map((t) => coverSimilarity(ref, t))
}

// The cut off between "cover" and "not a cover" is taken from the batch
// itself: the widest gap between scores, when there is a clear one, or 0.5.
export function coverThreshold(scores) {
  const sorted = scores.slice(1).sort((a, b) => a - b)
  let best = { gap: 0, at: 0.5 }
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap > best.gap) best = { gap, at: (sorted[i] + sorted[i - 1]) / 2 }
  }
  return best.gap >= 0.3 && best.at > 0.2 && best.at < 0.9 ? best.at : 0.5
}

// Splits before every page that looks like the cover. Page 0 always starts
// the first script.
export function groupsFromScores(scores, threshold = coverThreshold(scores)) {
  const starts = scores.map((s, i) => (i === 0 || s >= threshold ? i : -1)).filter((i) => i >= 0)
  return starts.map((start, k) => ({ start, end: (starts[k + 1] ?? scores.length) - 1 }))
}

export function greyPages(pdfBuffer, scale = 0.25) {
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  const pages = []
  for (let i = 0; i < doc.countPages(); i++) {
    const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray)
    pages.push({ grey: pix.getPixels(), w: pix.getWidth(), h: pix.getHeight(), stride: pix.getStride() })
  }
  return pages.map((p) => (p.stride === p.w ? p : { ...p, grey: unstride(p) }))
}

function unstride({ grey, w, h, stride }) {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) out.set(grey.subarray(y * stride, y * stride + w), y * w)
  return out
}
