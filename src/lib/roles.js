// Admin comes from two places only: the Admin email list, and accounts the
// owner made Admin on the Admin page (the AdminGrant table). A stored role
// or an old token that says ADMIN for anyone else is treated as LECTURER.
// ADMIN_EMAILS (comma separated) can override the default for deployments.
const DEFAULT_ADMIN_EMAILS = ['somancreatives@gmail.com']

// The owner can add and remove Admins, and can never be removed.
export const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'somancreatives@gmail.com').trim().toLowerCase()

export function adminEmails() {
  const fromEnv = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return fromEnv.length ? fromEnv : DEFAULT_ADMIN_EMAILS
}

export function isAdminEmail(email) {
  const e = String(email || '').trim().toLowerCase()
  return e === OWNER_EMAIL || adminEmails().includes(e)
}

export const isOwner = (email) => String(email || '').trim().toLowerCase() === OWNER_EMAIL

// Granted Admins are kept in memory so every request can check them without
// a database query. The set is loaded at start up, reloaded after every
// change on the Admin page, and refreshed once a minute.
let grantedIds = new Set()

export async function loadAdminGrants(prisma) {
  try {
    const grants = await prisma.adminGrant.findMany({ select: { userId: true } })
    grantedIds = new Set(grants.map((g) => g.userId))
  } catch (err) {
    console.error('Loading admin grants failed:', err)
  }
}

export const isGrantedAdmin = (userId) => !!userId && grantedIds.has(userId)

// The role a user really has, whatever the token or row says.
export function effectiveRole(email, storedRole, userId) {
  if (isAdminEmail(email) || isGrantedAdmin(userId)) return 'ADMIN'
  if (storedRole === 'ADMIN') return 'LECTURER'
  return storedRole || 'LECTURER'
}
