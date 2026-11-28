// Makes the guide part of a marking request smaller without losing any
// marking content. The guide is read once and stored; these helpers only
// shape the copy sent with each marking request. The saved guide, and what
// lecturers see, are not changed.
//
// Two things are taken out, both by plain text matching (no judgement):
//  1. Correction notes, such as "[Printed 3 Marks changed to 4 Marks]".
//     They tell the lecturer how the marks were fixed; the marks themselves
//     are already in maxMarks and the points.
//  2. For a part with marking points, model answer lines that say the same
//     thing as one of the points. The parser builds the points from the
//     model answer, so without this every point was sent twice. Lines that
//     add something (sub bullets, examples, "Deduct 0.5 for...", tables,
//     mark bands) are kept.

// A whole line in square brackets that talks about marks being changed.
// "[DIAGRAM ...]" and "[TABLE ...]" lines are content and never match.
const NOTE_LINE = /^\s*\[(?!DIAGRAM|TABLE|END TABLE)[^\]]*\b(printed|changed|correction|scaled|added|handwritten)\b[^\]]*\]\s*$/i

export function stripCorrectionNotes(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !NOTE_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// A line or point reduced to its words: no bullet, no "1.25 marks for",
// no "(2 Marks)" or "[0.5]", lower case, single spaces.
export function pointKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^[\s•●▪◦\-*o]+(?=\S)/, '')
    .replace(/^\(?[ivx\d]{1,4}[.)]\s+/, '')
    .replace(/^\d+(?:\.\d+)?\s*marks?\s*(each\s*)?(for\s*)?[:\-]?\s*/, '')
    .replace(/[([]\s*\d+(?:\.\d+)?\s*(marks?)?\s*[)\]]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// True when a model answer line says the same as a point: the same words,
// or one inside the other with almost nothing extra (at most a fifth).
function samePoint(lineKey, key) {
  if (!lineKey || !key) return false
  if (lineKey === key) return true
  const [short, long] = lineKey.length < key.length ? [lineKey, key] : [key, lineKey]
  return short.length >= 12 && long.includes(short) && short.length / long.length >= 0.8
}

export function compactModelAnswer(modelAnswer, steps) {
  const text = stripCorrectionNotes(modelAnswer)
  const keys = (Array.isArray(steps) ? steps : []).map((s) => pointKey(s?.description))
  if (keys.length === 0) return text
  return text
    .split('\n')
    .filter((line) => {
      const k = pointKey(line)
      return !keys.some((key) => samePoint(k, key))
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
