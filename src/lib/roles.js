// Only the addresses listed here are Admin. Admin sees every session and
// guide, so it is tied to the email rather than stored state: an old token or
// database row that says ADMIN for anyone else is treated as LECTURER.
// ADMIN_EMAILS (comma separated) can override the default for deployments.
const DEFAULT_ADMIN_EMAILS = ['somancreatives@gmail.com']

export function adminEmails() {
  const fromEnv = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  return fromEnv.length ? fromEnv : DEFAULT_ADMIN_EMAILS
}

export function isAdminEmail(email) {
  return adminEmails().includes(String(email || '').trim().toLowerCase())
}

// The role a user really has, whatever the token or row says.
export function effectiveRole(email, storedRole) {
  if (isAdminEmail(email)) return 'ADMIN'
  if (storedRole === 'ADMIN') return 'LECTURER'
  return storedRole || 'LECTURER'
}
