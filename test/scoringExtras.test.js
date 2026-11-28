// Tests that drawings and calculations seen on the page go with their own
// part in the one marking pass. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extrasBlockFor, packQuestions, scoreScriptAgainstGuide, resetScoringModel } from '../src/lib/groq.js'

const q1 = { id: 'q1', number: '1', subLabel: 'a', text: 'Draw the E-R diagram', modelAnswer: '', maxMarks: 4, steps: [{ description: 'Entities', marks: 4, note: 'DIAGRAM' }] }
const q2 = { id: 'q2', number: '2', subLabel: null, text: 'Solve x', modelAnswer: 'x = 3', keywords: '', maxMarks: 2, isCalculationHeavy: true }
const extras = { q1: { diagram: 'Boxes Student and Course joined by Registers' }, q2: { working: '2x = 6\nx = 3' } }

test('each section names its part and only goes with that part', () => {
  const both = extrasBlockFor([q1, q2], extras)
  assert.match(both, /DIAGRAM SEEN ON THE PAGE for Question 1a \(Question ID q1/)
  assert.match(both, /WORKING READ FROM THE PAGE IMAGE for Question 2 \(Question ID q2\):\n2x = 6/)
  assert.doesNotMatch(extrasBlockFor([q2], extras), /DIAGRAM/)
  assert.equal(extrasBlockFor([q1], undefined), '')
})

test('packing counts the size of each part\'s sections', () => {
  const big = { q1: { diagram: 'x'.repeat(20000) } }
  const groups = packQuestions('script', [q1, q2], 8000, 9000, big)
  assert.equal(groups.length, 2)
})

test('one request carries the sections and the matching rules', async () => {
  resetScoringModel()
  const real = globalThis.fetch
  let sent
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ results: [
          { questionId: 'q1', suggestedScore: 4, answerText: '', confidence: 'high', reasoning: 'ok', stepBreakdown: [{ awarded: 4 }] },
          { questionId: 'q2', suggestedScore: 2, answerText: '', confidence: 'high', reasoning: 'ok' },
        ] }) } }],
      }),
    }
  }
  try {
    const results = await scoreScriptAgainstGuide('script text', [q1, q2], { extras })
    assert.equal(results.length, 2)
    assert.match(sent.messages[1].content, /DIAGRAM SEEN ON THE PAGE for Question 1a/)
    assert.match(sent.messages[0].content, /DRAWINGS:/)
    assert.match(sent.messages[0].content, /mark that\nworking instead of the OCR text/)
  } finally {
    globalThis.fetch = real
  }
})
