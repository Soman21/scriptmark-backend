// Sends emails via Resend's simple REST API. Free tier: 100/day, 3000/month,
// no domain setup needed since we send from Resend's own onboarding address.
const RESEND_API_URL = 'https://api.resend.com/emails'

export async function sendEmail({ to, subject, html }) {
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'ScriptMark <onboarding@resend.dev>',
      to,
      subject,
      html,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Resend API error (${res.status}): ${errText}`)
  }

  return res.json()
}

export function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}
// Testing deployment