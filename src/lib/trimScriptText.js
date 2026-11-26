// Takes characters out of a script's text before it is sent to the marking
// AI, so the free allowance is not spent on things that are not the
// student's answer. The saved text and the text lecturers see are not
// changed; only the copy sent to the AI is trimmed.
//
// Only low risk things are removed:
//  - lines that repeat on most pages (a printed header or footer such as
//    the university name), found even when OCR spelt them a little
//    differently each time
//  - page numbers on a line of their own
//  - lines with no letters or digits at all (stray marks, ruled lines)
//  - blank lines and extra spaces
import { editDistance } from './wer.js'

export const PAGE_BREAK = '\n\n--- page break ---\n\n'

const MIN_REPEAT_LENGTH = 8 // shorter lines could be the student's own words
const MAX_DIFFERENCE = 0.15 // how much two spellings of one header may differ
const MIN_PAGES = 3 // below this a repeat proves nothing

function squash(line) {
  return line.replace(/\s+/g, ' ').trim()
}

function key(line) {
  return line.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isPageNumber(line) {
  return /^(page\s*)?[-–(]?\s*\d{1,3}\s*[-–)]?$/i.test(line) || /^page\s*\d+\s*(of\s*\d+)?$/i.test(line)
}

function similar(a, b) {
  if (a === b) return true
  const longest = Math.max(a.length, b.length)
  if (Math.abs(a.length - b.length) / longest > MAX_DIFFERENCE) return false
  return editDistance([...a], [...b]) / longest <= MAX_DIFFERENCE
}

export function trimForMarking(text) {
  const source = String(text || '')
  if (!source) return source
  const pages = source.split(PAGE_BREAK).map((page) =>
    page
      .split('\n')
      .map(squash)
      .filter((line) => line && /[a-z0-9]/i.test(line) && !isPageNumber(line))
  )

  // Lines that come back on at least half the pages (and three or more).
  const needed = Math.max(MIN_PAGES, Math.ceil(pages.length / 2))
  const repeated = []
  if (pages.length >= MIN_PAGES) {
    const seen = []
    for (const page of pages) {
      for (const line of page) {
        const k = key(line)
        if (k.length >= MIN_REPEAT_LENGTH) seen.push({ k, page })
      }
    }
    for (const { k } of seen) {
      if (repeated.some((r) => similar(r, k))) continue
      const onPages = new Set(seen.filter((s) => similar(s.k, k)).map((s) => s.page))
      if (onPages.size >= needed) repeated.push(k)
    }
  }

  const kept = pages.map((page) =>
    page.filter((line) => {
      const k = key(line)
      return !(k.length >= MIN_REPEAT_LENGTH && repeated.some((r) => similar(r, k)))
    })
  )
  return kept.map((lines) => lines.join('\n')).join(PAGE_BREAK)
}

// For the log: how much was taken out.
export function trimSummary(before, after) {
  const saved = String(before || '').length - String(after || '').length
  const percent = before ? Math.round((saved / before.length) * 100) : 0
  return `${saved} of ${before.length} characters (${percent}%)`
}
