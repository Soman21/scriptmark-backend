// Tests for the Settings routes (profile name and password change), run
// against the real Express router with Prisma's user methods stubbed, so
// no database is needed. Run with: npm test
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import prisma from '../src/lib/prisma.js'
import authRoutes from '../src/routes/auth.js'

process.env.JWT_SECRET = 'test_secret'
let server
let base
let stored
const original = { update: prisma.user.update, findUnique: prisma.user.findUnique }

before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRoutes)
  await new Promise((resolve) => {
    server = app.listen(0, resolve)
  })
  base = `http://127.0.0.1:${server.address().port}/api/auth`
})

after(() => {
  prisma.user.update = original.update
  prisma.user.findUnique = original.findUnique
  server.close()
})

beforeEach(async () => {
  stored = { id: 'u1', name: 'Ann', email: 'ann@unizik.edu.ng', role: 'LECTURER', passwordHash: await bcrypt.hash('oldpassword', 4) }
  prisma.user.findUnique = async ({ where }) => (where.id === stored.id ? { ...stored } : null)
  prisma.user.update = async ({ where, data }) => {
    assert.equal(where.id, stored.id)
    stored = { ...stored, ...data }
    return { ...stored }
  }
})

const token = () => jwt.sign({ id: 'u1', email: 'ann@unizik.edu.ng', name: 'Ann', role: 'LECTURER' }, 'test_secret')
const call = (path, body, auth = true) =>
  fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token()}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

test('PUT /me renames the user and returns a token carrying the new name', async () => {
  const r = await call('/me', { name: '  Ann Nwachukwu ' })
  assert.equal(r.status, 200)
  assert.equal(r.body.user.name, 'Ann Nwachukwu')
  assert.equal(jwt.verify(r.body.token, 'test_secret').name, 'Ann Nwachukwu')
})

test('PUT /me rejects an empty name and a missing token', async () => {
  assert.equal((await call('/me', { name: '   ' })).status, 400)
  assert.equal((await call('/me', { name: 'X' }, false)).status, 401)
})

test('PUT /password changes the hash only when the current password matches', async () => {
  const wrong = await call('/password', { currentPassword: 'nope', newPassword: 'newpassword1' })
  assert.equal(wrong.status, 400)
  assert.match(wrong.body.error, /current password is not correct/)

  const ok = await call('/password', { currentPassword: 'oldpassword', newPassword: 'newpassword1' })
  assert.equal(ok.status, 200)
  assert.ok(await bcrypt.compare('newpassword1', stored.passwordHash))
})

test('PUT /password enforces 8 characters and a different password', async () => {
  assert.equal((await call('/password', { currentPassword: 'oldpassword', newPassword: 'short' })).status, 400)
  const same = await call('/password', { currentPassword: 'oldpassword', newPassword: 'oldpassword' })
  assert.equal(same.status, 400)
  assert.match(same.body.error, /different/)
})
