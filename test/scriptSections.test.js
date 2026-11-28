// Tests for the trial options: marking by script section and reasoning
// effort. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitScript, sectionTextFor } from '../src/lib/scriptSections.js'
import { scoreScriptAgainstGuide, resetScoringModel } from '../src/lib/groq.js'

const guide = ['1', '2', '5'].flatMap((n) => [
  { id: `q${n}a`, number: n, subLabel: 'a', text: 'Explain', modelAnswer: 'x', keywords: '', maxMarks: 5 },
  { id: `q${n}b`, number: n, subLabel: 'b', text: 'List', modelAnswer: 'y', keywords: '', maxMarks: 5 },
])

const script = [
  'NNAMDI AZIKIWE UNIVERSITY',
  "STUDENT'S REG. NO 2021/245678",
  'Q1a) An entity is a thing',
  '(b) Student, Course',
  '--- page break ---',
  'still question one',
  'Question 5',
  '5a. The steps are',
  '1. Define the objective',
  '2. Identify entities',
  '3. Identify attributes',
  '5(b) STUDENT 1 to M REGISTRATION',
].join('\n')

test('splits at clear labels only, not at numbered lists', () => {
  const split = splitScript(script, guide)
  assert.deepEqual([...split.sections.keys()], ['1', '5'])
  assert.match(split.sections.get('1'), /still question one/)
  assert.match(split.sections.get('5'), /3\. Identify attributes\n5\(b\)/)
  assert.match(split.unlabelled, /REG\. NO/)
})

test('a script with fewer than two labelled questions is not split', () => {
  assert.equal(splitScript('An entity is a thing\n1. first\n2. second', guide), null)
})

test('a question with no section says so and carries the unlabelled text', () => {
  const split = splitScript(script, guide)
  const text = sectionTextFor(split, guide.filter((q) => q.number === '2'))
  assert.match(text, /No answer labelled Question 2 was found/)
  assert.match(text, /REG\. NO/)
  assert.doesNotMatch(text, /entity is a thing/)
})

function fakeGroq(sent) {
  return async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push(body)
    const ids = [...body.messages[1].content.matchAll(/Question ID: (\S+)/g)].map((m) => m[1])
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ results: ids.map((id) => ({ questionId: id, suggestedScore: 1, answerText: '', confidence: 'high', reasoning: 'ok' })) }) } }] }),
    }
  }
}

test('by section, each request carries only its own sections', async () => {
  resetScoringModel()
  const real = globalThis.fetch
  const sent = []
  globalThis.fetch = fakeGroq(sent)
  try {
    const results = await scoreScriptAgainstGuide(script, guide, { bySection: true })
    assert.equal(results.length, 6)
    assert.ok(results.every(Boolean))
    for (const body of sent) {
      const user = body.messages[1].content
      if (/Question ID: q1a/.test(user) && !/Question ID: q5a/.test(user)) assert.doesNotMatch(user, /Define the objective/)
    }
  } finally {
    globalThis.fetch = real
  }
})

test('reasoning effort is sent only when set', async () => {
  resetScoringModel()
  const real = globalThis.fetch
  const sent = []
  globalThis.fetch = fakeGroq(sent)
  try {
    await scoreScriptAgainstGuide('text', guide.slice(0, 1))
    await scoreScriptAgainstGuide('text', guide.slice(0, 1), { reasoningEffort: 'low' })
    assert.equal(sent[0].reasoning_effort, undefined)
    assert.equal(sent[1].reasoning_effort, 'low')
  } finally {
    globalThis.fetch = real
  }
})
