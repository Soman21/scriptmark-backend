// Turns Google Vision's fullTextAnnotation into a short list of text lines
// with their position on the page, small enough to keep on every page:
//   [[text, x, y, w, h], ...]
// x and y are the line's top left corner, w and h its size, all as
// fractions of the page width and height (0 to 1), rounded to 4 places.
// Fractions, not pixels, so the same numbers work for any size the page
// is shown or printed at.

const LINE_ENDS = new Set(['LINE_BREAK', 'EOL_SURE_SPACE', 'HYPHEN'])

function boxOf(vertices) {
  const xs = (vertices || []).map((v) => v.x || 0)
  const ys = (vertices || []).map((v) => v.y || 0)
  if (!xs.length) return null
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

const r4 = (n) => Math.round(n * 10000) / 10000

export function linesFromAnnotation(annotation) {
  const page = annotation?.pages?.[0]
  const W = page?.width
  const H = page?.height
  if (!page || !W || !H) return []
  const lines = []
  let words = []
  let box = null

  function endLine() {
    if (words.length && box) {
      lines.push([words.join(' '), r4(box.x0 / W), r4(box.y0 / H), r4((box.x1 - box.x0) / W), r4((box.y1 - box.y0) / H)])
    }
    words = []
    box = null
  }

  for (const block of page.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const word of para.words || []) {
        const symbols = word.symbols || []
        const text = symbols.map((s) => s.text || '').join('')
        const b = boxOf(word.boundingBox?.vertices)
        if (text && b) {
          words.push(text)
          box = box
            ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) }
            : b
        }
        const brk = symbols[symbols.length - 1]?.property?.detectedBreak?.type
        if (LINE_ENDS.has(brk)) endLine()
      }
      endLine()
    }
  }
  return lines
}
