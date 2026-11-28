// Tests for the compact guide copy sent with marking requests. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compactModelAnswer, stripCorrectionNotes, pointKey } from '../src/lib/guideCompact.js'
import { questionsBlockFor } from '../src/lib/groq.js'

test('correction notes are taken out, drawings and tables are kept', () => {
  const text = 'Intro\n[Handwritten correction on the guide: printed 3 Marks changed to 4 Marks.]\n[DIAGRAM for 1d: boxes]\n[TABLE for 5a]\n| a | b |\n[END TABLE]'
  assert.equal(stripCorrectionNotes(text), 'Intro\n[DIAGRAM for 1d: boxes]\n[TABLE for 5a]\n| a | b |\n[END TABLE]')
})

test('point keys ignore bullets and marks', () => {
  assert.equal(pointKey('•\t1.25 marks for using correct E-R notation.'), 'using correct e r notation')
  assert.equal(pointKey('Analog Signals (1.25 Marks)'), 'analog signals')
})

test('model answer lines that repeat a point are left out, the rest kept', () => {
  const answer = [
    '•\t1 mark each for correctly identifying the following entities: Student, Lecturer, Department, Course.',
    '•\tDeduct 0.5 marks for including an incorrect entity (e.g., "Registration").',
    'o\tStudent: Registration Number, Name',
  ].join('\n')
  const steps = [{ description: 'Correctly identifying the following entities: Student, Lecturer, Department, Course', marks: 4 }]
  assert.equal(
    compactModelAnswer(answer, steps),
    '•\tDeduct 0.5 marks for including an incorrect entity (e.g., "Registration").\no\tStudent: Registration Number, Name'
  )
})

test('a line that adds a lot to a point is kept', () => {
  const steps = [{ description: 'Uniqueness', marks: 1 }]
  assert.equal(compactModelAnswer('Uniqueness: ensures each row in a table is uniquely identifiable.', steps).length > 0, true)
})

test('without points the model answer and keywords are sent as before', () => {
  const block = questionsBlockFor([{ id: 'q1', number: '1', text: 'Define OCR', modelAnswer: 'Optical character recognition', keywords: 'OCR', maxMarks: 2 }])
  assert.equal(block, 'Question ID: q1\nQuestion 1: Define OCR\nModel Answer: Optical character recognition\nKeywords: OCR\nMax Marks: 2')
})

test('with points, keywords and an empty model answer are left out', () => {
  const block = questionsBlockFor([
    { id: 'q2', number: '2', subLabel: 'a', text: 'Name two', modelAnswer: '• Alpha (1 mark)\n• Beta (1 mark)', keywords: 'Alpha, Beta', maxMarks: 2, steps: [{ description: 'Alpha', marks: 1 }, { description: 'Beta', marks: 1 }] },
  ])
  assert.equal(block, 'Question ID: q2\nQuestion 2a: Name two\nMax Marks: 2\nMarking Points:\n  1. Alpha (1 marks)\n  2. Beta (1 marks)')
})
