// Sends emails via Nodemailer over Gmail's SMTP server, authenticated with a
// Google App Password (not your real Gmail password). Unlike Resend's free
// tier, this can send to ANY recipient right away, no domain verification
// needed. Gmail always overwrites the sender address to match whichever
// account authenticated, so emails arrive from GMAIL_USER, not a custom
// "noreply@..." address. Free up to 500 emails/day, which is far more than
// this project needs.
import nodemailer from 'nodemailer'

let transporter = null

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    })
  }
  return transporter
}

export async function sendEmail({ to, subject, html }) {
  try {
    const info = await getTransporter().sendMail({
      from: `ScriptMark <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    })
    return info
  } catch (err) {
    throw new Error(`Gmail SMTP error: ${err.message}`)
  }
}

export function sixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}