import jwt from 'jsonwebtoken'
import prisma from '../lib/prisma.js'
import { effectiveRole } from '../lib/roles.js'
import { isSuspended, SUSPENDED_MESSAGE, touchLastActive } from '../lib/suspension.js'

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'No token provided. Please log in.' })
  }

  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET)
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' })
  }
  // A token stays valid for days, so suspension is checked on every request,
  // not only at sign in. That is what signs a suspended lecturer out at once.
  if (isSuspended(payload.id)) {
    return res.status(403).json({ error: SUSPENDED_MESSAGE, code: 'SUSPENDED' })
  }
  req.user = { ...payload, role: effectiveRole(payload.email, payload.role, payload.id) }
  touchLastActive(prisma, payload.id)
  next()
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' })
    }
    next()
  }
}
