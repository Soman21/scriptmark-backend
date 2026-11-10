import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teamCheck } from '../src/lib/teamCheck.js'

const q = (assignedMarkerId = null) => ({ assignedMarkerId })

test('asks when the coordinator is alone and questions are unclaimed', () => {
  const out = teamCheck({ markers: [{ userId: 'me' }], questions: [q(), q('me'), q()], userId: 'me' })
  assert.deepEqual(out, { otherLecturers: 0, unclaimed: 2, askToAddLecturers: true })
})

test('does not ask once another lecturer has joined', () => {
  const out = teamCheck({ markers: [{ userId: 'me' }, { userId: 'chidi' }], questions: [q()], userId: 'me' })
  assert.equal(out.askToAddLecturers, false)
  assert.equal(out.otherLecturers, 1)
})

test('does not ask when every question already has a lecturer', () => {
  const out = teamCheck({ markers: [{ userId: 'me' }], questions: [q('me'), q('me')], userId: 'me' })
  assert.equal(out.askToAddLecturers, false)
})

test('does not ask when there is no guide yet', () => {
  assert.equal(teamCheck({ markers: [{ userId: 'me' }], questions: [], userId: 'me' }).askToAddLecturers, false)
})

test('an admin who is not a marker still counts the coordinator as another lecturer', () => {
  const out = teamCheck({ markers: [{ userId: 'coord' }], questions: [q()], userId: 'admin' })
  assert.equal(out.askToAddLecturers, false)
})
