import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkingSchemeDocument, splitGuideByQuestion, GUIDE_TEXT_LIMIT } from '../src/lib/groq.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const noSleep = { sleep: async () => {} }

// Fake Groq: answers each call with the questions whose headings are in the
// text it was sent, and records what it was sent.
function fakeGroq({ finish = 'stop', statuses = [] } = {}) {
  const sent = []
  globalThis.fetch = async (_url, req) => {
    const text = JSON.parse(req.body).messages[1].content
    sent.push(text)
    const status = statuses.shift()
    if (status) return { ok: false, status, headers: { get: () => null }, text: async () => 'busy' }
    const numbers = [...text.matchAll(/^Question (\d+)/gim)].map((m) => m[1])
    const questions = numbers.map((n) => ({ number: n, subLabel: 'a', modelAnswer: `answer ${n}`, points: [{ description: 'p', marks: 1 }] }))
    return { ok: true, json: async () => ({ choices: [{ finish_reason: finish, message: { content: JSON.stringify({ title: 'ECE 538', questions }) } }] }) }
  }
  return sent
}

const GUIDE = `MARKING GUIDE: DATA COMMUNICATION
General instructions for markers.

Question 1 (20 Marks)
(1a) Define the following terms (5 Marks)
(1b) Components (5 Marks)

Question 2 (20 Marks)
(2a) OSI vs TCP/IP (5 Marks)
[DIAGRAM for 7(b): star, ring and bus topologies]

QUESTION 7 (20 Marks)
(7b) Draw any three network topologies (6 Marks)`

test('a guide is split into one piece per question, title with the first', () => {
  const pieces = splitGuideByQuestion(GUIDE)
  assert.equal(pieces.length, 3)
  assert.match(pieces[0], /^MARKING GUIDE[\s\S]*\(1b\)/)
  assert.doesNotMatch(pieces[0], /Question 2/)
  assert.match(pieces[1], /^Question 2/)
})

test('diagram lines move to the question they name', () => {
  const pieces = splitGuideByQuestion(GUIDE)
  assert.doesNotMatch(pieces[1], /DIAGRAM/)
  assert.match(pieces[2], /\(7b\)[\s\S]*\[DIAGRAM for 7\(b\): star, ring and bus topologies\]/)
})

test('headings written as words, and text with one question, are handled', () => {
  assert.equal(splitGuideByQuestion('QUESTION ONE\na\nQUESTION TWO\nb\n[DIAGRAM for 2: x]').at(-1), 'QUESTION TWO\nb\n[DIAGRAM for 2: x]')
  assert.deepEqual(splitGuideByQuestion('Question 1\n(a) only'), ['Question 1\n(a) only'])
  assert.equal(splitGuideByQuestion('(1a) no headings\n(1b)').length, 1)
})

test('every question of a long guide comes back, one call per question', async () => {
  const sent = fakeGroq()
  const out = await parseMarkingSchemeDocument(GUIDE, noSleep)
  assert.equal(sent.length, 3)
  assert.deepEqual(out.questions.map((q) => q.number), ['1', '2', '7'])
  assert.equal(out.title, 'ECE 538')
  assert.equal(out.questions[2].steps.length, 1)
  assert.equal(out.cut, false)
})

test('a busy reply is retried', async () => {
  const sent = fakeGroq({ statuses: [429] })
  const out = await parseMarkingSchemeDocument('Question 1\n(a)', noSleep)
  assert.equal(sent.length, 2)
  assert.equal(out.questions.length, 1)
})

test('a reply cut off at the length limit is an error, not a short guide', async () => {
  fakeGroq({ finish: 'length' })
  await assert.rejects(parseMarkingSchemeDocument(GUIDE, noSleep), /too long/)
})

test('cut says whether some text was longer than the parser reads', async () => {
  fakeGroq()
  assert.equal((await parseMarkingSchemeDocument('Question 1\nshort', noSleep)).cut, false)
  assert.equal((await parseMarkingSchemeDocument('x'.repeat(GUIDE_TEXT_LIMIT + 1), noSleep)).cut, true)
})
