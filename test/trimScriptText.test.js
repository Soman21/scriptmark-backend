import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimForMarking, PAGE_BREAK } from '../src/lib/trimScriptText.js'

const join = (...pages) => pages.join(PAGE_BREAK)

test('removes a header that repeats on most pages, even when OCR spells it differently', () => {
  const text = join(
    'NNAMDI AZIKIWE UNIVERSITY AWKA\nQ1 the answer is ten',
    'NNAMDl AZIKIWE UNIVERSITY AWKA\ncontinued working here',
    'NNAMDI AZIKIWE UNIVERSITY, AWKA\nQ2 another answer',
    'Q3 no header read on this page'
  )
  const out = trimForMarking(text)
  assert.ok(!/AZIKIWE/i.test(out))
  assert.match(out, /Q1 the answer is ten/)
  assert.match(out, /continued working here/)
  assert.match(out, /Q3 no header read on this page/)
})

test('keeps short lines the student may have repeated', () => {
  const text = join('Ans\nfirst', 'Ans\nsecond', 'Ans\nthird')
  assert.equal((trimForMarking(text).match(/Ans/g) || []).length, 3)
})

test('keeps a line that repeats on only a few of many pages', () => {
  const pages = Array.from({ length: 8 }, (_, i) => `page body number ${i}\nSOME REPEATED SENTENCE`.replace('SOME REPEATED SENTENCE', i < 2 ? 'SOME REPEATED SENTENCE' : 'other text ' + i))
  assert.match(trimForMarking(join(...pages)), /SOME REPEATED SENTENCE/)
})

test('removes page numbers, symbol only lines and blank lines', () => {
  const out = trimForMarking('Q1 work\n\n  3  \n-----\n*\nPage 4 of 10\nresult 42')
  assert.equal(out, 'Q1 work\nresult 42')
})

test('does not touch answer text and keeps page breaks', () => {
  const text = join('Define a database\nA database is a collection', 'Normalisation removes redundancy')
  assert.equal(trimForMarking(text), text)
})

test('empty or short scripts come back unchanged', () => {
  assert.equal(trimForMarking(''), '')
  assert.equal(trimForMarking('one line'), 'one line')
})
