// Deletes ALL sessions, scripts, scanned pages, guides, and users EXCEPT the
// one account whose email you set below. Run this yourself, locally, when
// you want to start testing from a clean slate.
//
// HOW TO USE:
//   1. Set KEEP_EMAIL below to your own login email, exactly as it appears
//      in your User table.
//   2. Run:  node scripts/reset-database.js
//   3. It first PRINTS what it's about to delete and asks you to confirm by
//      typing "yes" before touching anything. Nothing is deleted until you
//      confirm.
//
// This is IRREVERSIBLE. There is no undo. Do not run this against a
// database you care about without being sure.

import readline from 'readline'
import prisma from '../src/lib/prisma.js'

const KEEP_EMAIL = 'somancreatives@gmail.com' // <-- change this to your own account's email

async function main() {
  if (KEEP_EMAIL === 'somancreatives@gmail.com') {
    console.error('Edit KEEP_EMAIL at the top of this script to your real email first, then run it again.')
    process.exit(1)
  }

  const keepUser = await prisma.user.findUnique({ where: { email: KEEP_EMAIL } })
  if (!keepUser) {
    console.error(`No user found with email "${KEEP_EMAIL}". Double check it matches exactly, then try again.`)
    process.exit(1)
  }

  const sessionCount = await prisma.markingSession.count()
  const guideCount = await prisma.markingGuide.count()
  const scriptCount = await prisma.script.count()
  const userCountToDelete = await prisma.user.count({ where: { email: { not: KEEP_EMAIL } } })

  console.log('About to permanently delete:')
  console.log(`  - ${sessionCount} marking session(s), and everything under them (scripts, pages, scores)`)
  console.log(`  - ${guideCount} marking guide(s) and their questions`)
  console.log(`  - ${scriptCount} scanned script(s) total`)
  console.log(`  - ${userCountToDelete} user account(s)`)
  console.log(`Keeping only: ${keepUser.name} <${keepUser.email}>`)
  console.log('')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => rl.question('Type "yes" to proceed: ', resolve))
  rl.close()

  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Cancelled. Nothing was deleted.')
    process.exit(0)
  }

  // Order matters: delete sessions and guides first (their children cascade
  // automatically), THEN users, since sessions/guides reference their
  // creator and would block user deletion otherwise.
  await prisma.markingSession.deleteMany({})
  await prisma.markingGuide.deleteMany({})
  await prisma.user.deleteMany({ where: { email: { not: KEEP_EMAIL } } })

  console.log('Done. Database reset, your account was kept.')
  process.exit(0)
}

main().catch((err) => {
  console.error('Something went wrong, nothing may have been fully deleted:', err)
  process.exit(1)
})