import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanSourceFiles, withoutText, MAX_SOURCE_TEXT } from '../src/lib/sourceFiles.js'

const paper = { url: 'https://x.supabase.co/a.pdf', mimeType: 'application/pdf', name: 'Paper.pdf', text: 'Question 1', scanned: false, uploadedAt: '2026-11-07T05:00:00Z' }

test('keeps both files with their text', () => {
  const out = cleanSourceFiles({ questionPaper: paper, guide: { ...paper, name: 'Guide.pdf', scanned: true } })
  assert.equal(out.questionPaper.text, 'Question 1')
  assert.equal(out.guide.name, 'Guide.pdf')
  assert.equal(out.guide.scanned, true)
  assert.equal(out.questionPaper.uploadedAt, '2026-11-07T05:00:00.000Z')
})

test('drops unknown keys, files with no https link, and returns null when empty', () => {
  assert.deepEqual(Object.keys(cleanSourceFiles({ questionPaper: paper, other: paper })), ['questionPaper'])
  assert.equal(cleanSourceFiles({ guide: { ...paper, url: 'javascript:alert(1)' } }), null)
  assert.equal(cleanSourceFiles(null), null)
  assert.equal(cleanSourceFiles('x'), null)
})

test('very long text is cut, a bad date becomes now', () => {
  const out = cleanSourceFiles({ guide: { ...paper, text: 'a'.repeat(MAX_SOURCE_TEXT + 10), uploadedAt: 'nope' } })
  assert.equal(out.guide.text.length, MAX_SOURCE_TEXT)
  assert.ok(!Number.isNaN(new Date(out.guide.uploadedAt).getTime()))
})

test('lists get the files without their text', () => {
  const out = withoutText({ questionPaper: paper })
  assert.equal(out.questionPaper.text, undefined)
  assert.equal(out.questionPaper.hasText, true)
  assert.equal(withoutText(null), null)
})

test('saving a file sent without its text keeps the stored text for the same file', () => {
  const stored = { guide: { ...paper, text: 'stored text' } }
  const { text, ...noText } = paper
  assert.equal(cleanSourceFiles({ guide: noText }, stored).guide.text, 'stored text')
  assert.equal(cleanSourceFiles({ guide: { ...noText, url: 'https://x/new.pdf' } }, stored).guide.text, '')
})
