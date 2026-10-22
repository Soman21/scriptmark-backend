import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReminders } from '../src/lib/notifications.js'

const q = (number, assignedMarkerId = null) => ({ number, subLabel: null, assignedMarkerId })
const session = (over = {}) => ({
  id: 's1', title: 'ECE 432 Examination', courseCode: 'ECE 432', status: 'ACTIVE', createdById: 'boss',
  guide: { isDraft: false, questions: [q('1', 'boss'), q('2'), q('3')] },
  markers: [{ userId: 'boss', status: 'APPROVED', accessLevel: 'FULL' }, { userId: 'me', status: 'APPROVED', accessLevel: 'LIMITED' }],
  ...over,
})

test('a lecturer who has claimed nothing on a published guide is reminded', () => {
  const r = buildReminders([session()], 'me')
  assert.deepEqual(r.map((x) => x.type), ['REMINDER_CLAIM'])
  assert.equal(r[0].link, '/sessions/s1/claim-questions')
})

test('the reminder goes once a question is claimed, or while the guide is a draft', () => {
  assert.deepEqual(buildReminders([session({ guide: { isDraft: false, questions: [q('1', 'me'), q('2')] } })], 'me'), [])
  assert.deepEqual(buildReminders([session({ guide: { isDraft: true, questions: [q('1')] } })], 'me'), [])
  assert.deepEqual(buildReminders([session({ guide: null })], 'me'), [])
})

test('the coordinator sees unclaimed questions once others have joined', () => {
  const r = buildReminders([session()], 'boss')
  assert.deepEqual(r.map((x) => x.type), ['REMINDER_UNCLAIMED'])
  assert.match(r[0].text, /^Q2, Q3 unclaimed in ECE 432$/)
  const alone = session({ markers: [{ userId: 'boss', status: 'APPROVED', accessLevel: 'FULL' }] })
  assert.deepEqual(buildReminders([alone], 'boss'), [])
})

test('a pending lecturer gets no reminders', () => {
  const s = session({ markers: [{ userId: 'boss', status: 'APPROVED', accessLevel: 'FULL' }, { userId: 'me', status: 'PENDING', accessLevel: 'LIMITED' }] })
  assert.deepEqual(buildReminders([s], 'me'), [])
})
