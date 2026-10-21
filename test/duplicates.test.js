import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDuplicateFlags, duplicateKey } from '../src/lib/duplicates.js'

test('scripts sharing a reg number point at each other', () => {
  const out = withDuplicateFlags([
    { id: 'a', regNumber: '2019364002' },
    { id: 'b', regNumber: '2019364001' },
    { id: 'c', regNumber: ' 2019364002 ' },
  ])
  assert.deepEqual(out.map((s) => s.duplicateOf), [['c'], [], ['a']])
})

test('the slash and letter case do not hide a duplicate', () => {
  assert.equal(duplicateKey('2021/245678'), duplicateKey('2021245678'))
  assert.equal(duplicateKey('2025366001fn'), duplicateKey('2025366001FN'))
})

test('scripts with no reg number yet are never flagged', () => {
  const out = withDuplicateFlags([{ id: 'a', regNumber: null }, { id: 'b', regNumber: '' }])
  assert.deepEqual(out.map((s) => s.duplicateOf), [[], []])
})
