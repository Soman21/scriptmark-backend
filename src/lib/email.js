// Sends emails via Nodemailer, using Brevo's SMTP relay on port 2525.
// Render's free tier blocks outbound traffic on the standard SMTP ports
// (25, 465, 587), which is why Gmail SMTP could not work there. Port 2525
// is not one of the blocked ports, and Brevo documents it specifically as
// the workaround for hosts that block the standard ones. Brevo also does
// not require domain verification, only a single verified sender address,
// and the free plan allows 300 emails/day with no expiration.
import nodemailer from 'nodemailer'

let transporter = null

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 2525,
      secure: false, // 2525 and 587 are unencrypted at connect, then upgrade via STARTTLS
      auth: {
        user: process.env.BREVO_SMTP_USER, // your Brevo login email
        pass: process.env.BREVO_SMTP_KEY, // the SMTP key from Brevo, not your account password
      },
    })
  }
  return transporter
}

export async function sendEmail({ to, subject, html }) {
  try {
    const info = await getTransporter().sendMail({
      from: `ScriptMark <${process.env.BREVO_SENDER_EMAIL}>`, // must be a verified sender in Brevo
      to,
      subject,
      html,
    })
    return info
  } catch (err) {
    throw new Error(`Brevo SMTP error: ${err.message}`)
  }
}

export function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}