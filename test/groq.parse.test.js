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

test('an "any five" question with more points listed gets countBest', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [
      { number: '1', subLabel: 'b', text: 'State and explain any five characteristics', maxMarks: 5, points: Array.from({ length: 7 }, (_, i) => ({ description: `c${i + 1}`, marks: 1 })) },
      { number: '1', subLabel: 'c', text: 'Define data', maxMarks: 2, points: [{ description: 'd', marks: 2 }] },
    ] }) } }] }),
  })
  const out = await parseMarkingSchemeDocument('Question 1\n(1b) any five', noSleep)
  assert.deepEqual(out.questions.map((q) => q.countBest), [5, null])
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

test('the wait Groq asks for is read from its message', async () => {
  const { groqWaitMs } = await import('../src/lib/groq.js')
  assert.equal(groqWaitMs('Rate limit reached ... Please try again in 10.9125s. Need more tokens?'), 11413)
  assert.equal(groqWaitMs('Please try again in 1m2.5s'), 60000)
  assert.equal(groqWaitMs('busy'), null)
})

test('the free tier per minute limit is waited out, one question at a time', async () => {
  const waits = []
  let inFlight = 0
  let most = 0
  let calls = 0
  globalThis.fetch = async (_url, req) => {
    inFlight++
    most = Math.max(most, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    inFlight--
    calls++
    if (calls <= 4) {
      return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'tokens per minute (TPM): Limit 8000. Please try again in 10.9125s.' }
    }
    const text = JSON.parse(req.body).messages[1].content
    const n = /Question (\d+)/i.exec(text)[1]
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [{ number: n }] }) } }] }) }
  }
  const out = await parseMarkingSchemeDocument(GUIDE, { sleep: async (ms) => waits.push(ms) })
  assert.equal(most, 1)
  assert.deepEqual(out.questions.map((q) => q.number), ['1', '2', '7'])
  assert.deepEqual(waits, [11413, 11413, 11413, 11413])
})

test('table blocks move to the question they name, whole', () => {
  const text = 'Question 4\n(4d) Classful\nQuestion 5\n(5a) Compare LAN, MAN, WAN\n\nQuestion 6\n(6a) Switching\n[TABLE for 5a]\n| Criteria | LAN (3 Marks) |\n| --- | --- |\n| Cost | Low |\n[END TABLE]'
  const pieces = splitGuideByQuestion(text)
  assert.equal(pieces.length, 3)
  assert.match(pieces[1], /\(5a\)[\s\S]*\[TABLE for 5a\]\n\| Criteria \| LAN \(3 Marks\) \|\n\| --- \| --- \|\n\| Cost \| Low \|\n\[END TABLE\]$/)
  assert.doesNotMatch(pieces[2], /TABLE/)
})

test('the guide reader is told to trust table blocks and keep heading marks and bands as printed', async () => {
  let system = ''
  globalThis.fetch = async (_url, req) => {
    system = JSON.parse(req.body).messages[0].content
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"questions":[{"number":"5"}]}' } }] }) }
  }
  await parseMarkingSchemeDocument('Question 5\n(5a)', noSleep)
  assert.match(system, /trust the TABLE block/)
  assert.match(system, /Do not copy them onto every row/)
  assert.match(system, /do not\s+turn bands into marking points/)
})

test('a page is read for drawings and tables, waiting out a busy reply', async () => {
  const { describeGuideFigures } = await import('../src/lib/groq.js')
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'Please try again in 2s' }
    const content = JSON.stringify({ figures: [], tables: [{ question: '5a', markdown: '| a | b |\n| c | d |' }, { question: null, markdown: 'not a table' }] })
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
  }
  const waits = []
  const out = await describeGuideFigures('data:image/jpeg;base64,x', 'text', { sleep: async (ms) => waits.push(ms) })
  assert.equal(calls, 2)
  assert.deepEqual(waits, [2500])
  assert.equal(out.ok, true)
  assert.deepEqual(out.tables, [{ question: '5a', markdown: '| a | b |\n| c | d |' }])
})

test('a page the vision model cannot reach comes back as not checked', async () => {
  const { describeGuideFigures } = await import('../src/lib/groq.js')
  globalThis.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad' })
  const out = await describeGuideFigures('data:image/jpeg;base64,x', 'text', noSleep)
  assert.deepEqual(out, { figures: [], tables: [], ok: false })
})

test('a student\'s table is copied cell by cell and never capped for labels', async () => {
  const { describeDiagramFromImage } = await import('../src/lib/groq.js')
  const reply = (o) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(o) } }] }) }) }
  reply({ present: false, labelled: false, description: '', table: '| | LAN | WAN |\n| Cost | Low | High |' })
  const onlyTable = await describeDiagramFromImage(['data:x'], { text: 'Compare LAN and WAN' })
  assert.equal(onlyTable.present, true)
  assert.equal(onlyTable.labelled, true)
  assert.match(onlyTable.description, /^Table written by the student \(copied cell by cell\):\n\| \| LAN \| WAN \|\n\| Cost \| Low \| High \|$/)
  reply({ present: true, labelled: false, description: 'Star topology, no labels', table: '' })
  const drawing = await describeDiagramFromImage(['data:x'], { text: 'Draw a star topology' })
  assert.equal(drawing.labelled, false)
  assert.equal(drawing.description, 'Star topology, no labels')
  reply({ present: false, labelled: false, description: '', table: '' })
  assert.equal((await describeDiagramFromImage(['data:x'], { text: 'x' })).present, false)
})

test('part marks printed in headings replace an even split from the parser', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: [
      { number: '6', subLabel: 'a', maxMarks: 2.92, questionTotal: 17.5, points: [] },
      { number: '6', subLabel: 'b', maxMarks: 2.92, questionTotal: 17.5, points: [] },
    ] }) } }] }),
  })
  const out = await parseMarkingSchemeDocument('Question 6 (17.5 Marks)\n(6a) Identification of Entities. (2.5 Marks)\n[printed 4 Marks changed to 2.5 Marks.]\n(6b) Attributes for each entity. (3 Marks)', noSleep)
  assert.deepEqual(out.questions.map((q) => q.maxMarks), [2.5, 3])
})
