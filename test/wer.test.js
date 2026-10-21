import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorRates, summariseRates, editDistance } from '../src/lib/wer.js'
import { buildEvaluationReport } from '../src/lib/evaluation.js'

test('edit distance counts substitutions, deletions and insertions', () => {
  assert.equal(editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd']), 2)
  assert.equal(editDistance([], ['a', 'b']), 2)
})

test('word and character errors ignore case and punctuation', () => {
  const r = errorRates('Teh Z transform, of x[n]', 'the z transform of x n')
  assert.equal(r.words, 6)
  assert.equal(r.wordErrors, 1)
  assert.equal(r.charErrors, 2)
  const exact = errorRates('Hello world.', 'hello world')
  assert.equal(exact.wordErrors, 0)
  assert.equal(exact.charErrors, 0)
})

test('rates are pooled over all words, and split by OCR and vision', () => {
  const s = summariseRates([
    { words: 10, wordErrors: 1, chars: 50, charErrors: 2 },
    { words: 30, wordErrors: 9, chars: 150, charErrors: 18 },
  ])
  assert.deepEqual(s, { n: 2, words: 40, wer: 0.25, cer: 0.1 })
  const report = buildEvaluationReport([
    { questionId: 'q', suggested: 1, confirmed: 1, maxMarks: 2, markedText: 'a b c d', referenceText: 'a b c d', usedVision: false },
    { questionId: 'q', suggested: 1, confirmed: 2, maxMarks: 2, markedText: 'a x', referenceText: 'a b', usedVision: true },
    { questionId: 'q', suggested: 1, confirmed: 2, maxMarks: 2, markedText: 'no reference', referenceText: null },
  ])
  assert.equal(report.transcription.n, 2)
  assert.equal(report.transcription.wer, round(1 / 6))
  assert.equal(report.transcription.standardOcr.wer, 0)
  assert.equal(report.transcription.visionReread.wer, 0.5)
})

function round(x) {
  return Math.round(x * 1000) / 1000
}
