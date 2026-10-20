import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTodayList } from '../src/lib/today.js'

const q = (id, number, assignedMarkerId = null) => ({ id, number, subLabel: null, assignedMarkerId })
const ans = (questionId, suggestedScore, confirmedScore = null) => ({ questionId, suggestedScore, confirmedScore })

function session(over = {}) {
  return {
    id: 's1',
    title: 'Signals',
    courseCode: 'ECE 301',
    status: 'ACTIVE',
    createdById: 'coord',
    classList: null,
    guide: { questions: [q('q1', '1', 'coord'), q('q2', '2', 'chidi'), q('q3', '3')] },
    markers: [{ userId: 'chidi', status: 'APPROVED', accessLevel: 'LIMITED' }],
    scripts: [
      { id: 'a', status: 'SCORED', regNumber: '2019364001', answers: [ans('q1', 5), ans('q2', 4), ans('q3', 3)] },
      { id: 'b', status: 'SCORED', regNumber: '2019364002', answers: [ans('q1', 6, 6), ans('q2', 2), ans('q3', 3)] },
    ],
    ...over,
  }
}

test('the coordinator sees their own queue and unclaimed questions, with links', () => {
  const items = buildTodayList([session()], 'coord')
  const queue = items.find((i) => i.kind === 'queue')
  assert.equal(queue.text, '1 answer is waiting for you to confirm')
  assert.equal(queue.link, '/sessions/s1/my-queue')
  assert.match(items.find((i) => i.kind === 'claim').text, /1 question has no marker: Q3/)
  assert.equal(items.find((i) => i.kind === 'others').text, "4 answers on other markers' questions still to be confirmed")
})

test('a lecturer marking alone is told how many answers still need confirming', () => {
  const items = buildTodayList([session({ markers: [] })], 'coord')
  const confirm = items.find((i) => i.kind === 'confirm')
  assert.equal(confirm.text, '4 answers still need confirming')
  assert.equal(confirm.link, '/sessions/s1/results')
  assert.ok(!items.some((i) => i.kind === 'claim'))
})

test('a limited marker sees only their own queue', () => {
  const items = buildTodayList([session()], 'chidi')
  assert.deepEqual(items.map((i) => i.kind), ['queue'])
  assert.equal(items[0].count, 2)
})

test('setup steps come first, and completed sessions are skipped', () => {
  const items = buildTodayList(
    [session({ id: 's2', guide: null }), session({ id: 's3', scripts: [] }), session({ id: 's4', status: 'COMPLETED' })],
    'coord'
  )
  assert.deepEqual(items.map((i) => [i.sessionId, i.kind]), [['s2', 'guide'], ['s3', 'scan']])
})

test('flagged, scanned twice, waiting joiners and ready to export are reported', () => {
  const done = [ans('q1', 5, 5), ans('q2', 4, 4), ans('q3', 3, 3)]
  const s = session({
    markers: [{ userId: 'chidi', status: 'APPROVED' }, { userId: 'ada', status: 'PENDING' }],
    guide: { questions: [q('q1', '1', 'coord'), q('q2', '2', 'chidi'), q('q3', '3', 'coord')] },
    scripts: [
      { id: 'a', status: 'REVIEWED', regNumber: '2019364001', answers: done },
      { id: 'b', status: 'FLAGGED', regNumber: '2019/364001', answers: done },
    ],
  })
  const kinds = buildTodayList([s], 'coord').map((i) => i.kind)
  assert.deepEqual(kinds, ['join', 'flagged', 'duplicates', 'export'])
})
