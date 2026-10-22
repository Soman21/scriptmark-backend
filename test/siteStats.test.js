import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePath, cleanLabel, referrerHost, dayRange } from '../src/lib/siteStats.js'

test('paths lose their ids and codes', () => {
  assert.equal(normalizePath('/sessions/cm2abcdefghijklmnop/results?x=1'), '/sessions/:id/results')
  assert.equal(normalizePath('/courses/ECE%20432'), '/courses/:code')
  assert.equal(normalizePath('/join/KXL963'), '/join/:code')
  assert.equal(normalizePath('/guides'), '/guides')
  assert.equal(normalizePath(''), '/')
})

test('click labels with numbers are dropped, long ones cut', () => {
  assert.equal(cleanLabel('  Export   to Excel '), 'Export to Excel')
  assert.equal(cleanLabel('Ada Obi, 2017364085'), null)
  assert.equal(cleanLabel(''), null)
  assert.equal(cleanLabel('x'.repeat(80)).length, 60)
})

test('only the referring site name is kept, never our own', () => {
  assert.equal(referrerHost('https://www.google.com/search?q=scriptmark', 'scriptmark.vercel.app'), 'google.com')
  assert.equal(referrerHost('https://scriptmark.vercel.app/login', 'scriptmark.vercel.app'), null)
  assert.equal(referrerHost('not a url', 'x'), null)
})

test('the day range ends today in Lagos and has no gaps', () => {
  const days = dayRange(7, new Date('2026-10-22T23:30:00Z'))
  assert.equal(days.length, 7)
  assert.equal(days[6], '2026-10-23') // 00:30 in Lagos
  assert.equal(days[0], '2026-10-17')
})
