import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resultRow } from '../src/lib/resultRows.js'

const confirmed = (n) => ({ confirmedAt: new Date(), confirmedScore: n })
const script = (answers, caScore = null) => ({ studentName: 'Ada Obi', regNumber: '2019364001', caScore, answers })

test('exam only sheet shows the confirmed exam score and no grade', () => {
  assert.deepEqual(resultRow(script([confirmed(40), confirmed(12)]), 'exam'), { name: 'Ada Obi', regNumber: '2019364001', exam: 52, note: '' })
})

test('an unconfirmed answer keeps the exam score off the sheet', () => {
  const row = resultRow(script([confirmed(40), { confirmedAt: null, confirmedScore: null }], 25))
  assert.equal(row.exam, null)
  assert.equal(row.grade, '')
  assert.equal(row.note, 'Not fully confirmed')
})

test('CA plus exam gives a total and grade only when the CA is entered', () => {
  assert.deepEqual(resultRow(script([confirmed(45)], 25)), { name: 'Ada Obi', regNumber: '2019364001', ca: 25, exam: 45, total: 70, grade: 'A', note: '' })
  const noCa = resultRow(script([confirmed(45)]))
  assert.deepEqual([noCa.total, noCa.grade, noCa.note], [null, '', 'CA not entered'])
  assert.equal(resultRow(script([confirmed(10)], 0)).grade, 'F', 'a CA of zero still counts as entered')
})
