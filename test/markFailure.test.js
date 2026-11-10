import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureReason, recordFailure, markFailures } from '../src/lib/markFailure.js'

test('turns marking errors into a short reason', () => {
  assert.equal(failureReason(new Error('Groq API error (413): {"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 8000, Requested 14200"}}')), 'Too long for AI plan limit')
  assert.equal(failureReason(new Error('Groq API error (401): Invalid API Key')), 'AI key rejected')
  assert.equal(failureReason(new Error('Groq API error (429): Rate limit reached')), 'AI rate limit reached')
  assert.equal(failureReason(new Error('Groq API error (503): over capacity')), 'AI service unavailable')
  assert.equal(failureReason(new Error('Vision OCR failed: PERMISSION_DENIED')), 'Page reading failed')
  assert.equal(failureReason(new Error('something odd')), 'Marking error')
})

test('keeps the reason per script', () => {
  recordFailure('s1', new Error('Groq API error (413): too big'))
  assert.equal(markFailures.get('s1').reason, 'Too long for AI plan limit')
  markFailures.delete('s1')
})
