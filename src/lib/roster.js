// Matching and merging logic for a session's class list / attendance roster.
// Deliberately has no notion of "which document a clean entry came from" —
// only a flagged (conflicting) entry keeps a pointer back to the upload that
// produced the conflicting value, since that's the only case a lecturer ever
// needs to see a source document again.

// UNIZIK reg numbers start with a 4 digit entry year, then a serial, with
// or without a slash (2021/245678, 2017364085), and postgraduate numbers
// end in letters (2025366001FN). A wrong year or a different letter suffix
// means a different student entirely, not an OCR slip, so fuzziness is only
// ever allowed within the serial digits, never in the year or the suffix.
const REG_NUMBER_PATTERN = /^(\d{4})\/?(\d+)([A-Z]*)$/

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
    if (candidateMatch[3] !== targetMatch[3]) continue // so must the letter suffix

    const distance = editDistance(targetMatch[2], candidateMatch[2])
    if (distance < bestDistance) {
      bestDistance = distance
      best = e
    }
  }

  if (best && bestDistance <= 2) return { entry: best, matchType: 'fuzzy' }

  // A slip in the year itself (a handwritten 2 read as 0 turns 2021 into
  // 2001). Only tried when no student on the list shares the year read,
  // and only accepted when exactly one student is within 2 digits of the
  // whole number, so a near tie between two students is never guessed.
  const sameYear = entries.some((e) => (normalizeRegNumber(e.regNumber).match(REG_NUMBER_PATTERN) || [])[1] === targetMatch[1])
  if (sameYear) return null
  const flat = `${targetMatch[1]}${targetMatch[2]}`
  const close = []
  for (const e of entries) {
    const m = normalizeRegNumber(e.regNumber).match(REG_NUMBER_PATTERN)
    if (!m || m[3] !== targetMatch[3]) continue
    const d = editDistance(flat, `${m[1]}${m[2]}`)
    if (d <= 2) close.push({ e, d })
  }
  if (close.length === 0) return null
  const min = Math.min(...close.map((c) => c.d))
  const nearest = close.filter((c) => c.d === min)
  return nearest.length === 1 ? { entry: nearest[0].e, matchType: 'fuzzy' } : null
}

// OCR on handwriting often reads a 0 as O or a 1 as l/I/|. Only these
// confusions are undone, and only in the serial digits, so the letters of a
// postgraduate suffix like FN are never changed into digits.
const DIGIT_LOOKALIKES = { O: '0', o: '0', I: '1', l: '1', '|': '1' }

// Year, optional slash, serial (digits or digit lookalikes, ending in a real
// digit or a lookalike), then an optional suffix of up to 3 letters.
const REG_SHAPE = /^((?:19|20)\d{2})(\/?)([0-9OoIl|]{5,8})([A-Za-z]{0,3})$/

// Turns a raw OCR or AI reading into a clean reg number, or null if it does
// not have a reg number's shape. Spaces are removed, the suffix is upper
// cased, and the slash is kept only if it was written. A short tail (like
// the "2024" in a "2023/2024" session line) is rejected, since a reg
// number's serial part is always longer than a year.
export function cleanRegNumber(raw) {
  if (!raw) return null
  const compact = String(raw).replace(/\s+/g, '').replace(/\\/g, '/')
  const parts = compact.match(REG_SHAPE)
  if (!parts) return null
  const serial = parts[3].replace(/[OoIl|]/g, (c) => DIGIT_LOOKALIKES[c])
  return `${parts[1]}${parts[2]}${serial}${parts[4].toUpperCase()}`
}

// Every reg number shaped string on a page, cleaned, in reading order and
// without repeats. The booklet serial ("S/N: 25/B1/89487") and the session
// line ("20__/20__") never match the shape, so they drop out here.
export function findRegNumberCandidates(pageText) {
  if (!pageText) return []
  const found = []
  const pattern = /(?<![0-9A-Za-z])((?:19|20)\d{2})[ \t]*([\/\\]?)[ \t]*([0-9OoIl|](?:[ \t]?[0-9OoIl|]){4,7})[ \t]?([A-Za-z]{0,3})(?![0-9A-Za-z|])/g
  for (const m of pageText.matchAll(pattern)) {
    const cleaned = cleanRegNumber(`${m[1]}${m[2]}${m[3]}${m[4]}`)
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
