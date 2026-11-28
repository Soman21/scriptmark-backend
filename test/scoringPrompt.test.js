// Tests that each marking request carries only the rules its parts need.
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoringPromptFor, SYSTEM_PROMPT } from '../src/lib/groq.js'

const plain = { id: 'a', number: '1', text: 'Define a database', modelAnswer: 'A store of data', maxMarks: 2 }
const pointed = { id: 'b', number: '2', text: 'Name two keys', modelAnswer: '', maxMarks: 2, steps: [{ description: 'Primary', marks: 1 }, { description: 'Foreign', marks: 1 }] }

test('a request with only point marked parts skips drawing, band, table and best N rules', () => {
  const p = scoringPromptFor([pointed])
  assert.match(p, /MARKING POINTS/)
  assert.match(p, /attempt/)
  assert.doesNotMatch(p, /DRAWINGS:/)
  assert.doesNotMatch(p, /mark\nbands/)
  assert.doesNotMatch(p, /Only the best N/)
  assert.doesNotMatch(p, /scored holistically/)
  assert.ok(p.length < SYSTEM_PROMPT.length)
})

test('each rule comes back when a part needs it', () => {
  assert.match(scoringPromptFor([plain]), /scored holistically/)
  assert.doesNotMatch(scoringPromptFor([plain]), /MARKING POINTS/)
  assert.match(scoringPromptFor([{ ...plain, modelAnswer: 'Excellent (13-15 marks)' }]), /mark\nbands/)
  assert.match(scoringPromptFor([{ ...plain, modelAnswer: '| a | b |' }]), /table in Markdown/)
  assert.match(scoringPromptFor([{ ...plain, text: 'Draw the block diagram' }]), /DRAWINGS:/)
  assert.match(scoringPromptFor([plain], 'x\n\nDIAGRAM SEEN ON THE PAGE (described...)'), /DRAWINGS:/)
  assert.match(scoringPromptFor([{ ...pointed, countBest: 1 }]), /Only the best N/)
})

test('the full rule set still holds every rule', () => {
  for (const words of ['MARKING POINTS', 'Only the best N', 'scored holistically', 'mark\nbands', 'table in Markdown', 'DRAWINGS:', 'Respond with ONLY']) {
    assert.ok(SYSTEM_PROMPT.includes(words), words)
  }
})
