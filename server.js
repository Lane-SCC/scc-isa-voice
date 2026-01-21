// PASTE BLOCK 1 of 6
// =========================================================
// SCC ISA TRAINING VOICE SYSTEM — server.js (2026 FINAL — PIN + Realism Engine)
// Node/Express + Twilio Media Streams + OpenAI Realtime
// Block 1: Foundation & Globals (state, scenarios, audit, utilities)
// =========================================================
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const express = require("express");
const { WebSocketServer } = require("ws");
const WSClient = require("ws");

// =========================================================
// Express
// =========================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "3mb" }));

// =========================================================
// Env
// =========================================================
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// OpenAI Realtime
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || "wss://api.openai.com/v1/realtime";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";

// Caller STT model (for scoring)
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

// Borrower voices
const VOICE_MALE = process.env.VOICE_MALE || "alloy";
const VOICE_FEMALE = process.env.VOICE_FEMALE || "verse";

// Twilio REST (required for “end -> score -> post-call menu” reliability)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// Admin API key for privileged endpoints (set in environment)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

// Alerting / Webhooks / Email
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || ""; // generic webhook
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || ""; // comma-separated
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 0;
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const ALERT_FROM = process.env.ALERT_FROM || `alerts@${require('os').hostname()}`;

// Scenarios + logs
const ROOT = process.cwd();
const SCENARIOS_PATH = process.env.SCENARIOS_PATH || path.join(ROOT, "scenarios.json");
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, "logs");
const CALLS_JSONL_PATH = path.join(LOG_DIR, "calls.jsonl");
// Operator PIN -> name map (add known operator PINs here)
const OPERATOR_PIN_MAP = {
  "6960": "Lane Sharpe",
  "2651": "Todd Kolek",
  "0455": "Justin Hominsky",
  "4555": "Justin Sopko",
  "3052": "Tim Dowling",
  "5640": "Jeremy Sopko",
  "1111": "Andrew Moore",
};

// Persistent operators file (stores PIN -> name). Loaded at boot; updated by admin actions.
const OPERATORS_PATH = path.join(ROOT, "operators.json");
let OPERATORS = { ...OPERATOR_PIN_MAP };
const OPERATORS_JSONL_PATH = path.join(LOG_DIR, "operators.jsonl");

function saveOperators() {
  try {
    fs.writeFileSync(OPERATORS_PATH, JSON.stringify(OPERATORS, null, 2), "utf8");
    return true;
  } catch (e) {
    console.log(JSON.stringify({ event: "OPERATORS_SAVE_ERROR", error: String(e?.message || e) }));
    return false;
  }
}

function loadOperators() {
  try {
    if (fs.existsSync(OPERATORS_PATH)) {
      const raw = fs.readFileSync(OPERATORS_PATH, "utf8") || "{}";
      const parsed = JSON.parse(raw || "{}");
      OPERATORS = Object(parsed || {});
    } else {
      // seed file from in-code map
      saveOperators();
    }
  } catch (e) {
    console.log(JSON.stringify({ event: "OPERATORS_LOAD_ERROR", error: String(e?.message || e) }));
    OPERATORS = { ...OPERATOR_PIN_MAP };
  }
}

// =========================================================
// Tunables
// =========================================================
const TUNE = {
  // Audio
  PREBUFFER_FRAMES: clampInt(process.env.PREBUFFER_FRAMES, 3, 0, 30),
  SEND_INTERVAL_MS: clampInt(process.env.SEND_INTERVAL_MS, 20, 10, 60),
  OUTQUEUE_MAX_BYTES: clampInt(process.env.OUTQUEUE_MAX_BYTES, 900000, 50000, 8000000),
  INBOUND_MAX_B64_BYTES: clampInt(process.env.INBOUND_MAX_B64_BYTES, 600000, 20000, 8000000),

  // Response guardrails
  RESPONSE_COOLDOWN_MS: clampInt(process.env.RESPONSE_COOLDOWN_MS, 180, 0, 2500),

  // VAD
  VAD_SILENCE_MS: clampInt(process.env.VAD_SILENCE_MS, 420, 100, 2500),

  // Model
  TEMPERATURE: clampFloat(process.env.TEMPERATURE, 0.75, 0.6, 1.2),

  // Timeboxes (guarantee end+score without DTMF mid-stream)
  EXAM_MAX_SECONDS: clampInt(process.env.EXAM_MAX_SECONDS, 420, 60, 1800),
  PRACTICE_MAX_SECONDS: clampInt(process.env.PRACTICE_MAX_SECONDS, 600, 60, 3600),

  // Transcript caps (memory safety)
  MAX_CALLER_TURNS: clampInt(process.env.MAX_CALLER_TURNS, 400, 20, 8000),
  MAX_MODEL_TURNS: clampInt(process.env.MAX_MODEL_TURNS, 400, 20, 8000),

  // PIN settings
  PIN_DIGITS: 4,
};

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.log(JSON.stringify({ event: "LOG_DIR_ERROR", error: String(e?.message || e) }));
}

// =========================================================
// Global State
// =========================================================
const CALL_STATE = new Map();     // CallSid -> state
const EXAM_ATTEMPTS = new Map();  // daily lockout (From + module)

let SCENARIOS = null;

// =========================================================
// Scenario Loader (backward compatible)
// =========================================================
function loadScenariosOrThrow() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  const parsed = JSON.parse(raw || "{}");

  const normalized = {};
  for (const k of Object.keys(parsed || {})) normalized[String(k).toLowerCase()] = parsed[k];
  SCENARIOS = normalized;

  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH, modules: Object.keys(normalized) }));
  return SCENARIOS;
}

function getScenarios() {
  if (SCENARIOS) return SCENARIOS;
  return loadScenariosOrThrow();
}

function listScenarios(mode, difficulty) {
  const db = getScenarios();
  const m = db[String(mode || "").toLowerCase()];
  if (!m) return [];
  const bucket = m[difficulty] || m[String(difficulty || "").trim()] || null;
  return Array.isArray(bucket) ? bucket : [];
}

function stableSeed({ callSid, from }) {
  const base = callSid || `${from || "unknown"}:${Date.now()}`;
  return crypto.createHash("sha256").update(String(base)).digest("hex");
}

function pickScenario(mode, difficulty, seedHex) {
  const list = listScenarios(mode, difficulty);
  if (!list.length) return null;

  const seed = seedHex || stableSeed({ callSid: null, from: "system" });
  const idx = hexToInt(seed.slice(0, 8)) % list.length;
  const sc = list[idx] || {};

  return {
    id: sc.id || `SC-${idx}`,
    summary: sc.summary || "Scenario",
    objective: sc.objective || "",
    borrowerName: sc.borrowerName || "Steve",
    borrowerGender: String(sc.borrowerGender || "").toLowerCase(), // male/female
    borrowerStyle: sc.borrowerStyle || "",
    emotionalBaseline: sc.emotionalBaseline || "",
    stallReason: sc.stallReason || "",

    ruleFocus: Array.isArray(sc.ruleFocus) ? sc.ruleFocus : [],
    baitType: sc.baitType || "",
    requiredOutcome: sc.requiredOutcome || "",

    // Rotations / realism
    openers: Array.isArray(sc.openers) ? sc.openers : [],
    pressureLines: Array.isArray(sc.pressureLines) ? sc.pressureLines : [],
    escalationLadder: Array.isArray(sc.escalationLadder) ? sc.escalationLadder : [],

    // Scoring
    mustHit: Array.isArray(sc.mustHit) ? sc.mustHit : [],

    // Governance: LO escalation vs LO handoff
    loEscalationScript: sc.loEscalationScript || "",
    handoffForbiddenUntil: sc.handoffForbiddenUntil || "",

    _raw: sc,
  };
}

// =========================================================
// TwiML Helpers
// =========================================================
function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(innerXml) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${innerXml || ""}</Response>`;
}

function say(text) {
  return `<Say voice="Polly.Joanna">${xmlEscape(String(text || ""))}</Say>`;
}

function gatherDigits({ numDigits, action, promptText, invalidText, timeout = 7 }) {
  return (
    `<Gather input="dtmf" numDigits="${numDigits}" action="${xmlEscape(action)}" method="POST" timeout="${timeout}">` +
    `${say(promptText)}` +
    `</Gather>` +
    `${say(invalidText || "Invalid input.")}`
  );
}

function gatherOneDigit({ action, promptText, invalidText }) {
  return gatherDigits({ numDigits: 1, action, promptText, invalidText, timeout: 7 });
}

function absUrl(req, pathname) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const base = `${proto}://${host}`;
  const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return base + clean;
}

// =========================================================
// Call State
// =========================================================
function blankCallState(callSid) {
  return {
    callSid,
    from: "",
    // NEW: operator identity (PIN)
    operatorPin: "",

    mode: "mcd",
    difficulty: "Standard",
    examMode: false,

    scenarioId: "",
    scenario: null,
    ruleFocus: [],
    baitType: "",
    requiredOutcome: "",

    borrowerName: "Steve",
    borrowerGender: "",

    rotation: {
      seed: stableSeed({ callSid, from: "" }),
      openerIdx: 0,
      pressureIdx: 0,
    },

    operator: {
      connectMode: "connect", // connect only; no pre-call score option
      lastScore: null,
      lastScoreSpoken: "",
      feedback: null,
      _rerollCount: 0,
    },

    transcript: {
      callerText: [], // ISA text (from STT)
      modelText: [],  // borrower/model transcript
    },

    governance: {
      driftTriggered: false,
      driftEvents: [],
      violations: [],
      checkpoints: [],
      // NEW: realism/cadence tracking (filled later)
      realism: {
        challengeCount: 0,
        ladderStep: 0,
        pressureUsed: false,
      },
    },

    ts: {
      createdMs: Date.now(),
      connectStartMs: 0,
      playbackStartMs: 0,
      endMs: 0,
    },

    metrics: {
      idleTicks: 0,         // queue empty (normal)
      trueUnderflow: 0,     // queue empty while model speaking (bad)
      sentFrames: 0,
      maxOutQueueBytes: 0,
      avgOutQueueBytes: 0,
      outQueueSamples: 0,
      staticIndicators: [],
      transcriptionEvents: 0,
      transcriptionFailures: 0,
    },

    _audit: {
      written: false,
      attemptId: crypto.randomBytes(6).toString("hex"),
    },
  };
}

function getOrInitState(callSid) {
  if (!callSid) callSid = `no-sid:${Date.now()}`;
  if (!CALL_STATE.has(callSid)) CALL_STATE.set(callSid, blankCallState(callSid));
  return CALL_STATE.get(callSid);
}

// =========================================================
// Audit Writer (JSONL)
// =========================================================
function appendJsonlLine(filePath, obj) {
  try {
    const line = JSON.stringify(obj) + "\n";
    fs.appendFileSync(filePath, line, "utf8");
    return true;
  } catch (e) {
    console.log(JSON.stringify({ event: "AUDIT_WRITE_ERROR", error: String(e?.message || e) }));
    return false;
  }
}

// =========================================================
// Exam Lockout
// =========================================================
function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function examLockKey(from, mode, now = new Date()) {
  return `${todayKey(now)}:${String(from || "").trim()}:${String(mode || "").trim().toLowerCase()}`;
}

function canStartExam(from, mode) {
  const key = examLockKey(from, mode);
  return !EXAM_ATTEMPTS.has(key);
}

function markExamStarted(from, mode) {
  const key = examLockKey(from, mode);
  EXAM_ATTEMPTS.set(key, { ts: Date.now(), from, mode });
  return key;
}

// =========================================================
// Misc Utils
// =========================================================
function hexToInt(h) {
  return parseInt(h, 16) >>> 0;
}

function clampInt(v, def, min, max) {
  const n = Number.isFinite(Number(v)) ? parseInt(String(v), 10) : def;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(v, def, min, max) {
  const n = Number.isFinite(Number(v)) ? parseFloat(String(v)) : def;
  return Math.max(min, Math.min(max, n));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function snippet(s, n = 160) {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  return t.length <= n ? t : t.slice(0, n - 3) + "...";
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ---------------- Alerting helpers ----------------
function sendSlackMessage(text) {
  return new Promise((resolve) => {
    if (!SLACK_WEBHOOK_URL) return resolve(false);
    try {
      const payload = JSON.stringify({ text });
      const u = new URL(SLACK_WEBHOOK_URL);
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
      const req = (u.protocol === 'https:' ? https : http).request(u, opts, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    } catch (e) {
      return resolve(false);
    }
  });
}

function sendWebhook(url, obj) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    try {
      const payload = JSON.stringify(obj || {});
      const u = new URL(url);
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };
      const req = (u.protocol === 'https:' ? https : http).request(u, opts, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      });
      req.on('error', () => resolve(false));
      req.write(payload);
      req.end();
    } catch (e) {
      return resolve(false);
    }
  });
}

async function sendAlertEmail(subject, body) {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !ALERT_EMAIL_TO) {
    return false;
  }
  try {
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch (e) {
      console.log(JSON.stringify({ event: 'ALERT_EMAIL_SKIPPED', note: 'nodemailer not installed' }));
      return false;
    }
    const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    await transporter.sendMail({ from: ALERT_FROM, to: ALERT_EMAIL_TO, subject: subject, text: body });
    return true;
  } catch (e) {
    console.log(JSON.stringify({ event: 'ALERT_EMAIL_ERROR', error: String(e?.message || e) }));
    return false;
  }
}

async function alertAdmins(eventType, details = {}) {
  try {
    const short = `${eventType}: ${String(details.short || details.message || '')}`.slice(0, 1000);
    const payload = { event: eventType, ts: Date.now(), details };
    // fan-out
    await Promise.all([
      sendSlackMessage(`${short}\n\n${JSON.stringify(details)}`),
      sendWebhook(ALERT_WEBHOOK_URL, payload),
      sendAlertEmail(`SCC Alert: ${eventType}`, `Event time: ${new Date().toISOString()}\n\n${JSON.stringify(details, null, 2)}`),
    ]);
    return true;
  } catch (e) {
    console.log(JSON.stringify({ event: 'ALERT_DISPATCH_ERROR', error: String(e?.message || e) }));
    return false;
  }
}

// =========================================================
// NOTE: Next block = Scoring + Realism Engine
// - pattern violations trigger immediately (rates/handoff/guarantees)
// - checkpoints scored from CALLER STT
// - drift: practice self-heal, exam hard fail
// - audit finalize includes operatorPin (ISA identity)
// =========================================================
// PASTE BLOCK 2 of 6
// =========================================================
// Scoring + Realism Engine (PIN + “actually challenging borrower”)
// - Scores from caller STT: state.transcript.callerText
// - Drift detection from borrower/model output: state.transcript.modelText
// - Difficulty drives borrower behavior policy (challenge cadence, pressure timing, ladder escalation)
// - Practice: drift self-heal (logged). Exam: drift = hard fail.
// - Audit finalize includes operatorPin so each ISA is trackable on one dial-in number.
// =========================================================

// ---------------- Governance / Violation Codes ----------------
const VIOLATION = {
  DRIFT: "DRIFT_TRIPWIRE",
  HANDOFF: "NO_HANDOFF_LANGUAGE",
  RATES: "NO_RATES_OR_QUOTING",
  GUARANTEE: "NO_GUARANTEE_LANGUAGE",
  DISCOUNT: "NO_DISCOUNT_OR_PROMISES",
  LICENSE: "NO_LICENSING_OR_AUTHORITY_MISREP",
  STEERING: "NO_STEERING_OR_IMPROPER_INFLUENCE",
  DISALLOWED_PROMISE: "NO_TIMELINE_OR_CERTAINTY_PROMISES",
  NO_TRANSCRIPT: "NO_CALLER_TRANSCRIPT",
};

// ---------------- Patterns (Caller = ISA speech) ----------------
const PATTERNS = {
  // ISA early handoff language
  HANDOFF: [
    /\b(i('| a)m|i am)\s+going\s+to\s+(have|get)\s+(the\s+)?(loan\s+officer|lo)\s+(call|reach\s+out)\b/i,
    /\b(let\s+me|i('| a)m)\s+(transfer|connect)\s+you\s+to\s+(the\s+)?(loan\s+officer|lo)\b/i,
    /\b(the\s+loan\s+officer)\s+will\s+(call|reach\s+out)\b/i,
    /\b(i('| a)m)\s+going\s+to\s+pass\s+you\s+to\s+(the\s+)?(loan\s+officer|lo)\b/i,
  ],
  RATES: [
    /\b(rate|interest\s+rate|apr)\b/i,
    /\bpoints?\b/i,
    /\b(lock|locked)\b/i,
    /\b(we\s+can\s+get\s+you|i\s+can\s+get\s+you)\s+(a\s+)?rate\b/i,
  ],
  GUARANTEE: [
    /\bguarantee(d)?\b/i,
    /\bno\s+problem\s+getting\s+you\s+approved\b/i,
    /\bfor\s+sure\s+approved\b/i,
  ],
  DISCOUNT: [
    /\bwaive\s+(the\s+)?(fees?|costs?)\b/i,
    /\bcover\s+(the\s+)?fees?\b/i,
    /\bwe\s+pay\s+you\b/i,
    /\bget\s+paid\b/i,
  ],
  LICENSE: [/\b(i\s+am\s+a\s+licensed\s+loan\s+officer)\b/i, /\b(i\s+can\s+advise\s+you)\b/i],
  STEERING: [/\byou\s+should\s+use\s+us\b/i, /\bwe\s+are\s+the\s+best\s+lender\b/i, /\bif\s+you\s+use\s+us\s+we\s+will\b/i],
  DISALLOWED_PROMISE: [/\b(we\s+will|i\s+will)\s+close\s+in\s+\d+\s+days\b/i, /\bguarantee\s+we\s+close\b/i, /\bno\s+issues?\s+at\s+all\b/i],

  // Drift patterns apply to borrower/model output only.
  // IMPORTANT: fixed regex parens (no unmatched ')')
  DRIFT: [
    /\bhow\s+can\s+i\s+help\b/i,
    /\bi\s+can\s+help\s+you\b/i,
    /\bhere('| a)s\s+what\s+you\s+should\s+do\b/i,
    /\bi\s+recommend\b/i,
    /\blet('?s)?\s+get\s+you\s+pre[-\s]?approved\b/i,
    /\bi\s+can\s+offer\b/i,
    /\bi\s+work\s+for\s+nations\b/i,
    /\b(i('| a)m)\s+your\s+(loan\s+officer|lender)\b/i,
  ],
};

// ---------------- Realism Policy (by difficulty) ----------------
function realismPolicyForDifficulty(difficulty) {
  const d = String(difficulty || "Standard").toLowerCase();
  if (d === "edge") {
    return {
      label: "Edge",
      minChallenges: 6,           // borrower must ask at least this many distinct “challenge questions”
      pressureAfterMs: 45000,     // apply pressure line quickly if ISA not meeting objective
      ladderAfterMs: 60000,       // escalate ladder quickly
      interruptions: true,
      skepticism: "high",
      background: "high",
    };
  }
  if (d === "moderate") {
    return {
      label: "Moderate",
      minChallenges: 4,
      pressureAfterMs: 70000,
      ladderAfterMs: 100000,
      interruptions: true,
      skepticism: "medium",
      background: "medium",
    };
  }
  return {
    label: "Standard",
    minChallenges: 2,
    pressureAfterMs: 100000,
    ladderAfterMs: 140000,
    interruptions: false,
    skepticism: "low",
    background: "low",
  };
}

// ---------------- Transcript Ingest ----------------
function addCallerText(state, text) {
  if (!state || !text) return;
  const t = String(text).trim();
  if (!t) return;

  if (state.transcript.callerText.length >= TUNE.MAX_CALLER_TURNS) state.transcript.callerText.shift();
  state.transcript.callerText.push(t);

  detectViolationsFromCallerText(state, t);
}

function addModelText(state, text) {
  if (!state || !text) return;
  const t = String(text).trim();
  if (!t) return;

  if (state.transcript.modelText.length >= TUNE.MAX_MODEL_TURNS) state.transcript.modelText.shift();
  state.transcript.modelText.push(t);

  detectDriftFromModelText(state, t);
}

// ---------------- LO Escalation vs LO Handoff Condition ----------------
function handoffForbiddenActive(state) {
  const s = state?.scenario;
  const until = String(s?.handoffForbiddenUntil || "").trim();
  if (!until) return false;

  const lower = until.toLowerCase();

  if (lower.includes("application")) {
    const cps = state.governance?.checkpoints || [];
    const hit = cps.some((c) => c.hit && String(c.label || "").toLowerCase().includes("application"));
    return !hit;
  }

  if (lower.includes("borrower requests") || lower.includes("borrower asks")) return true;

  return true; // unknown => forbid (safer)
}

// ---------------- Violations ----------------
function recordViolation(state, code, meta = {}) {
  if (!state) return;
  state.governance.violations.push({
    ts: Date.now(),
    code,
    severity: meta.severity || "hard",
    evidence: meta.evidence || "",
    note: meta.note || "",
    source: meta.source || "unknown", // caller | model | system
  });
  try {
    const sev = meta.severity || "hard";
    if (sev === "hard") {
      // fire-and-forget alert
      setImmediate(() =>
        alertAdmins("CRITICAL_VIOLATION", {
          short: meta.note || code,
          code,
          evidence: meta.evidence || "",
          callSid: state.callSid || null,
          operatorPin: state.operator?.operatorPin || null,
          operatorName: state.operator?.operatorName || null,
        })
      );
    }
  } catch (e) {
    console.log(JSON.stringify({ event: "VIOLATION_ALERT_ERROR", error: String(e?.message || e) }));
  }
}

function detectViolationsFromCallerText(state, text) {
  if (!state || !text) return;

  if (handoffForbiddenActive(state) && PATTERNS.HANDOFF.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.HANDOFF, {
      severity: "hard",
      evidence: snippet(text),
      note: "LO handoff language attempted while forbidden",
      source: "caller",
    });
  }

  if (PATTERNS.RATES.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.RATES, {
      severity: "hard",
      evidence: snippet(text),
      note: "Rate / quoting language detected",
      source: "caller",
    });
  }

  if (PATTERNS.GUARANTEE.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.GUARANTEE, {
      severity: "hard",
      evidence: snippet(text),
      note: "Guarantee language detected",
      source: "caller",
    });
  }

  if (PATTERNS.DISCOUNT.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.DISCOUNT, {
      severity: "hard",
      evidence: snippet(text),
      note: "Discount / incentive language detected",
      source: "caller",
    });
  }

  if (PATTERNS.LICENSE.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.LICENSE, {
      severity: "hard",
      evidence: snippet(text),
      note: "Authority / licensing misrepresentation detected",
      source: "caller",
    });
  }

  if (PATTERNS.STEERING.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.STEERING, {
      severity: "hard",
      evidence: snippet(text),
      note: "Improper steering / influence language detected",
      source: "caller",
    });
  }

  if (PATTERNS.DISALLOWED_PROMISE.some((re) => re.test(text))) {
    recordViolation(state, VIOLATION.DISALLOWED_PROMISE, {
      severity: "hard",
      evidence: snippet(text),
      note: "Disallowed certainty/timeline promise detected",
      source: "caller",
    });
  }
}

function detectDriftFromModelText(state, text) {
  if (!state || !text) return;
  const driftHit = PATTERNS.DRIFT.some((re) => re.test(text));
  if (!driftHit) return;

  state.governance.driftTriggered = true;
  state.governance.driftEvents.push({ ts: Date.now(), evidence: snippet(text) });

  recordViolation(state, VIOLATION.DRIFT, {
    severity: "hard",
    evidence: snippet(text),
    note: "Borrower-only role drift detected",
    source: "model",
  });
}

// ---------------- Must-Hit Checkpoints ----------------
function safeRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return /$a/;
  }
}

function normalizeMustHit(mustHit) {
  const list = Array.isArray(mustHit) ? mustHit : [];
  return list
    .map((x, i) => {
      if (typeof x === "string") {
        return { id: `mh_${i}_${slug(x)}`, label: x, required: true, patterns: defaultCheckpointPatterns(x) };
      }
      if (x && typeof x === "object") {
        const label = x.label || x.id || `checkpoint_${i}`;
        return {
          id: x.id || `mh_${i}_${slug(label)}`,
          label,
          required: x.required !== false,
          patterns: (x.patterns || defaultCheckpointPatterns(label)).map(String),
        };
      }
      return null;
    })
    .filter(Boolean);
}

function defaultCheckpointPatterns(label) {
  const L = String(label || "").toLowerCase();

  if (L.includes("callback") || L.includes("best number") || L.includes("phone")) {
    return [String.raw`\b(best|good)\s+(callback\s+)?(number|phone)\b`, String.raw`\bwhat\s+is\s+the\s+best\s+(number|phone)\s+to\s+reach\b`];
  }
  if (L.includes("follow up") || L.includes("follow-up") || L.includes("time")) {
    return [String.raw`\b(follow\s*up|follow-up)\b`, String.raw`\b(what\s+time|when)\s+(works|is\s+best)\b`, String.raw`\b(schedule|set\s+up)\b`];
  }
  if (L.includes("application") || L.includes("apply")) {
    return [String.raw`\b(apply|application)\b`, String.raw`\b(get\s+you\s+started)\b`, String.raw`\b(complete|fill\s+out)\s+(an\s+)?application\b`];
  }
  if (L.includes("consent") || L.includes("permission")) {
    return [String.raw`\b(is\s+it\s+okay|can\s+i)\b`, String.raw`\bwith\s+your\s+permission\b`];
  }

  const words = L.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [String.raw`\b$^`];
  return [String.raw`\b` + words.map(escapeRegex).join(String.raw`.*\b`) + String.raw`\b`];
}

function evaluateCheckpoints(state) {
  const s = state?.scenario || {};
  const mustHit = normalizeMustHit(s.mustHit || []);
  const textAll = (state?.transcript?.callerText || []).join(" ").toLowerCase();

  const results = mustHit.map((cp) => {
    const hit = (cp.patterns || []).some((p) => safeRegex(p).test(textAll));
    return { id: cp.id, label: cp.label, required: cp.required !== false, hit };
  });

  state.governance.checkpoints = results;
  return results;
}

// ---------------- Scorecard ----------------
function coachingDirective(topIssue) {
  if (!topIssue) return "Stay inside governance, hit required checkpoints, and avoid early handoff language";

  const code = String(topIssue.code || "").toUpperCase();
  if (code.includes("HANDOFF")) return "Do not hand off; complete your checkpoint sequence before any escalation";
  if (code.includes("RATES") || code.includes("GUARANTEE")) return "Stop rate talk; focus on context, next steps, and compliant escalation if needed";
  if (code.includes("DRIFT")) return "Borrower drift occurred; tighten borrower-only lock and reset immediately";
  if (code.includes("MISSED_CHECKPOINT")) return "Hit required checkpoints early: callback number, follow-up time, and the correct module objective";
  if (code.includes("NO_CALLER_TRANSCRIPT")) return "Transcript missing; confirm STT is working before certification attempts";
  return "Slow down, confirm objectives, and keep compliance language tight";
}

function spokenScorecard(score) {
  const status = score.pass ? "PASS" : "FAIL";
  const issues = (score.topIssues || []).slice(0, 2);

  let issueLine = "";
  if (!issues.length) issueLine = "No critical violations detected.";
  else {
    const a = issues[0]?.note || issues[0]?.code || "Issue one";
    const b = issues[1]?.note || issues[1]?.code || null;
    issueLine = b ? `Top issues: one, ${a}. two, ${b}.` : `Top issue: ${a}.`;
  }

  const directive = score.coachingDirective
    ? `Coaching directive: ${score.coachingDirective}.`
    : "Coaching directive: slow down, confirm objectives, and stay inside governance.";

  return `Scorecard. ${status}. ${issueLine} ${directive}`;
}

function computeScorecard(state) {
  const cps = evaluateCheckpoints(state);
  const violations = state.governance.violations || [];
  const drift = !!state.governance.driftTriggered;

  // If we have zero caller transcript, we cannot score fairly (invalidate)
  const hasCallerText = (state.transcript?.callerText || []).join(" ").trim().length > 0;
  if (!hasCallerText) {
    recordViolation(state, VIOLATION.NO_TRANSCRIPT, {
      severity: "hard",
      evidence: "",
      note: "No caller transcript captured; STT missing",
      source: "system",
    });
  }

  const hardViolations = (state.governance.violations || []).filter((v) => v.severity === "hard");
  const missedRequired = cps.filter((c) => c.required && !c.hit);

  let pass = true;
  const failReasons = [];

  if (drift) {
    pass = false;
    failReasons.push("Drift tripwire triggered");
  }
  if (hardViolations.length) {
    pass = false;
    failReasons.push("Governance violations detected");
  }
  if (missedRequired.length) {
    pass = false;
    failReasons.push("Required checkpoints missed");
  }

  const topViolations = hardViolations.slice(0, 2).map((v) => ({ code: v.code, evidence: v.evidence, note: v.note }));
  const topMisses = missedRequired.slice(0, 2).map((c) => ({ code: "MISSED_CHECKPOINT", evidence: c.label, note: `Checkpoint missed: ${c.label}` }));
  const topIssues = topViolations.length ? topViolations : topMisses;

  const score = {
    pass,
    examMode: !!state.examMode,
    operatorPin: state.operatorPin || "",
    from: state.from || "",
    mode: state.mode,
    difficulty: state.difficulty,
    scenarioId: state.scenarioId,
    borrowerName: state.borrowerName,
    borrowerGender: state.borrowerGender,
    failReasons,
    topIssues,
    violationsCount: hardViolations.length,
    missedRequiredCount: missedRequired.length,
    checkpoints: cps,
    coachingDirective: coachingDirective(topIssues[0]),
    computedAtMs: Date.now(),
  };

  state.operator.lastScore = score;
  state.operator.lastScoreSpoken = spokenScorecard(score);
  return score;
}

// ---------------- Audit Finalize ----------------
function finalizeAuditRecord(state, extra = {}) {
  if (!state || state._audit?.written) return false;
  if (!state.operator?.lastScore) computeScorecard(state);

  const rec = {
    event: "CALL_AUDIT",
    callSid: state.callSid,
    attemptId: state._audit?.attemptId || null,

    // Identity
    from: state.from,
    operatorPin: state.operatorPin || "",
    operatorName: state.operatorName || "",

    // Mode
    mode: state.mode,
    difficulty: state.difficulty,
    examMode: !!state.examMode,

    // Scenario
    scenarioId: state.scenarioId,
    borrowerMeta: { borrowerName: state.borrowerName, borrowerGender: state.borrowerGender },
    scenario: {
      summary: state.scenario?.summary || "",
      objective: state.scenario?.objective || "",
      ruleFocus: state.scenario?.ruleFocus || state.ruleFocus || [],
      baitType: state.scenario?.baitType || state.baitType || "",
      requiredOutcome: state.scenario?.requiredOutcome || state.requiredOutcome || "",
      loEscalationScript: state.scenario?.loEscalationScript || "",
      handoffForbiddenUntil: state.scenario?.handoffForbiddenUntil || "",
    },

    // Deterministic rotation (proves replay consistency)
    rotation: state.rotation || {},

    transcript: {
      callerText: state.transcript?.callerText || [],
      modelText: state.transcript?.modelText || [],
    },

    governance: {
      driftTriggered: !!state.governance?.driftTriggered,
      driftEvents: state.governance?.driftEvents || [],
      violations: state.governance?.violations || [],
      checkpoints: state.governance?.checkpoints || [],
      realism: state.governance?.realism || {},
    },

    scoring: state.operator?.lastScore || null,
    feedback: state.operator?.feedback || null,

    metrics: state.metrics || {},
    timestamps: state.ts || {},

    ...extra,
    writtenAtMs: Date.now(),
  };

  const ok = appendJsonlLine(CALLS_JSONL_PATH, rec);
  state._audit.written = ok;
  return ok;
}

// =========================================================
// Realism Engine hooks (used by the streaming layer later)
// - returns a compact “behavior policy” string for the borrower
// - drives challenges/escalation timing by difficulty
// =========================================================
function realismPolicyText(state) {
  const p = realismPolicyForDifficulty(state.difficulty);
  const s = state.scenario || {};
  const pressure = (s.pressureLines || [])[state.rotation?.pressureIdx || 0] || "";

  return [
    `REALISM POLICY (${p.label}):`,
    `- You must be realistic and NOT agreeable.`,
    `- Ask at least ${p.minChallenges} pointed questions that force the ISA to answer clearly.`,
    `- If ISA dodges or tries to hand off early, resist and escalate pressure.`,
    pressure ? `- You have a pressure line available. Use it if objectives are not met: "${String(pressure)}"` : ``,
    p.interruptions ? `- Interrupt occasionally (short phrases), show impatience, and force clarity.` : `- Do not interrupt much.`,
    `- Match emotion/style from scenario (angry, rushed, confused, etc.).`,
    `- Stay borrower-only always.`,
  ]
    .filter(Boolean)
    .join("\n");
}
// PASTE BLOCK 3 of 6
// =========================================================
// Twilio Voice UX (Menus + PIN + Gates + Practice/Exam + Difficulty + Connect + Score)
// - 4-digit PIN login (tracks individual ISA on shared dial-in)
// - No pre-call scorecard option (score only after call ends)
// =========================================================

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) => res.status(200).send("scc-isa-voice v2026-final PIN+realism"));

// Expose known operators for UI/docs (PIN -> name)
// Public operator list: return names only to avoid exposing PINs
app.get("/operators", (req, res) => {
  try {
    const includePins = String(req.query.includePins || "").toLowerCase() === "true";

    if (includePins) {
      // require admin key
      const auth = String(req.headers.authorization || "").trim();
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!ADMIN_API_KEY || token !== ADMIN_API_KEY) {
        return res.status(403).json({ error: "forbidden" });
      }
      return res.status(200).json({ operators: OPERATORS });
    }

    const names = Object.values(OPERATORS || {}).map(String);
    return res.status(200).json({ operators: names });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------
// Entry: Main menu
// ---------------------------------------------------------
app.all("/voice", (req, res) => {
  const sid = req.body?.CallSid || req.query?.CallSid || null;
  console.log(JSON.stringify({ event: "CALL_START", sid }));

  const action = absUrl(req, "/menu");
  const inner = gatherOneDigit({
    action,
    promptText:
      "Sharpe Command Center. ISA training. " +
      "Press 1 for M1. " +
      "Press 2 for M. C. D. " +
      "Press 3 for M2. " +
      "Press 4 for operator list.",
    invalidText: "Invalid choice. Press 1, 2, 3, or 4.",
  });

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  if (digit === "1") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/pin-prompt?mode=m1"))}</Redirect>`));
  if (digit === "2") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/pin-prompt?mode=mcd"))}</Redirect>`));
  if (digit === "3") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/pin-prompt?mode=m2"))}</Redirect>`));
  if (digit === "4") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/operators-prompt"))}</Redirect>`));

  return res.type("text/xml").status(200).send(
    twimlResponse(`${say("Invalid selection. Returning to main menu.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
  );
});

// ---------------------------------------------------------
// Operators voice prompt (speaks the operator list)
// ---------------------------------------------------------
app.post("/operators-prompt", (req, res) => {
  try {
    const entries = Object.entries(OPERATORS || {});
    if (!entries.length) {
      return res.type("text/xml").status(200).send(twimlResponse(say("No operators configured.") + `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`));
    }

    const lines = entries
      .map(([pin, name]) => say(`${name}.`))
      .join("");

    const inner = [
      say("Known operators."),
      lines,
      say("Returning to the main menu."),
      `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`,
    ].join("");

    return res.type("text/xml").status(200).send(twimlResponse(inner));
  } catch (e) {
    return res.type("text/xml").status(500).send(twimlResponse(say("Unable to list operators.")));
  }
});

// ---------------------------------------------------------
// Admin: manage operators (rotate/revoke). Protected by ADMIN_API_KEY
// ---------------------------------------------------------
function requireAdmin(req) {
  const auth = String(req.headers.authorization || "").trim();
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return ADMIN_API_KEY && token === ADMIN_API_KEY;
}

app.get("/admin/operators", (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "forbidden" });
  return res.status(200).json({ operators: OPERATORS });
});

// Rotate PIN for a given name or by old pin
app.post("/admin/operators/rotate", (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "forbidden" });
  try {
    const name = String(req.body.name || "").trim();
    const oldPin = String(req.body.pin || "").trim();
    if (!name && !oldPin) return res.status(400).json({ error: "missing name or pin" });

    // remove old entry if provided
    if (oldPin && OPERATORS[oldPin]) {
      delete OPERATORS[oldPin];
    }

    // ensure unique 4-digit pin
    let newPin = null;
    for (let i = 0; i < 1000; i++) {
      const p = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
      if (!OPERATORS[p]) {
        newPin = p;
        break;
      }
    }
    if (!newPin) return res.status(500).json({ error: "unable_to_generate_pin" });

    OPERATORS[newPin] = name || OPERATORS[newPin] || "";
    saveOperators();

    // Audit log the rotation (record admin key fingerprint, oldPin/newPin/name)
    try {
      const auth = String(req.headers.authorization || "").trim();
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const adminFingerprint = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 8) : null;
      appendJsonlLine(OPERATORS_JSONL_PATH, {
        event: "OPERATOR_ROTATE",
        ts: Date.now(),
        adminFingerprint,
        oldPin: oldPin || null,
        newPin,
        name: OPERATORS[newPin],
      });
    } catch (e) {
      console.log(JSON.stringify({ event: "OPERATOR_ROTATE_AUDIT_FAILED", error: String(e?.message || e) }));
    }

    // Send alert to admins
    try {
      const auth = String(req.headers.authorization || "").trim();
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const adminFingerprint = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 8) : null;
      setImmediate(() =>
        alertAdmins("OPERATOR_ROTATE", {
          short: `Operator rotated: ${OPERATORS[newPin]}`,
          adminFingerprint,
          oldPin: oldPin || null,
          newPin,
          name: OPERATORS[newPin],
        })
      );
    } catch (e) {}

    return res.status(200).json({ success: true, pin: newPin, name: OPERATORS[newPin] });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Revoke PIN
app.post("/admin/operators/revoke", (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "forbidden" });
  try {
    const pin = String(req.body.pin || "").trim();
    if (!pin) return res.status(400).json({ error: "missing pin" });
    if (!OPERATORS[pin]) return res.status(404).json({ error: "not_found" });
    const name = OPERATORS[pin];
    delete OPERATORS[pin];
    saveOperators();

    // Audit log the revoke
    try {
      const auth = String(req.headers.authorization || "").trim();
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const adminFingerprint = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 8) : null;
      appendJsonlLine(OPERATORS_JSONL_PATH, {
        event: "OPERATOR_REVOKE",
        ts: Date.now(),
        adminFingerprint,
        pin,
        name: name || null,
      });
    } catch (e) {
      console.log(JSON.stringify({ event: "OPERATOR_REVOKE_AUDIT_FAILED", error: String(e?.message || e) }));
    }

    // Send alert to admins
    try {
      const auth = String(req.headers.authorization || "").trim();
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      const adminFingerprint = token ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 8) : null;
      setImmediate(() =>
        alertAdmins("OPERATOR_REVOKE", {
          short: `Operator revoked: ${name}`,
          adminFingerprint,
          pin,
          name: name || null,
        })
      );
    } catch (e) {}

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Serve static admin UI
app.use(express.static(path.join(ROOT, "public")));

// ---------------------------------------------------------
// PIN Login (4 digits)
// ---------------------------------------------------------
app.post("/pin-prompt", (req, res) => {
  const mode = String(req.query.mode || "").trim().toLowerCase();
  if (!["mcd", "m1", "m2"].includes(mode)) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid module. Returning to main menu.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
    );
  }


  const action = absUrl(req, `/pin?mode=${encodeURIComponent(mode)}`);
  const inner = gatherDigits({
    numDigits: TUNE.PIN_DIGITS,
    action,
    promptText: `Enter your ${TUNE.PIN_DIGITS} digit I. S. A. ID now.`,
    invalidText: `Invalid. Enter ${TUNE.PIN_DIGITS} digits.`,
    timeout: 10,
  });

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/pin", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";
  const mode = String(req.query.mode || "").trim().toLowerCase();
  const pin = (req.body.Digits || "").trim();

  if (!["mcd", "m1", "m2"].includes(mode)) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid module.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
    );
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid I. D.")}<Redirect method="POST">${xmlEscape(absUrl(req, `/pin-prompt?mode=${encodeURIComponent(mode)}`))}</Redirect>`)
    );
  }

  const st = getOrInitState(callSid);
  st.from = from;
  st.mode = mode;
  st.operatorPin = pin;
  // Assign known operator name (if configured)
  st.operatorName = OPERATOR_PIN_MAP[pin] || "";

  // Fresh attempt id at login start (for audit clarity)
  st._audit.attemptId = crypto.randomBytes(6).toString("hex");
  st._audit.written = false;

  // Go to module gate
  if (mode === "mcd") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/mcd-gate-prompt"))}</Redirect>`));
  if (mode === "m1") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/m1-gate-prompt"))}</Redirect>`));
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/m2-gate-prompt"))}</Redirect>`));
});

// ---------------------------------------------------------
// Gates (after PIN)
// ---------------------------------------------------------
app.post("/mcd-gate-prompt", (req, res) => {
  const action = absUrl(req, "/mcd-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. C. D. gate. Press 9 to continue.",
    invalidText: "Gate not confirmed. Press 9.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/mcd-gate", (req, res) => {
  if ((req.body.Digits || "").trim() !== "9") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/mcd-gate-prompt"))}</Redirect>`)
    );
  }
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt"))}</Redirect>`));
});

app.post("/m1-gate-prompt", (req, res) => {
  const action = absUrl(req, "/m1-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 1 gate. Press 8 to continue.",
    invalidText: "Gate not confirmed. Press 8.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/m1-gate", (req, res) => {
  if ((req.body.Digits || "").trim() !== "8") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/m1-gate-prompt"))}</Redirect>`)
    );
  }
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt"))}</Redirect>`));
});

app.post("/m2-gate-prompt", (req, res) => {
  const action = absUrl(req, "/m2-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 2 gate. Press 7 to continue.",
    invalidText: "Gate not confirmed. Press 7.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/m2-gate", (req, res) => {
  if ((req.body.Digits || "").trim() !== "7") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/m2-gate-prompt"))}</Redirect>`)
    );
  }
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt"))}</Redirect>`));
});

// ---------------------------------------------------------
// Practice vs Exam (uses state.mode already set by PIN)
// ---------------------------------------------------------
app.post("/exam-prompt", (req, res) => {
  const action = absUrl(req, "/exam");
  const inner = gatherOneDigit({
    action,
    promptText: "Select mode. Press 1 for Practice. Press 2 for Exam.",
    invalidText: "Invalid. Press 1 or 2.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/exam", (req, res) => {
  const callSid = req.body.CallSid;
  const st = getOrInitState(callSid);

  const digit = (req.body.Digits || "").trim();
  if (digit !== "1" && digit !== "2") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt"))}</Redirect>`)
    );
  }

  st.examMode = digit === "2";

  if (st.examMode) {
    if (!canStartExam(st.from, st.mode)) {
      return res.type("text/xml").status(200).send(
        twimlResponse(`${say("Exam already taken today for this module. Practice mode is available.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt"))}</Redirect>`)
      );
    }
    markExamStarted(st.from, st.mode);
  }

  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/difficulty-prompt"))}</Redirect>`));
});

// ---------------------------------------------------------
// Difficulty
// ---------------------------------------------------------
app.post("/difficulty-prompt", (req, res) => {
  const action = absUrl(req, "/difficulty");
  const inner = gatherOneDigit({
    action,
    promptText: "Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.",
    invalidText: "Invalid. Press 1, 2, or 3.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/difficulty", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);
  const digit = (req.body.Digits || "").trim();

  const difficulty = digit === "1" ? "Standard" : digit === "2" ? "Moderate" : digit === "3" ? "Edge" : null;
  if (!difficulty) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/difficulty-prompt"))}</Redirect>`)
    );
  }

  st.difficulty = difficulty;

  st.rotation.seed = stableSeed({ callSid: sid, from: st.from });
  const scenario = pickScenario(st.mode, st.difficulty, st.rotation.seed);

  if (!scenario) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("No scenarios available.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
    );
  }

  st.scenario = scenario;
  st.scenarioId = scenario.id;

  st.borrowerName = scenario.borrowerName || "Steve";
  st.borrowerGender = String(scenario.borrowerGender || "").toLowerCase();

  st.ruleFocus = scenario.ruleFocus || [];
  st.baitType = scenario.baitType || "";
  st.requiredOutcome = scenario.requiredOutcome || "";

  st.rotation.openerIdx = scenario.openers?.length ? hexToInt(st.rotation.seed.slice(8, 16)) % scenario.openers.length : 0;
  st.rotation.pressureIdx = scenario.pressureLines?.length ? hexToInt(st.rotation.seed.slice(16, 24)) % scenario.pressureLines.length : 0;

  // Reset per-run artifacts
  st.transcript.callerText = [];
  st.transcript.modelText = [];
  st.governance.driftTriggered = false;
  st.governance.driftEvents = [];
  st.governance.violations = [];
  st.governance.checkpoints = [];
  st.governance.realism = { challengeCount: 0, ladderStep: 0, pressureUsed: false };
  st.ts.connectStartMs = 0;
  st.ts.playbackStartMs = 0;
  st.ts.endMs = 0;
  st.metrics.idleTicks = 0;
  st.metrics.trueUnderflow = 0;
  st.metrics.sentFrames = 0;
  st.metrics.maxOutQueueBytes = 0;
  st.metrics.avgOutQueueBytes = 0;
  st.metrics.outQueueSamples = 0;
  st.metrics.staticIndicators = [];
  st.metrics.transcriptionEvents = 0;
  st.metrics.transcriptionFailures = 0;

  st.operator.lastScore = null;
  st.operator.lastScoreSpoken = "";
  st.operator.connectMode = "connect";
  st._openerspoken = false;

  console.log(
    JSON.stringify({
      event: "SCENARIO_LOADED",
      sid,
      operatorPin: st.operatorPin,
      mode: st.mode,
      difficulty: st.difficulty,
      scenarioId: st.scenarioId,
      borrowerName: st.borrowerName,
      borrowerGender: st.borrowerGender,
      ruleFocus: st.ruleFocus,
      baitType: st.baitType,
    })
  );

  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/connect-prompt"))}</Redirect>`));
});

// ---------------------------------------------------------
// Connect prompt (no score option here)
// ---------------------------------------------------------
app.post("/connect-prompt", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);

  if (!st.scenario) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Scenario missing. Returning to main menu.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
    );
  }

  const action = absUrl(req, "/connect");
  const inner = [
    say(`ISA ID ${st.operatorPin}${st.operatorName ? ', Operator ' + st.operatorName : ''}.`),
    say(`Scenario. ${String(st.scenario.summary || "")}`),
    st.scenario.objective ? say(`Primary objective. ${String(st.scenario.objective || "")}`) : "",
    say("Press 1 to connect."),
    `<Gather input="dtmf" numDigits="1" action="${xmlEscape(action)}" method="POST" timeout="8">`,
    say("Press 1 now."),
    `</Gather>`,
    say("No input received. Returning to main menu."),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/connect", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);
  const digit = (req.body.Digits || "").trim();

  if (digit !== "1") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid selection. Returning to main menu.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
    );
  }

  st.ts.connectStartMs = Date.now();

  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const streamUrl = `wss://${host}/twilio`;

  const inner = [
    say("Connecting now. The borrower will speak first."),
    `<Connect><Stream url="${xmlEscape(streamUrl)}">`,
    `<Parameter name="callSid" value="${xmlEscape(sid)}" />`,
    `<Parameter name="from" value="${xmlEscape(st.from)}" />`,
    `<Parameter name="operatorPin" value="${xmlEscape(st.operatorPin)}" />`,
    `<Parameter name="mode" value="${xmlEscape(st.mode)}" />`,
    `<Parameter name="difficulty" value="${xmlEscape(st.difficulty)}" />`,
    `<Parameter name="scenarioId" value="${xmlEscape(st.scenarioId)}" />`,
    `<Parameter name="borrowerName" value="${xmlEscape(st.borrowerName)}" />`,
    `<Parameter name="borrowerGender" value="${xmlEscape(st.borrowerGender)}" />`,
    `<Parameter name="examMode" value="${xmlEscape(st.examMode ? "true" : "false")}" />`,
    `</Stream></Connect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

// ---------------------------------------------------------
// Score -> always routes to post-call menu (Block 5)
// ---------------------------------------------------------
app.post("/score", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);

  st.ts.endMs = st.ts.endMs || Date.now();
  const score = computeScorecard(st);
  finalizeAuditRecord(st, { endReason: "SCORED" });

  const inner = [
    say("Scorecard."),
    say(`ISA ID ${st.operatorPin}${st.operatorName ? ', Operator ' + st.operatorName : ''}. Module ${st.mode}. Difficulty ${st.difficulty}. Scenario ID ${st.scenarioId}.`),
    say(st.operator.lastScoreSpoken || spokenScorecard(score)),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
// NOTE: Next block = Media Streams WS + OpenAI Realtime bridge,
// with borrower realism engine + guaranteed end->score redirect.
// =========================================================
// PASTE BLOCK 4 of 6
// =========================================================
// Media Streams WS + OpenAI Realtime (Realism + Challenge + Scoring STT + Post-call redirect)
// Fixes:
// - Voice gender lock (Steve won't be female)
// - Borrower actually runs scenario: challenges, pressure line, escalation ladder
// - Caller STT captured for scoring (rates/handoff triggers)
// - End of call always redirects to /score (no silent dead-end)
// =========================================================

// HTTP server + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

// ---------------- Twilio REST redirect (required for post-call UX) ----------------
function twilioRedirectCall(callSid, reqLike, targetPath) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log(JSON.stringify({ event: "TWILIO_REDIRECT_SKIPPED_NO_CREDS", callSid }));
    return Promise.resolve(false);
  }

  const url = absUrl(reqLike, targetPath);
  const postData = new URLSearchParams({ Url: url, Method: "POST" }).toString();

  const options = {
    hostname: "api.twilio.com",
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(callSid)}.json`,
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve) => {
    const r = https.request(options, (resp) => {
      resp.on("data", () => {});
      resp.on("end", () => resolve(resp.statusCode >= 200 && resp.statusCode < 300));
    });
    r.on("error", () => resolve(false));
    r.write(postData);
    r.end();
  });
}

// ---------------- Voice selection (hard lock) ----------------
const MALE_NAMES = new Set(["steve", "mike", "john", "david", "mark", "tom", "jim", "brian", "chris", "matt"]);
const FEMALE_NAMES = new Set(["sarah", "jessica", "ashley", "emily", "amy", "kate", "lisa", "rachel", "anna", "mary"]);

function voiceForBorrower(state) {
  const g = String(state.borrowerGender || "").toLowerCase();
  const n = String(state.borrowerName || "").toLowerCase();

  if (g === "female" || g === "f") return VOICE_FEMALE;
  if (g === "male" || g === "m") return VOICE_MALE;

  // fallback by name
  if (FEMALE_NAMES.has(n)) return VOICE_FEMALE;
  if (MALE_NAMES.has(n)) return VOICE_MALE;

  // default: male to avoid Steve-with-female-voice
  return VOICE_MALE;
}

// ---------------- Scenario rotations ----------------
function pickRotatedOpener(state) {
  const s = state.scenario || {};
  const arr = s.openers || [];
  if (!arr.length) return `Hi. This is ${state.borrowerName}. I got a message about a home loan and I'm calling back.`;
  return String(arr[state.rotation?.openerIdx || 0] || arr[0]);
}

function pickRotatedPressureLine(state) {
  const s = state.scenario || {};
  const arr = s.pressureLines || [];
  if (!arr.length) return "";
  return String(arr[state.rotation?.pressureIdx || 0] || arr[0]);
}

// ---------------- Borrower “Challenge Engine” ----------------
function challengeQuestionsForMode(mode) {
  const m = String(mode || "mcd").toLowerCase();
  if (m === "m1") {
    return [
      "What are you calling me about exactly?",
      "Why do you need that information right now?",
      "How long is this going to take?",
      "What do you actually need from me today?",
      "Are you asking me to fill out an application right now?",
      "Why can't you just have the loan officer call me?",
    ];
  }
  if (m === "m2") {
    return [
      "What's going on with my loan? No one is calling me back.",
      "Am I approved or not?",
      "Why do you need more documents?",
      "How do I know this isn't going to fall apart?",
      "If this delays closing, what happens?",
      "Should I switch lenders right now?",
    ];
  }
  // MCD
  return [
    "What is this about?",
    "How did you get my information?",
    "What do you need from me right now?",
    "Why are you asking that?",
    "Is this going to affect my credit?",
    "What happens after this call?",
  ];
}

function behavioralScriptForBorrower(state) {
  const p = realismPolicyForDifficulty(state.difficulty);
  const s = state.scenario || {};
  const pressure = pickRotatedPressureLine(state);
  const ladder = Array.isArray(s.escalationLadder) ? s.escalationLadder : [];
  const challenges = challengeQuestionsForMode(state.mode);

  // We give the model explicit behavioral obligations + timing rules.
  return [
    `BEHAVIOR POLICY (MUST FOLLOW):`,
    `1) You are the borrower. You are NOT helpful, not agreeable. You must challenge the I. S. A.`,
    `2) Ask at least ${p.minChallenges} challenge questions during the call. Use this pool: ${challenges.map((q, i) => `[${i + 1}] ${q}`).join(" ")}`,
    `3) If the I. S. A. does NOT clearly progress toward the objective, you must increase pressure.`,
    pressure ? `4) Use this pressure line if objective is not met by ~${Math.floor(p.pressureAfterMs / 1000)} seconds: "${pressure}"` : `4) If objective not met by ~${Math.floor(p.pressureAfterMs / 1000)} seconds, apply a pressure line (skeptical/urgent).`,
    ladder.length
      ? `5) Escalation ladder: if I. S. A. misses the objective, escalate step-by-step: ${ladder.map((x, i) => `[${i + 1}] ${String(x)}`).join(" ")}`
      : `5) If I. S. A. misses objective, escalate (be more skeptical, impatient).`,
    p.interruptions ? `6) Interrupt occasionally with short phrases. Force clarity.` : `6) Minimal interruptions.`,
    `7) Emotion/style must match scenario (angry/sad/confused/rushed). Do NOT break character.`,
    `8) NEVER become a lender or assistant. If you drift, immediately reset to borrower identity.`,
  ].join("\n");
}

// ---------------- LO escalation vs handoff rules in borrower behavior ----------------
function escalationVsHandoffPolicy(state) {
  const s = state.scenario || {};
  const handoffForbiddenUntil = String(s.handoffForbiddenUntil || "").trim();
  const loEscalationScript = String(s.loEscalationScript || "").trim();

  return [
    `SCC RULE: LO ESCALATION VS LO HANDOFF`,
    `- If I. S. A. tries to hand off early (e.g., "I'll have the LO call you"), resist strongly.`,
    handoffForbiddenUntil ? `- HANDOFF FORBIDDEN UNTIL: ${handoffForbiddenUntil}. Treat handoff attempts before that as unacceptable.` : `- Treat early handoff attempts as unacceptable.`,
    loEscalationScript
      ? `- If escalation becomes appropriate, the only acceptable escalation language is: "${loEscalationScript}". Otherwise resist.`
      : `- If escalation becomes appropriate, require a clear reason and do not accept vague handoff language.`,
  ].join("\n");
}

// ---------------- Hard session instructions ----------------
function buildHardBorrowerSessionInstructions(state) {
  const s = state.scenario || {};
  const opener = pickRotatedOpener(state);

  return [
    `SYSTEM / NON-NEGOTIABLE ROLE LOCK:`,
    `You are the BORROWER ONLY.`,
    `You are NOT a lender, NOT an assistant, NOT a coach.`,
    `Never provide rates, approvals, program recommendations, underwriting steps, or helpful guidance.`,
    `Speak ONLY as borrower "${state.borrowerName}".`,
    ``,
    `SCENARIO (BORROWER INTERNAL):`,
    `Module: ${String(state.mode).toUpperCase()} | Difficulty: ${state.difficulty} | ScenarioId: ${state.scenarioId}`,
    s.summary ? `Summary: ${String(s.summary)}` : ``,
    s.objective ? `Borrower objective: ${String(s.objective)}` : ``,
    s.requiredOutcome ? `Required training outcome: ${String(s.requiredOutcome)}` : ``,
    s.baitType ? `Bait type: ${String(s.baitType)}` : ``,
    Array.isArray(s.ruleFocus) && s.ruleFocus.length ? `Rule focus: ${s.ruleFocus.join(", ")}` : ``,
    ``,
    behavioralScriptForBorrower(state),
    ``,
    escalationVsHandoffPolicy(state),
    ``,
    `REALISM CUES:`,
    `- You will simulate realism: background distractions, emotion, and impatience. Describe them briefly in-character, but do not narrate like a director.`,
    `- Example: "Sorry, my kid is crying—what do you need from me right now?"`,
    ``,
    `START: You must speak first with this exact opener: "${opener}"`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------- OpenAI Realtime connect ----------------
function trySend(ws, obj) {
  if (!ws || ws.readyState !== WSClient.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function openaiRealtimeConnect(state) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const url = `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(REALTIME_MODEL)}`;

  const ws = new WSClient(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  ws._scc = {
    sessionReady: false,
    responseInFlight: false,
    lastResponseCreateMs: 0,
    modelTextBuf: "",
  };

  ws.on("open", () => {
    const instructions = buildHardBorrowerSessionInstructions(state);
    const voice = voiceForBorrower(state);

    console.log(
      JSON.stringify({
        event: "OPENAI_WS_OPEN",
        sid: state.callSid,
        borrowerName: state.borrowerName,
        borrowerGender: state.borrowerGender,
        voiceSelected: voice,
        model: REALTIME_MODEL,
        transcribeModel: TRANSCRIBE_MODEL,
      })
    );

    trySend(ws, {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions,
        voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        temperature: TUNE.TEMPERATURE,
        turn_detection: { type: "server_vad", silence_duration_ms: TUNE.VAD_SILENCE_MS },
        input_audio_transcription: { model: TRANSCRIBE_MODEL },
      },
    });
  });

  ws.on("message", (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    if (msg.type === "session.created" || msg.type === "session.updated") {
      ws._scc.sessionReady = true;

      // Borrower speaks first exactly once
      if (!state._openerspoken) {
        state._openerspoken = true;
        createBorrowerResponse(ws, state, "Speak the opener exactly once. Then pause.");
      }
      return;
    }

    // Caller STT
    if (
      msg.type === "conversation.item.input_audio_transcription.delta" ||
      msg.type === "input_audio_transcription.delta"
    ) {
      state.metrics.transcriptionEvents += 1;
      const delta = msg.delta || msg.text || "";
      if (delta) state._callerSttBuf = (state._callerSttBuf || "") + String(delta);
      return;
    }

    if (
      msg.type === "conversation.item.input_audio_transcription.completed" ||
      msg.type === "input_audio_transcription.completed"
    ) {
      state.metrics.transcriptionEvents += 1;
      const text = msg.transcript || msg.text || state._callerSttBuf || "";
      state._callerSttBuf = "";
      if (text) addCallerText(state, text);
      return;
    }

    if (
      msg.type === "conversation.item.input_audio_transcription.failed" ||
      msg.type === "input_audio_transcription.failed"
    ) {
      state.metrics.transcriptionFailures += 1;
      state.metrics.staticIndicators.push({ ts: Date.now(), type: "TRANSCRIPTION_FAILED" });
      return;
    }

    // Borrower/model text transcript for drift detection
    if (
      msg.type === "response.text.delta" ||
      msg.type === "response.output_text.delta" ||
      msg.type === "response.content_part.delta"
    ) {
      const delta = msg.delta || msg.text || "";
      if (delta) ws._scc.modelTextBuf += String(delta);
      return;
    }

    if (msg.type === "response.done" || msg.type === "response.text.done" || msg.type === "response.output_text.done") {
      const t = String(ws._scc.modelTextBuf || "").trim();
      ws._scc.modelTextBuf = "";
      if (t) addModelText(state, t);
      ws._scc.responseInFlight = false;

      // If drift happened:
      if (state.governance.driftTriggered) {
        if (state.examMode) {
          // Exam hard fail: stop generating new content
          state.metrics.staticIndicators.push({ ts: Date.now(), type: "EXAM_DRIFT_FAIL" });
        } else {
          // Practice self-heal: force borrower reset message next turn
          state.metrics.staticIndicators.push({ ts: Date.now(), type: "PRACTICE_DRIFT_SELF_HEAL" });
        }
      }

      return;
    }

    // OpenAI error events sometimes include cancel-not-active; ignore as NOOP
    if (msg.type === "error" && msg.error) {
      const code = msg.error.code || "";
      if (code === "response_cancel_not_active") {
        state.metrics.staticIndicators.push({ ts: Date.now(), type: "CANCEL_NOOP" });
        return;
      }
    }
  });

  ws.on("error", (e) => {
    console.log(JSON.stringify({ event: "OPENAI_WS_ERROR", sid: state.callSid, error: String(e?.message || e) }));
  });

  return ws;
}

// Response create with concurrency guard
function createBorrowerResponse(ws, state, instructions) {
  if (!ws || ws.readyState !== WSClient.OPEN) return false;
  if (!ws._scc?.sessionReady) return false;

  const now = Date.now();
  if (ws._scc.responseInFlight) return false;
  if (now - (ws._scc.lastResponseCreateMs || 0) < TUNE.RESPONSE_COOLDOWN_MS) return false;

  // Exam: if drift already triggered, do not continue
  if (state.examMode && state.governance.driftTriggered) return false;

  ws._scc.responseInFlight = true;
  ws._scc.lastResponseCreateMs = now;

  return trySend(ws, {
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      instructions: String(instructions || ""),
    },
  });
}

function cancelResponse(ws) {
  if (!ws || ws.readyState !== WSClient.OPEN) return false;
  // Only cancel if we believe a response is active
  if (!ws._scc?.responseInFlight) return false;
  ws._scc.responseInFlight = false;
  ws._scc.modelTextBuf = "";
  return trySend(ws, { type: "response.cancel" });
}

// ---------------- Twilio stream bridge ----------------
wss.on("connection", (twilioWs, req) => {
  let streamSid = null;
  let callSid = null;
  let lastModelAudioMs = 0;

  const outQueue = [];
  let outQueueBytes = 0;
  let sendTimer = null;
  let epoch = 0;

  let openaiWs = null;

  function queueAudioToTwilio(payloadB64, acceptEpoch) {
    if (!streamSid || !payloadB64) return;
    const bytes = Buffer.byteLength(String(payloadB64), "utf8");

    if (outQueueBytes + bytes > TUNE.OUTQUEUE_MAX_BYTES) {
      while (outQueue.length && outQueueBytes + bytes > TUNE.OUTQUEUE_MAX_BYTES) {
        const dropped = outQueue.shift();
        outQueueBytes -= dropped?.bytes || 0;
      }
      const st = callSid ? getOrInitState(callSid) : null;
      if (st) st.metrics.staticIndicators.push({ ts: Date.now(), type: "OUTQUEUE_TRIM", outQueueBytes });
    }

    outQueue.push({ payload: String(payloadB64), bytes, epoch: acceptEpoch });
    outQueueBytes += bytes;
    lastModelAudioMs = Date.now();

    const st = callSid ? getOrInitState(callSid) : null;
    if (st) {
      st.metrics.maxOutQueueBytes = Math.max(st.metrics.maxOutQueueBytes || 0, outQueueBytes);
      st.metrics.outQueueSamples += 1;
      st.metrics.avgOutQueueBytes =
        ((st.metrics.avgOutQueueBytes || 0) * (st.metrics.outQueueSamples - 1) + outQueueBytes) /
        st.metrics.outQueueSamples;
    }
  }

  function clearTwilioPlayback() {
    if (!streamSid) return;
    try {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    } catch {}
    outQueue.length = 0;
    outQueueBytes = 0;
  }

  function startSenderLoop() {
    if (sendTimer) return;
    sendTimer = setInterval(() => {
      if (!streamSid) return;
      const st = callSid ? getOrInitState(callSid) : null;

      // Prebuffer
      if (st && st.ts.playbackStartMs === 0) {
        if (outQueue.length < TUNE.PREBUFFER_FRAMES) {
          st.metrics.idleTicks += 1;
          return;
        }
        st.ts.playbackStartMs = Date.now();
      }

      if (!outQueue.length) {
        // differentiate idle vs true underflow (model speaking)
        const now = Date.now();
        const modelSpeaking = now - lastModelAudioMs < 450;
        if (st) {
          if (modelSpeaking) st.metrics.trueUnderflow += 1;
          else st.metrics.idleTicks += 1;
        }
        return;
      }

      const item = outQueue.shift();
      outQueueBytes -= item.bytes;

      if (item.epoch !== epoch) return;

      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: item.payload } }));
        if (st) st.metrics.sentFrames += 1;
      } catch {}
    }, TUNE.SEND_INTERVAL_MS);
  }

  function bindOpenAIToTwilio(ws, state) {
    ws.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta" || msg.type === "response.audio_chunk") {
        const audio = msg.delta || msg.audio || msg.chunk || "";
        if (audio) queueAudioToTwilio(audio, epoch);
      }
    });
  }

  function endAndScore(reason) {
    const st = callSid ? getOrInitState(callSid) : null;
    if (st) {
      st.ts.endMs = Date.now();
      st.metrics.staticIndicators.push({ ts: Date.now(), type: "END", reason });
      computeScorecard(st);
      finalizeAuditRecord(st, { endReason: reason });
    }

    try {
      if (openaiWs && openaiWs.readyState === WSClient.OPEN) openaiWs.close();
    } catch {}
    try {
      if (twilioWs && twilioWs.readyState === 1) twilioWs.close();
    } catch {}

    if (callSid) {
      twilioRedirectCall(callSid, { headers: req.headers, protocol: "https" }, "/score").catch(() => {});
    }
  }

  twilioWs.on("message", (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      const custom = msg.start?.customParameters || {};
      callSid = callSid || custom.callSid || null;

      const st = callSid ? getOrInitState(callSid) : null;
      if (st) {
        st.from = custom.from || st.from || "";
        st.operatorPin = custom.operatorPin || st.operatorPin || "";
        st.mode = (custom.mode || st.mode || "mcd").toLowerCase();
        st.difficulty = custom.difficulty || st.difficulty || "Standard";
        st.scenarioId = custom.scenarioId || st.scenarioId || "";
        st.borrowerName = custom.borrowerName || st.borrowerName || "Steve";
        st.borrowerGender = String(custom.borrowerGender || st.borrowerGender || "").toLowerCase();
        st.examMode = String(custom.examMode || (st.examMode ? "true" : "false")) === "true";
        st.ts.connectStartMs = st.ts.connectStartMs || Date.now();

        // Ensure scenario exists for instructions
        if (!st.scenario) {
          st.rotation.seed = stableSeed({ callSid: st.callSid, from: st.from });
          const sc = pickScenario(st.mode, st.difficulty, st.rotation.seed);
          if (sc) {
            st.scenario = sc;
            st.scenarioId = sc.id;
            st.borrowerName = sc.borrowerName || st.borrowerName;
            st.borrowerGender = String(sc.borrowerGender || st.borrowerGender || "").toLowerCase();
            st.ruleFocus = sc.ruleFocus || st.ruleFocus || [];
            st.baitType = sc.baitType || st.baitType || "";
            st.requiredOutcome = sc.requiredOutcome || st.requiredOutcome || "";
            st.rotation.openerIdx = sc.openers?.length ? hexToInt(st.rotation.seed.slice(8, 16)) % sc.openers.length : 0;
            st.rotation.pressureIdx = sc.pressureLines?.length ? hexToInt(st.rotation.seed.slice(16, 24)) % sc.pressureLines.length : 0;
          }
        }
      }

      console.log(JSON.stringify({ event: "TWILIO_STREAM_START", callSid, streamSid, operatorPin: st?.operatorPin || "", mode: st?.mode, difficulty: st?.difficulty, scenarioId: st?.scenarioId }));

      if (st) {
        openaiWs = openaiRealtimeConnect(st);
        bindOpenAIToTwilio(openaiWs, st);
      }
      startSenderLoop();

      // Timebox end
      if (st) {
        const maxSec = st.examMode ? TUNE.EXAM_MAX_SECONDS : TUNE.PRACTICE_MAX_SECONDS;
        setTimeout(() => {
          if (CALL_STATE.has(st.callSid)) endAndScore(st.examMode ? "EXAM_TIMEBOX" : "PRACTICE_TIMEBOX");
        }, maxSec * 1000);
      }

      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload || "";
      if (!payload) return;

      const st = callSid ? getOrInitState(callSid) : null;
      if (!st || !openaiWs) return;

      // If borrower was speaking and caller barges in, cancel + clear
      const now = Date.now();
      const modelSpeaking = now - lastModelAudioMs < 550;

      if (modelSpeaking) {
        epoch += 1;
        clearTwilioPlayback();
        cancelResponse(openaiWs); // guarded
      }

      // Forward caller audio (drives model + transcription)
      const bytes = Buffer.byteLength(payload, "utf8");
      if (bytes > TUNE.INBOUND_MAX_B64_BYTES) {
        st.metrics.staticIndicators.push({ ts: Date.now(), type: "INBOUND_TOO_LARGE", bytes });
        return;
      }
      trySend(openaiWs, { type: "input_audio_buffer.append", audio: payload });

      return;
    }

    if (msg.event === "stop") {
      endAndScore("TWILIO_STOP");
      return;
    }
  });

  twilioWs.on("close", () => {
    if (sendTimer) clearInterval(sendTimer);
  });

  twilioWs.on("error", () => {
    if (sendTimer) clearInterval(sendTimer);
  });
});

// =========================================================
// NOTE: Next block = Post-call menu + feedback + retry/new scenario + boot/validity.
// =========================================================
// PASTE BLOCK 5 of 6
// =========================================================
// Post-Call Operator Menu + Feedback + Retry/New Scenario
// - Always reachable because stream end triggers Twilio redirect to /score (Block 4)
// =========================================================

// ---------------- Scenario retry/reroll ----------------
function resetForRetrySameScenario(state) {
  state.transcript.callerText = [];
  state.transcript.modelText = [];
  state.governance.driftTriggered = false;
  state.governance.driftEvents = [];
  state.governance.violations = [];
  state.governance.checkpoints = [];
  state.governance.realism = { challengeCount: 0, ladderStep: 0, pressureUsed: false };

  state.ts.connectStartMs = 0;
  state.ts.playbackStartMs = 0;
  state.ts.endMs = 0;

  state.metrics.idleTicks = 0;
  state.metrics.trueUnderflow = 0;
  state.metrics.sentFrames = 0;
  state.metrics.maxOutQueueBytes = 0;
  state.metrics.avgOutQueueBytes = 0;
  state.metrics.outQueueSamples = 0;
  state.metrics.staticIndicators = [];
  state.metrics.transcriptionEvents = 0;
  state.metrics.transcriptionFailures = 0;

  state.operator.lastScore = null;
  state.operator.lastScoreSpoken = "";
  state._openerspoken = false;

  state._audit.attemptId = crypto.randomBytes(6).toString("hex");
  state._audit.written = false;
}

function rerollScenarioSameModuleDifficulty(state) {
  const list = listScenarios(state.mode, state.difficulty);
  if (!list.length) return null;

  state.operator._rerollCount = (state.operator._rerollCount || 0) + 1;

  const seed = String(state.rotation?.seed || stableSeed({ callSid: state.callSid, from: state.from }));
  const nextSeed = crypto.createHash("sha256").update(`${seed}::reroll::${state.operator._rerollCount}`).digest("hex");
  state.rotation.seed = nextSeed;

  const scenario = pickScenario(state.mode, state.difficulty, nextSeed);
  if (!scenario) return null;

  state.scenario = scenario;
  state.scenarioId = scenario.id;

  state.borrowerName = scenario.borrowerName || "Steve";
  state.borrowerGender = String(scenario.borrowerGender || "").toLowerCase();

  state.ruleFocus = scenario.ruleFocus || [];
  state.baitType = scenario.baitType || "";
  state.requiredOutcome = scenario.requiredOutcome || "";

  state.rotation.openerIdx = scenario.openers?.length ? hexToInt(state.rotation.seed.slice(8, 16)) % scenario.openers.length : 0;
  state.rotation.pressureIdx = scenario.pressureLines?.length ? hexToInt(state.rotation.seed.slice(16, 24)) % scenario.pressureLines.length : 0;

  resetForRetrySameScenario(state);
  return scenario;
}

// ---------------- Post-call menu ----------------
app.post("/post-call", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);

  if (!st.operator.lastScore) computeScorecard(st);

  const action = absUrl(req, "/post-call-action");
  const inner = [
    say("Operator menu."),
    say("Press 1 to replay the scorecard."),
    say("Press 2 to retry the same scenario."),
    say("Press 3 for a new scenario in the same module and difficulty."),
    say("Press 4 to leave feedback."),
    say("Press 5 to return to the main menu."),
    say("Press 6 to hang up."),
    `<Gather input="dtmf" numDigits="1" action="${xmlEscape(action)}" method="POST" timeout="8">`,
    say("Make your selection now."),
    `</Gather>`,
    say("No input received. Returning to main menu."),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/post-call-action", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const st = getOrInitState(sid);

  if (digit === "1") {
    const spoken = st.operator.lastScoreSpoken || spokenScorecard(st.operator.lastScore || computeScorecard(st));
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Replaying scorecard.")}${say(spoken)}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`)
    );
  }

  if (digit === "2") {
    resetForRetrySameScenario(st);
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Retrying the same scenario.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/connect-prompt"))}</Redirect>`)
    );
  }

  if (digit === "3") {
    const sc = rerollScenarioSameModuleDifficulty(st);
    if (!sc) {
      return res.type("text/xml").status(200).send(
        twimlResponse(`${say("No additional scenarios available.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`)
      );
    }
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("New scenario loaded.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/connect-prompt"))}</Redirect>`)
    );
  }

  if (digit === "4") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/feedback-prompt"))}</Redirect>`)
    );
  }

  if (digit === "5") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Returning to main menu.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`)
    );
  }

  if (digit === "6") {
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Goodbye.")}<Hangup/>`));
  }

  return res.type("text/xml").status(200).send(
    twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`)
  );
});

// ---------------- Feedback: rating + optional voice note ----------------
app.post("/feedback-prompt", (req, res) => {
  const action = absUrl(req, "/feedback-rating");
  const inner = [
    say("Feedback. Rate this simulation from 1 to 5."),
    say("Press 1 for poor. 5 for excellent."),
    `<Gather input="dtmf" numDigits="1" action="${xmlEscape(action)}" method="POST" timeout="8">`,
    say("Enter your rating now."),
    `</Gather>`,
    say("No input received. Returning to operator menu."),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`,
  ].join("");
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/feedback-rating", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);
  const digit = (req.body.Digits || "").trim();

  const rating = parseInt(digit, 10);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid rating.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/feedback-prompt"))}</Redirect>`)
    );
  }

  st.operator.feedback = st.operator.feedback || {};
  st.operator.feedback.rating = rating;
  st.operator.feedback.ratingAtMs = Date.now();

  const inner = [
    say(`Recorded. Rating ${rating}.`),
    say("Optional: leave a short voice note after the beep. Or stay silent to skip."),
    `<Record action="${xmlEscape(absUrl(req, "/feedback-note"))}" method="POST" maxLength="45" playBeep="true" timeout="3" />`,
    say("No recording received. Returning to operator menu."),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/feedback-note", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);

  const recUrl = String(req.body.RecordingUrl || "").trim();
  const recDur = String(req.body.RecordingDuration || "").trim();

  st.operator.feedback = st.operator.feedback || {};
  st.operator.feedback.noteRecordingUrl = recUrl || null;
  st.operator.feedback.noteRecordingDuration = recDur || null;
  st.operator.feedback.noteAtMs = Date.now();

  console.log(JSON.stringify({ event: "FEEDBACK_CAPTURED", callSid: sid, operatorPin: st.operatorPin, rating: st.operator.feedback.rating, recordingUrl: recUrl || null }));

  return res.type("text/xml").status(200).send(
    twimlResponse(`${say("Thank you. Feedback saved.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`)
  );
});

// =========================================================
// NOTE: Next block = Technical validity thresholds + audit flush + boot/listen.
// =========================================================
// PASTE BLOCK 6 of 6
// =========================================================
// Technical Validity + Audit Flush + Boot/Listen
// =========================================================

// ---------------- Observability thresholds ----------------
const OBS = {
  MAX_TRUE_UNDERFLOW_EXAM: clampInt(process.env.MAX_TRUE_UNDERFLOW_EXAM, 40, 0, 999999),
  MAX_TRUE_UNDERFLOW_PRACTICE: clampInt(process.env.MAX_TRUE_UNDERFLOW_PRACTICE, 80, 0, 999999),
  MIN_SENT_FRAMES_EXAM: clampInt(process.env.MIN_SENT_FRAMES_EXAM, 10, 0, 999999),
  REQUIRE_TRANSCRIPTION_EVENTS: clampInt(process.env.REQUIRE_TRANSCRIPTION_EVENTS, 1, 0, 999999),
};

function technicalValidity(state) {
  if (!state) return { valid: true, reasons: [] };

  const reasons = [];
  const tu = state.metrics?.trueUnderflow || 0;
  const sent = state.metrics?.sentFrames || 0;

  const maxTU = state.examMode ? OBS.MAX_TRUE_UNDERFLOW_EXAM : OBS.MAX_TRUE_UNDERFLOW_PRACTICE;
  if (tu > maxTU) reasons.push(`TRUE_UNDERFLOW_EXCEEDED:${tu}`);

  if (state.examMode && sent < OBS.MIN_SENT_FRAMES_EXAM) reasons.push(`LOW_SENT_FRAMES:${sent}`);

  // If connected call but no transcription events, scoring cannot be trusted
  if ((state.operator?.connectMode || "connect") === "connect") {
    const te = state.metrics?.transcriptionEvents || 0;
    if (te < OBS.REQUIRE_TRANSCRIPTION_EVENTS) reasons.push(`NO_TRANSCRIPTION_EVENTS:${te}`);
  }

  return { valid: reasons.length === 0, reasons };
}

// Wrap finalizeAuditRecord to include validity and prevent PASS on invalid evidence
const _finalizeAuditRecord = finalizeAuditRecord;
finalizeAuditRecord = function finalizeAuditRecordWrapped(state, extra = {}) {
  if (!state) return false;

  if (!state.operator?.lastScore) computeScorecard(state);

  const tv = technicalValidity(state);

  if (state.examMode && tv.valid === false && state.operator?.lastScore?.pass) {
    state.operator.lastScore.pass = false;
    state.operator.lastScore.failReasons = Array.isArray(state.operator.lastScore.failReasons)
      ? state.operator.lastScore.failReasons
      : [];
    state.operator.lastScore.failReasons.unshift("Technical invalidation: evidence insufficient");
    state.operator.lastScoreSpoken = spokenScorecard(state.operator.lastScore);
  }

  // If exam ended and failed, alert admins with compact details
  try {
    if (state.examMode && state.operator?.lastScore && state.operator.lastScore.pass === false) {
      setImmediate(() =>
        alertAdmins("EXAM_FAIL", {
          short: `Exam failed: ${state.callSid || state.scenarioId || ''}`,
          callSid: state.callSid || null,
          operatorPin: state.operatorPin || null,
          operatorName: state.operator?.operatorName || null,
          scenarioId: state.scenarioId || null,
          borrowerName: state.borrowerName || null,
          failReasons: state.operator.lastScore.failReasons || [],
          violationsCount: state.operator.lastScore.violationsCount || 0,
        })
      );
    }
  } catch (e) {}

  return _finalizeAuditRecord(state, { ...extra, technicalValidity: tv });
};

// ---------------- Flush audits on shutdown ----------------
function flushAllAudits(reason) {
  try {
    for (const [, st] of CALL_STATE.entries()) {
      if (!st) continue;
      if (!st.ts.endMs) st.ts.endMs = Date.now();
      if (!st.operator?.lastScore) computeScorecard(st);
      finalizeAuditRecord(st, { endReason: reason || "PROCESS_FLUSH" });
    }
  } catch (e) {
    console.log(JSON.stringify({ event: "FLUSH_ALL_AUDITS_ERROR", error: String(e?.message || e) }));
  }
}

process.on("SIGINT", () => {
  console.log(JSON.stringify({ event: "SIGINT" }));
  flushAllAudits("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log(JSON.stringify({ event: "SIGTERM" }));
  flushAllAudits("SIGTERM");
  process.exit(0);
});
process.on("uncaughtException", (err) => {
  console.log(JSON.stringify({ event: "UNCAUGHT_EXCEPTION", error: String(err?.message || err) }));
  flushAllAudits("UNCAUGHT_EXCEPTION");
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.log(JSON.stringify({ event: "UNHANDLED_REJECTION", error: String(err?.message || err) }));
  flushAllAudits("UNHANDLED_REJECTION");
  process.exit(1);
});

// ---------------- Boot ----------------
function boot() {
  try {
    requireEnv("OPENAI_API_KEY");
  } catch (e) {
    console.log(JSON.stringify({ event: "ENV_FATAL", error: String(e?.message || e) }));
  }

  try {
    loadScenariosOrThrow();
  } catch (e) {
    console.log(JSON.stringify({ event: "SCENARIOS_FATAL", error: String(e?.message || e) }));
  }

  // Load persistent operators file
  try {
    loadOperators();
  } catch (e) {
    console.log(JSON.stringify({ event: "OPERATORS_LOAD_FATAL", error: String(e?.message || e) }));
  }

  // Twilio redirect requires credentials; warn if missing
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log(JSON.stringify({ event: "TWILIO_CREDS_WARNING", note: "Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to guarantee post-call score/menu." }));
  }

  server.listen(PORT, HOST, () => {
    console.log(
      JSON.stringify({
        event: "SERVER_LISTENING",
        host: HOST,
        port: PORT,
        realtimeModel: REALTIME_MODEL,
        transcribeModel: TRANSCRIBE_MODEL,
        scenariosPath: SCENARIOS_PATH,
        logDir: LOG_DIR,
      })
    );
  });
}

boot();

// =========================================================
// END OF FILE
// =========================================================
