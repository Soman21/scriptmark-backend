import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'
import { sendEmail, sixDigitCode } from '../lib/email.js'

const router = express.Router()

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  )
}

router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, role } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' })
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: ['LECTURER', 'REVIEWER', 'ADMIN'].includes(role) ? role : 'LECTURER',
      },
    })

    const token = signToken(user)
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Something went wrong creating your account.' })
  }
})

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const token = signToken(user)
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Something went wrong logging you in.' })
  }
})


// --- Forgot password ---
// POST /api/auth/forgotPassword - body: { email }
// Always responds the same way whether or not the email exists, so an
// attacker can't use this to discover which emails have accounts.
router.post('/forgotPassword', async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ error: 'Email is required.' })

    const user = await prisma.user.findUnique({ where: { email } })
    if (user) {
      const code = sixDigitCode()
      const codeHash = await bcrypt.hash(code, 10)
      await prisma.verificationCode.create({
        data: {
          userId: user.id,
          codeHash,
          purpose: 'PASSWORD_RESET',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
        },
      })

      try {
        await sendEmail({
          to: user.email,
          subject: 'Your ScriptMark password reset code',
          html: `<p>Hi ${user.name},</p><p>Your password reset code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p><p>This code expires in 15 minutes. If you did not request this, you can ignore this email.</p>`,
        })
      } catch (emailErr) {
        console.error('Failed to send reset email:', emailErr)
      }
    }

    res.json({ message: 'If that email has an account, a reset code has been sent.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Something went wrong.' })
  }
})

// POST /api/auth/resetPassword - body: { email, code, newPassword }
router.post('/resetPassword', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are all required.' })
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' })
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const recentCodes = await prisma.verificationCode.findMany({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })

    let matchedCode = null
    for (const c of recentCodes) {
      if (await bcrypt.compare(code, c.codeHash)) {
        matchedCode = c
        break
      }
    }

    if (!matchedCode) {
      return res.status(400).json({ error: 'Invalid or expired code.' })
    }

    const passwordHash = await bcrypt.hash(newPassword, 10)
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } })
    await prisma.verificationCode.update({ where: { id: matchedCode.id }, data: { used: true } })

    res.json({ message: 'Password updated. You can now log in with your new password.' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Something went wrong.' })
  }
})

export default router
