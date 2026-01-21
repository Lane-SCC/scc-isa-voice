// send_test_email.js
// Usage: set env vars (or copy .env.example -> .env) then run `node tools/send_test_email.js`
// Reads ALERT_EMAIL_TO, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS

const nodemailer = require('nodemailer');
require('dotenv').config();

const to = process.env.ALERT_EMAIL_TO;
const host = process.env.SMTP_HOST;
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

if (!to || !host || !user || !pass) {
  console.error('Missing SMTP config. Fill .env from .env.example with ALERT_EMAIL_TO and SMTP_* values.');
  process.exitCode = 2;
  process.exit();
}

async function sendTest() {
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: {
      user,
      pass,
    },
  });

  const info = await transporter.sendMail({
    from: process.env.ALERT_FROM || `${user}`,
    to,
    subject: 'LFG — Test alert email',
    text: 'This is a test alert from your LFG server. If you received this, email sending is working.',
  });

  console.log('Message sent:', info.messageId || '(no id)');
}

sendTest().catch(err => {
  console.error('Send failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});

