// Matching and merging logic for a session's class list / attendance roster.
// Deliberately has no notion of "which document a clean entry came from" —
// only a flagged (conflicting) entry keeps a pointer back to the upload that
// produced the conflicting value, since that's the only case a lecturer ever
// needs to see a source document again.

// UNIZIK reg numbers follow YYYY/NNNNNN. A wrong year means a different
// student entirely, not an OCR slip, so fuzziness is only ever allowed
// within the numeric segment after the slash, never in the year.
const REG_NUMBER_PATTERN = /^(\d{4})\/(\d+)$/

export function normalizeRegNumber(raw) {
  if (!raw) return ''
  return raw.replace(/\s+/g, '').toUpperCase()
}

// Plain Levenshtein distance, fine at this scale (short strings, small lists).
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

// Finds the best roster entry for an OCR-detected reg number: exact match
// first, then a fuzzy fallback (edit distance <= 2, year segment untouched)
// to absorb OCR digit/letter confusions. Returns null if nothing is close
// enough to be trustworthy.
export function matchRegNumber(detectedRegNumber, entries) {
  const target = normalizeRegNumber(detectedRegNumber)
  if (!target || !Array.isArray(entries) || entries.length === 0) return null

  const exact = entries.find((e) => normalizeRegNumber(e.regNumber) === target)
  if (exact) return { entry: exact, matchType: 'exact' }

  const targetMatch = target.match(REG_NUMBER_PATTERN)
  if (!targetMatch) return null // can't safely fuzzy match a reg number we can't even parse the shape of

  let best = null
  let bestDistance = Infinity
  for (const e of entries) {
    const candidate = normalizeRegNumber(e.regNumber)
    const candidateMatch = candidate.match(REG_NUMBER_PATTERN)
    if (!candidateMatch || candidateMatch[1] !== targetMatch[1]) continue // year must match exactly

    const distance = editDistance(targetMatch[2], candidateMatch[2])
    if (distance < bestDistance) {
      bestDistance = distance
      best = e
    }
  }

  if (best && bestDistance <= 2) return { entry: best, matchType: 'fuzzy' }
  return null
}

// OCR on handwriting often reads a 0 as O or a 1 as l/I/|. Only these
// confusions are undone, and only in the digit part, so a real letter in a
// non UNIZIK style number never gets silently changed into a digit.
const DIGIT_LOOKALIKES = { O: '0', o: '0', D: '0', I: '1', l: '1', '|': '1', i: '1' }

// Turns a raw OCR or AI reading into a clean YYYY/NNNNNN reg number, or
// null if it does not have that shape. A short tail (like the "2024" in a
// "2023/2024" session line) is rejected, since a reg number's serial part
// is always longer than a year.
export function cleanRegNumber(raw) {
  if (!raw) return null
  const compact = String(raw).replace(/\s+/g, '').replace(/\\/g, '/')
  const parts = compact.match(/^((?:19|20)\d{2})\/([0-9OoDIil|]{5,7})$/)
  if (!parts) return null
  const serial = parts[2].replace(/[OoDIil|]/g, (c) => DIGIT_LOOKALIKES[c])
  return `${parts[1]}/${serial}`
}

// Every reg number shaped string on a page, cleaned, in reading order and
// without repeats. The booklet serial ("S/N: 25/B1/89487") and the session
// line ("20__/20__") never match the shape, so they drop out here.
export function findRegNumberCandidates(pageText) {
  if (!pageText) return []
  const found = []
  const pattern = /(?<!\d)((?:19|20)\d{2})\s*[\/\\]\s*([0-9OoDIil|](?:\s?[0-9OoDIil|]){4,6})(?![0-9OoDIil|])/g
  for (const m of pageText.matchAll(pattern)) {
    const cleaned = cleanRegNumber(`${m[1]}/${m[2]}`)
    if (cleaned && !found.includes(cleaned)) found.push(cleaned)
  }
  return found
}

// Picks the reg number to store for a script's front page. The AI's pick
// goes first, then any other reg number shaped strings on the page. With a
// class list, the first one that matches a student on it wins, so a wrong
// AI pick is rescued by the right number elsewhere on the page. Without a
// class list (or with no match), the AI's pick is kept, else the first
// candidate on the page.
export function pickRegNumber(aiPick, pageText, classList) {
  const options = []
  for (const r of [cleanRegNumber(aiPick), ...findRegNumberCandidates(pageText)]) {
    if (r && !options.includes(r)) options.push(r)
  }
  if (options.length === 0) return null
  if (Array.isArray(classList) && classList.length > 0) {
    const matched = options.find((r) => matchRegNumber(r, classList))
    if (matched) return matched
  }
  return options[0]
}

// Given a session's scripts and its current classList, returns the scripts
// whose matched roster entry is still flagged (a name conflict that hasn't
// been resolved). Shared by the export route and the assistant's
// prepare_export tool, so both apply exactly the same export-readiness rule.
export function findUnresolvedScripts(scripts, classList) {
  const flaggedIds = new Set((classList || []).filter((e) => e.flagged).map((e) => e.id))
  if (flaggedIds.size === 0) return []
  return scripts.filter((s) => s.classListEntryId && flaggedIds.has(s.classListEntryId))
}

// Merges a freshly parsed set of { name, regNumber } rows from a new upload
// into the session's existing classList. New reg numbers are simply added.
// A reg number that already exists gets flagged ONLY if the name genuinely
// differs (minor whitespace/case differences don't count) — the existing
// value is kept as the current one, the incoming value is kept alongside it
// under conflict for the lecturer to compare and resolve, along with which
// upload it came from.
export function mergeClassListEntries(existingList, incomingRows, uploadId) {
  const existing = Array.isArray(existingList) ? [...existingList] : []
  let addedCount = 0
  let flaggedCount = 0

  for (const row of incomingRows) {
    const regNumber = normalizeRegNumber(row.regNumber)
    if (!regNumber || !row.name?.trim()) continue // can't usefully merge a row missing either field

    const matchIdx = existing.findIndex((e) => normalizeRegNumber(e.regNumber) === regNumber)

    if (matchIdx === -1) {
      existing.push({
        id: `cle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: row.name.trim(),
        regNumber: row.regNumber.trim(),
        flagged: false,
        conflict: null,
      })
      addedCount++
      continue
    }

    const current = existing[matchIdx]
    const namesDiffer = current.name.trim().toLowerCase() !== row.name.trim().toLowerCase()
    if (namesDiffer) {
      existing[matchIdx] = {
        ...current,
        flagged: true,
        conflict: { name: row.name.trim(), regNumber: row.regNumber.trim(), uploadId },
      }
      flaggedCount++
    }
    // Names agree (or entry was already flagged and this upload just
    // repeats one side of it) — nothing to change.
  }

  return { merged: existing, addedCount, flaggedCount }
}
