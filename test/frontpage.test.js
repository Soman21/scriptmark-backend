// Tests for reading the reg number off a script's front page, using OCR
// text shaped like the UNIZIK answer booklet (labels printed under each
// box, a booklet serial near S/N, a session line, no name field) and a
// fake fetch so no real Groq requests are made. Run with: npm test
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { cleanRegNumber, findRegNumberCandidates, pickRegNumber } from '../src/lib/roster.js'
import { extractStudentInfo } from '../src/lib/groq.js'

// Value lines come BEFORE their labels, as on the booklet.
const bookletText = `NNAMDI AZIKIWE UNIVERSITY, AWKA
S/N: 25/B1/
89487
Complete the following in BLOCK LETTERS
EXAMINER'S USE ONLY
2021/ 24567O
STUDENT'S REG. NO
STUDENT'S SIGNATURE
ECE 512
COURSE CODE
DIGITAL SIGNAL PROCESSING
COURSE TITLE
ELECTRONIC AND COMPUTER ENGINEERING
STUDENT'S DEPARTMENT
ENGINEERING
STUDENT'S FACULTY
12 03 2026
DAY MONTH YEAR
EXAMINATION DATE
FIRST
SEMESTER
2025/2026
SESSION
INSTRUCTIONS OF CANDIDATES
1. Begin your answer to each question on a fresh page`

const classList = [
  { id: 'a', name: 'ADA OKAFOR', regNumber: '2021/245670', flagged: false },
  { id: 'b', name: 'CHIDI EZE', regNumber: '2021/245611', flagged: false },
]

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function fakeModel(content) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  })
}

test('cleanRegNumber removes spaces and fixes O and l read in place of digits', () => {
  assert.equal(cleanRegNumber(' 2021 / 24567O '), '2021/245670')
  assert.equal(cleanRegNumber('2019\\1l2345'), '2019/112345')
})

test('cleanRegNumber rejects the session line, the booklet serial and junk', () => {
  assert.equal(cleanRegNumber('2025/2026'), null)
  assert.equal(cleanRegNumber('25/B1/89487'), null)
  assert.equal(cleanRegNumber('ECE 512'), null)
  assert.equal(cleanRegNumber(null), null)
})

test('findRegNumberCandidates finds only the handwritten reg number on the booklet', () => {
  assert.deepEqual(findRegNumberCandidates(bookletText), ['2021/245670'])
})

test('pickRegNumber prefers a page candidate on the class list over a wrong AI pick', () => {
  const text = 'STUDENT\'S REG. NO\n2021/245611\nsome answer mentioning 2020/999999'
  assert.equal(pickRegNumber('2020/999999', text, classList), '2021/245611')
})

test('pickRegNumber keeps the AI pick when there is no class list', () => {
  assert.equal(pickRegNumber('2020/999999', 'also 2021/245611 here', []), '2020/999999')
})

test('pickRegNumber returns null when nothing on the page is reg number shaped', () => {
  assert.equal(pickRegNumber('25/B1/89487', 'S/N: 25/B1/89487\n2025/2026 SESSION', classList), null)
})

test('extractStudentInfo cleans the AI reg number pick', async () => {
  fakeModel({ name: null, regNumber: '2021/ 24567O' })
  assert.deepEqual(await extractStudentInfo(bookletText, classList), { name: null, regNumber: '2021/245670' })
})

test('extractStudentInfo falls back to the page when the AI picks the booklet serial', async () => {
  fakeModel({ name: null, regNumber: '25/B1/89487' })
  const info = await extractStudentInfo(bookletText)
  assert.equal(info.regNumber, '2021/245670')
})

test('extractStudentInfo still reads the page when the AI request fails', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 })
  const info = await extractStudentInfo(bookletText, classList)
  assert.deepEqual(info, { name: null, regNumber: '2021/245670' })
})

test('extractStudentInfo returns nulls for an empty page without calling the AI', async () => {
  globalThis.fetch = async () => {
    throw new Error('should not be called')
  }
  assert.deepEqual(await extractStudentInfo('   '), { name: null, regNumber: null })
})
