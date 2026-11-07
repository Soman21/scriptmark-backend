// The files a guide was read from: the question paper and the marking
// guide, each kept with the text read from it, so they are still there when
// the lecturer comes back to the session. Stored on MarkingGuide.sourceFiles
// as { questionPaper, guide }, each
//   { url, mimeType, name, text, scanned, uploadedAt }
// or null. Pure helpers only, so they are easy to unit test.

export const SOURCE_KINDS = ['questionPaper', 'guide']
// Text read from a file is kept up to this length. A ten page scanned guide
// is about 30,000 characters.
export const MAX_SOURCE_TEXT = 200000

const str = (v, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

function cleanOne(f, before) {
  if (!f || typeof f !== 'object') return null
  const url = str(f.url)
  if (!url || !/^https:\/\//.test(url)) return null
  const uploaded = new Date(f.uploadedAt)
  return {
    url,
    mimeType: str(f.mimeType, 200),
    name: str(f.name, 300) || 'Document',
    // A guide opened from a list has no text, so saving it keeps the text
    // already stored for the same file.
    text: typeof f.text === 'string' ? f.text.slice(0, MAX_SOURCE_TEXT) : before?.url === url ? before.text || '' : '',
    scanned: !!f.scanned,
    uploadedAt: Number.isNaN(uploaded.getTime()) ? new Date().toISOString() : uploaded.toISOString(),
  }
}

// Normalises sourceFiles from a save request. Unknown keys are dropped; a
// file without an https link is dropped. Returns null when none are left.
// existing: what the guide has stored now, to keep text a request left out.
export function cleanSourceFiles(value, existing = null) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  for (const kind of SOURCE_KINDS) {
    const f = cleanOne(value[kind], existing?.[kind])
    if (f) out[kind] = f
  }
  return Object.keys(out).length ? out : null
}

// The same without the text, for lists of guides, where the text is never
// shown and would only make the reply large.
export function withoutText(sourceFiles) {
  if (!sourceFiles || typeof sourceFiles !== 'object') return null
  const out = {}
  for (const kind of SOURCE_KINDS) {
    if (sourceFiles[kind]) {
      const { text, ...rest } = sourceFiles[kind]
      out[kind] = { ...rest, hasText: !!text }
    }
  }
  return out
}
