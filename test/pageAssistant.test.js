import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPageContext, cleanPageReply } from '../src/lib/pageAssistant.js'

const q = (id, number, subLabel, assignedMarkerId = null) => ({ id, guideId: 'g', number, subLabel, maxMarks: 5, text: 'x', assignedMarkerId })
const claimData = {
  questions: [q('a', '1', 'a'), q('b', '1', 'b', 'other'), q('c', '2', null, 'me')],
  markers: [{ id: 'me', name: 'Bola' }, { id: 'other', name: 'Chidi' }],
  canManage: false,
}

test('question 1 means every part, and taken questions are left out for a marker', () => {
  const { refs, context } = buildPageContext('claim', claimData, 'me')
  assert.match(context, /Q1b: question 1b .* claimed by another marker/)
  const out = cleanPageReply('claim', { reply: 'Done.', actions: [{ type: 'claim', questions: ['question 1'] }] }, refs, { userId: 'me', canManage: false })
  assert.deepEqual(out.actions, [{ type: 'claim', questionIds: ['a'], labels: ['1a'] }])
})

test('a marker can only unclaim their own, and cannot assign', () => {
  const { refs } = buildPageContext('claim', claimData, 'me')
  const out = cleanPageReply('claim', { actions: [{ type: 'unclaim', questions: ['Q1b', 'Q2'] }, { type: 'assign', questions: ['Q1a'], marker: 'M2' }] }, refs, { userId: 'me', canManage: false })
  assert.deepEqual(out.actions, [{ type: 'unclaim', questionIds: ['c'], labels: ['2'] }])
})

test('a coordinator can hand a question to a marker', () => {
  const { refs } = buildPageContext('claim', { ...claimData, canManage: true }, 'me')
  const out = cleanPageReply('claim', { actions: [{ type: 'assign', questions: ['1a'], marker: 'M2' }] }, refs, { userId: 'me', canManage: true })
  assert.deepEqual(out.actions, [{ type: 'assign', questionIds: ['a'], labels: ['1a'], targetUserId: 'other' }])
})

test('queue confirmations skip confirmed answers and keep scores inside the marks', () => {
  const answers = [
    { id: 'x', question: { number: '1', subLabel: 'b', maxMarks: 5 }, script: { studentName: 'Ada' }, suggestedScore: 4, confidence: 'high', confirmedAt: null },
    { id: 'y', question: { number: '1', subLabel: 'b', maxMarks: 5 }, script: { studentName: 'Emeka' }, suggestedScore: 2, confirmedAt: new Date(), confirmedScore: 2 },
    { id: 'z', question: { number: '1', subLabel: 'b', maxMarks: 5 }, script: { studentName: 'Chika' }, suggestedScore: 3, confirmedAt: null },
  ]
  const { refs } = buildPageContext('queue', { answers }, 'me')
  const out = cleanPageReply('queue', { actions: [{ type: 'confirm', items: [{ answer: 'A1' }, { answer: 'A2', score: 5 }, { answer: 'A3', score: 9.7 }] }] }, refs)
  assert.deepEqual(out.actions[0].items.map((i) => [i.answerId, i.score]), [['x', 4], ['z', 5]])
})

test('results opens one script that is on the page, and analytics never acts', () => {
  const scripts = [{ id: 's1', studentName: 'Ada', status: 'SCORED', answers: [] }]
  const { refs } = buildPageContext('results', { scripts }, 'me')
  assert.deepEqual(cleanPageReply('results', { actions: [{ type: 'open', script: 'S9' }, { type: 'open', script: 'S1' }] }, refs).actions, [{ type: 'open', scriptId: 's1', student: 'Ada' }])
  assert.deepEqual(cleanPageReply('analytics', { reply: 'Hi', actions: [{ type: 'open', script: 'S1' }] }, refs).actions, [])
})
