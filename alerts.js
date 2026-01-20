// alerts.js
// Lightweight alert helper module. Require and call `alertAdmins(type, title, message, details)` from your server.
// This file expects environment variables to be set (or loaded via dotenv in your main server):
// SLACK_WEBHOOK_URL, ALERT_WEBHOOK_URL, ALERT_EMAIL_TO, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_FROM

const fetch = require('node-fetch');
let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // nodemailer optional — email alerts will be skipped if not installed
}

function sendSlackMessage(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return Promise.resolve();
  return fetch(url, { method: 'POST', body: JSON.stringify({ text }), headers: { 'Content-Type': 'application/json' } });
}

function sendWebhook(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return Promise.resolve();
  return fetch(url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
}

async function sendAlertEmail(subject, text) {
  if (!nodemailer) return Promise.resolve();
  const to = process.env.ALERT_EMAIL_TO;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!to || !host || !user || !pass) return Promise.resolve();

  const transporter = nodemailer.createTransport({
    host,
    port: port || 587,
    secure: port === 465,
    auth: { user, pass },
  });

  return transporter.sendMail({ from: process.env.ALERT_FROM || user, to, subject, text });
}

async function alertAdmins(type, title, message, details = {}) {
  const payload = { type, title, message, details, timestamp: new Date().toISOString() };
  try {
    await Promise.all([
      sendSlackMessage(`*${title}*\n${message}`),
      sendWebhook(payload),
      sendAlertEmail(`${title}`, `${message}\n\n${JSON.stringify(details, null, 2)}`),
    ]);
  } catch (err) {
    console.error('alertAdmins error:', err && err.message ? err.message : err);
  }
}

module.exports = { sendSlackMessage, sendWebhook, sendAlertEmail, alertAdmins };
