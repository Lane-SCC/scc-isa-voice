// PASTE BLOCK 1 of 6
// =========================================================
// SCC ISA TRAINING VOICE SYSTEM — server.js (2026 Final, Red-Team Hardened)
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
app.use(express.urlencoded({ extended: false })); // Twilio form posts
app.use(express.json({ limit: "3mb" }));

// =========================================================
// Env + Tunables
// =========================================================
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// OpenAI Realtime
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || "wss://api.openai.com/v1/realtime";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";

// Realtime transcription model for CALLER (ISA) speech -> text
// (Used for scoring/checkpoints/violations)
const TRANSCRIBE_MODEL =
  process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe"; // per docs examples :contentReference[oaicite:4]{index=4}

// Voices (borrower voice selection)
const VOICE_MALE = process.env.VOICE_MALE || "alloy";
const VOICE_FEMALE = process.env.VOICE_FEMALE || "verse";

// Optional Twilio REST credentials (to force redirect to /score without DTMF mid-stream)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// Logging + audit
const ROOT = process.cwd();
const SCENARIOS_PATH = process.env.SCENARIOS_PATH || path.join(ROOT, "scenarios.json");
const LOG_DIR = process.env.LOG_DIR || path.join(ROOT, "logs");
const CALLS_JSONL_PATH = path.join(LOG_DIR, "calls.jsonl");

// Performance / safety
const TUNE = {
  // audio queueing
  PREBUFFER_FRAMES: clampInt(process.env.PREBUFFER_FRAMES, 3, 0, 30),
  SEND_INTERVAL_MS: clampInt(process.env.SEND_INTERVAL_MS, 20, 10, 60),
  OUTQUEUE_MAX_BYTES: clampInt(process.env.OUTQUEUE_MAX_BYTES, 900000, 50000, 8000000),
  INBOUND_MAX_B64_BYTES: clampInt(process.env.INBOUND_MAX_B64_BYTES, 600000, 20000, 8000000),

  // concurrency / response guards
  RESPONSE_COOLDOWN_MS: clampInt(process.env.RESPONSE_COOLDOWN_MS, 180, 0, 2500),

  // VAD (server_vad) — conservative defaults
  VAD_SILENCE_MS: clampInt(process.env.VAD_SILENCE_MS, 420, 100, 2500),

  // model behavior
  TEMPERATURE: clampFloat(process.env.TEMPERATURE, 0.7, 0.6, 1.2),

  // Exam/practice timebox (ensures “End + Score” without DTMF inside stream)
  EXAM_MAX_SECONDS: clampInt(process.env.EXAM_MAX_SECONDS, 420, 60, 1800),
  PRACTICE_MAX_SECONDS: clampInt(process.env.PRACTICE_MAX_SECONDS, 600, 60, 3600),

  // Transcript memory caps (prevent runaway RAM)
  MAX_CALLER_TURNS: clampInt(process.env.MAX_CALLER_TURNS, 300, 20, 5000),
  MAX_MODEL_TURNS: clampInt(process.env.MAX_MODEL_TURNS, 300, 20, 5000),
};

// Ensure logs directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.log(JSON.stringify({ event: "LOG_DIR_ERROR", error: String(e?.message || e) }));
}

// =========================================================
// Global State
// =========================================================
/**
 * Per-call state keyed by CallSid
 * - preserves Twilio menu choices
 * - preserves scenario + deterministic rotations
 * - holds transcripts + scoring + audit proof
 */
const CALL_STATE = new Map();

/**
 * Exam lockout: 1 exam/day per phone number per module
 * Key: YYYY-MM-DD:<from>:<mode>
 */
const EXAM_ATTEMPTS = new Map();

// =========================================================
// Scenarios Loader (backward compatible + extended schema)
// =========================================================
let SCENARIOS = null;

function loadScenariosOrThrow() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  const parsed = JSON.parse(raw || "{}");

  const normalized = {};
  for (const k of Object.keys(parsed || {})) normalized[String(k).toLowerCase()] = parsed[k];
  SCENARIOS = normalized;

  console.log(
    JSON.stringify({
      event: "SCENARIOS_LOADED",
      path: SCENARIOS_PATH,
      modules: Object.keys(normalized),
    })
  );
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

    // Rotations / ladders
    openers: Array.isArray(sc.openers) ? sc.openers : [],
    pressureLines: Array.isArray(sc.pressureLines) ? sc.pressureLines : [],
    escalationLadder: Array.isArray(sc.escalationLadder) ? sc.escalationLadder : [],

    // Scoring
    mustHit: Array.isArray(sc.mustHit) ? sc.mustHit : [],

    // Governance fields (LO escalation vs handoff)
    loEscalationScript: sc.loEscalationScript || "",
    handoffForbiddenUntil: sc.handoffForbiddenUntil || "",

    // Keep raw for audits
    _raw: sc,
  };
}

// =========================================================
// TwiML Helpers (safe)
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
  // Keep narration voice consistent; you can change this to Polly.* or your preferred voice
  return `<Say voice="Polly.Joanna">${xmlEscape(String(text || ""))}</Say>`;
}

function gatherOneDigit({ action, promptText, invalidText }) {
  return (
    `<Gather input="dtmf" numDigits="1" action="${xmlEscape(action)}" method="POST" timeout="7">` +
    `${say(promptText)}` +
    `</Gather>` +
    `${say(invalidText || "Invalid selection.")}`
  );
}

function absUrl(req, pathname) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const base = `${proto}://${host}`;
  const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return base + clean;
}

// =========================================================
// Call State Shape
// =========================================================
function blankCallState(callSid) {
  return {
    callSid,
    from: "",
    mode: "mcd", // mcd | m1 | m2
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
      connectMode: "connect", // connect | score
      lastScore: null,
      lastScoreSpoken: "",
      feedback: null,
      _rerollCount: 0,
    },

    transcript: {
      // borrower/model output transcript (for evidence + drift)
      modelText: [],
      // ISA/caller transcript (from input audio transcription)
      callerText: [],
    },

    governance: {
      driftTriggered: false,
      driftEvents: [],
      violations: [],
      checkpoints: [],
    },

    ts: {
      createdMs: Date.now(),
      connectStartMs: 0,
      playbackStartMs: 0,
      endMs: 0,
    },

    metrics: {
      underflowTicks: 0,
      sentFrames: 0,
      maxOutQueueBytes: 0,
      avgOutQueueBytes: 0,
      outQueueSamples: 0,
      staticIndicators: [],
      // transcription health
      transcriptionEvents: 0,
      transcriptionFailures: 0,
    },

    _audit: {
      written: false,
      // stable per-call attempt id (if you retry same CallSid, we still preserve audit clarity)
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
// Audit Writer (JSONL, one record per call attempt)
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
// Exam Lockout Helpers
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
  if (t.length <= n) return t;
  return t.slice(0, n - 3) + "...";
}

// =========================================================
// NOTE: Next block = Scoring engine (NOW scores against callerText),
// policy/violation patterns, checkpoints, spoken scorecard, audit finalize.
// =========================================================
// PASTE BLOCK 2 of 6
// =========================================================
// Scoring + Governance Engine (Red-Team Hardened)
// - Scores against ISA speech: state.transcript.callerText (from input_audio_transcription)
// - Borrower/model transcript still logged for evidence + drift sentry
// - Pattern-based violations + must-hit checkpoints
// - PASS/FAIL + spoken scorecard
// - Audit finalize (calls.jsonl) with compliance-ready evidence bundle
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
};

// NOTE: Patterns apply primarily to ISA speech (callerText).
// Keep patterns tight. You can expand later per module ruleFocus.
const PATTERNS = {
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
  LICENSE: [
    /\b(i\s+am\s+a\s+licensed\s+loan\s+officer)\b/i,
    /\b(i\s+can\s+advise\s+you)\b/i,
  ],
  STEERING: [
    /\byou\s+should\s+use\s+us\b/i,
    /\bwe\s+are\s+the\s+best\s+lender\b/i,
    /\bif\s+you\s+use\s+us\s+we\s+will\b/i,
  ],
  DISALLOWED_PROMISE: [
    /\b(we\s+will|i\s+will)\s+close\s+in\s+\d+\s+days\b/i,
    /\bguarantee\s+we\s+close\b/i,
    /\bno\s+issues?\s+at\s+all\b/i,
  ],

  // Drift patterns apply to BORROWER/MODEL output (modelText)
  // (Borrower must NEVER behave like a lender or coach.)
  DRIFT: [
    /\bhow\s+can\s+i\s+help\b/i,
    /\bi\s+can\s+help\s+you\b/i,
    /\bhere('| a)s\s+what\s+you\s+should\s+do\b/i,
    /\bi\s+recommend\b/i,
    /\blet('?s)?\s+get\s+you\s+pre[-\s]?approved\b/i,
    /\bi\s+can\s+offer\b/i,
    /\bi\s+work\s+for\s+nations\b/i,
    /\bi('| a)m)\s+your\s+(loan\s+officer|lender)\b/i,
  ],
};

// ---------------- Transcript Ingest ----------------
function addCallerText(state, text) {
  if (!state || !text) return;
  const t = String(text).trim();
  if (!t) return;

  // cap memory
  if (state.transcript.callerText.length >= TUNE.MAX_CALLER_TURNS) {
    state.transcript.callerText.shift();
  }
  state.transcript.callerText.push(t);

  // Detect ISA violations from caller speech
  detectViolationsFromCallerText(state, t);
}

function addModelText(state, text) {
  if (!state || !text) return;
  const t = String(text).trim();
  if (!t) return;

  // cap memory
  if (state.transcript.modelText.length >= TUNE.MAX_MODEL_TURNS) {
    state.transcript.modelText.shift();
  }
  state.transcript.modelText.push(t);

  // Drift sentry from borrower/model output
  detectDriftFromModelText(state, t);
}

// ---------------- LO Escalation vs LO Handoff Condition ----------------
function handoffForbiddenActive(state) {
  const s = state?.scenario;
  const until = String(s?.handoffForbiddenUntil || "").trim();
  if (!until) return false;

  const lower = until.toLowerCase();

  // Condition: until "application attempt" checkpoint hit
  if (lower.includes("application")) {
    const cps = state.governance?.checkpoints || [];
    const hit = cps.some(
      (c) => c.hit && String(c.label || "").toLowerCase().includes("application")
    );
    return !hit;
  }

  // Until borrower requests LO: conservative (forbid unless scenario explicitly allows later)
  if (lower.includes("borrower requests") || lower.includes("borrower asks")) {
    return true;
  }

  // Unknown condition => forbid (safer)
  return true;
}

// ---------------- Violation Detection ----------------
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
}

function detectViolationsFromCallerText(state, text) {
  if (!state || !text) return;

  // LO handoff language only becomes a violation when forbidden is active
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
      note: "Discount / incentives language detected",
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
function normalizeMustHit(mustHit) {
  const list = Array.isArray(mustHit) ? mustHit : [];
  return list
    .map((x, i) => {
      if (typeof x === "string") {
        const id = `mh_${i}_${slug(x)}`;
        return {
          id,
          label: x,
          required: true,
          patterns: defaultCheckpointPatterns(x),
        };
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
    return [
      String.raw`\b(best|good)\s+(callback\s+)?(number|phone)\b`,
      String.raw`\bwhat\s+is\s+the\s+best\s+(number|phone)\s+to\s+reach\b`,
    ];
  }
  if (L.includes("follow up") || L.includes("follow-up") || L.includes("time")) {
    return [
      String.raw`\b(follow\s*up|follow-up)\b`,
      String.raw`\b(what\s+time|when)\s+(works|is\s+best)\b`,
      String.raw`\b(schedule|set\s+up)\b`,
    ];
  }
  if (L.includes("application") || L.includes("apply")) {
    return [
      String.raw`\b(apply|application)\b`,
      String.raw`\b(get\s+you\s+started)\b`,
      String.raw`\b(complete|fill\s+out)\s+(an\s+)?application\b`,
    ];
  }
  if (L.includes("consent") || L.includes("permission")) {
    return [String.raw`\b(is\s+it\s+okay|can\s+i)\b`, String.raw`\bwith\s+your\s+permission\b`];
  }

  const words = L.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [String.raw`\b$^`];
  return [String.raw`\b` + words.map(escapeRegex).join(String.raw`.*\b`) + String.raw`\b`];
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return /$a/;
  }
}

function evaluateCheckpoints(state) {
  const s = state?.scenario || {};
  const mustHit = normalizeMustHit(s.mustHit || []);
  // SCORE OFF CALLER (ISA) SPEECH
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

  const hardViolations = violations.filter((v) => v.severity === "hard");
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

  const topViolations = hardViolations.slice(0, 2).map((v) => ({
    code: v.code,
    evidence: v.evidence,
    note: v.note,
  }));

  const topMisses = missedRequired.slice(0, 2).map((c) => ({
    code: "MISSED_CHECKPOINT",
    evidence: c.label,
    note: `Checkpoint missed: ${c.label}`,
  }));

  const topIssues = topViolations.length ? topViolations : topMisses;

  const score = {
    pass,
    examMode: !!state.examMode,
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

// ---------------- Audit Finalize (JSONL) ----------------
function finalizeAuditRecord(state, extra = {}) {
  if (!state || state._audit?.written) return false;

  if (!state.operator?.lastScore) computeScorecard(state);

  const rec = {
    event: "CALL_AUDIT",
    callSid: state.callSid,
    attemptId: state._audit?.attemptId || null,
    from: state.from,
    mode: state.mode,
    difficulty: state.difficulty,
    examMode: !!state.examMode,

    scenarioId: state.scenarioId,
    borrowerMeta: {
      borrowerName: state.borrowerName,
      borrowerGender: state.borrowerGender,
    },

    scenario: {
      summary: state.scenario?.summary || "",
      objective: state.scenario?.objective || "",
      ruleFocus: state.scenario?.ruleFocus || state.ruleFocus || [],
      baitType: state.scenario?.baitType || state.baitType || "",
      requiredOutcome: state.scenario?.requiredOutcome || state.requiredOutcome || "",
      loEscalationScript: state.scenario?.loEscalationScript || "",
      handoffForbiddenUntil: state.scenario?.handoffForbiddenUntil || "",
    },

    rotation: state.rotation || {},

    transcript: {
      // evidence only; scoring uses callerText
      callerText: state.transcript?.callerText || [],
      modelText: state.transcript?.modelText || [],
    },

    governance: {
      driftTriggered: !!state.governance?.driftTriggered,
      driftEvents: state.governance?.driftEvents || [],
      violations: state.governance?.violations || [],
      checkpoints: state.governance?.checkpoints || [],
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

// ---------------- String utils used by checkpoints ----------------
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

// =========================================================
// NOTE: Next block = Twilio voice menus/gates/exam/difficulty/connect/score/post-call.
// =========================================================
// PASTE BLOCK 3 of 6
// =========================================================
// SCC Call Flow (DTMF menus + gates + exam lockout + difficulty + connect/score)
// Includes: post-call operator menu + feedback routes are in Block 5
// =========================================================

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) =>
  res.status(200).send("scc-isa-voice v2026-final red-team-hardened")
);

// ---------------------------------------------------------
// Main Menu
// ---------------------------------------------------------
app.all("/voice", (req, res) => {
  try {
    const sid = req.body?.CallSid || req.query?.CallSid || null;
    console.log(JSON.stringify({ event: "CALL_START", sid }));

    const menuAction = absUrl(req, "/menu");
    const inner = gatherOneDigit({
      action: menuAction,
      promptText:
        "Sharpe Command Center. I. S. A. training. " +
        "Press 1 for M. 1. " +
        "Press 2 for M. C. D. " +
        "Press 3 for M. 2.",
      invalidText: "Invalid choice. Press 1 for M. 1. Press 2 for M. C. D. Press 3 for M. 2.",
    });

    return res.type("text/xml").status(200).send(twimlResponse(inner));
  } catch (err) {
    console.log(JSON.stringify({ event: "VOICE_FATAL", error: String(err?.message || err) }));
    return res
      .type("text/xml")
      .status(200)
      .send(twimlResponse(say("System error. Please hang up and try again.")));
  }
});

app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  if (digit === "1") {
    return res
      .type("text/xml")
      .status(200)
      .send(
        twimlResponse(
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/m1-gate-prompt"))}</Redirect>`
        )
      );
  }
  if (digit === "2") {
    return res
      .type("text/xml")
      .status(200)
      .send(
        twimlResponse(
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/mcd-gate-prompt"))}</Redirect>`
        )
      );
  }
  if (digit === "3") {
    return res
      .type("text/xml")
      .status(200)
      .send(
        twimlResponse(
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/m2-gate-prompt"))}</Redirect>`
        )
      );
  }

  return res.type("text/xml").status(200).send(
    twimlResponse(
      `${say("Invalid selection. Returning to main menu.")}` +
        `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`
    )
  );
});

// ---------------------------------------------------------
// Gates
// ---------------------------------------------------------
app.post("/mcd-gate-prompt", (req, res) => {
  const action = absUrl(req, "/mcd-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. C. D. — Mortgage Context Discovery. Press 9 to continue.",
    invalidText: "Gate not confirmed. Press 9.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/mcd-gate", (req, res) => {
  const pass = (req.body.Digits || "").trim() === "9";
  if (!pass) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Gate not confirmed.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/mcd-gate-prompt"))}</Redirect>`
      )
    );
  }
  return res
    .type("text/xml")
    .status(200)
    .send(
      twimlResponse(
        `<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt?mode=mcd"))}</Redirect>`
      )
    );
});

app.post("/m1-gate-prompt", (req, res) => {
  const action = absUrl(req, "/m1-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 1. — Engagement and application. Press 8 to continue.",
    invalidText: "Gate not confirmed. Press 8.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/m1-gate", (req, res) => {
  const pass = (req.body.Digits || "").trim() === "8";
  if (!pass) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Gate not confirmed.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/m1-gate-prompt"))}</Redirect>`
      )
    );
  }
  return res
    .type("text/xml")
    .status(200)
    .send(
      twimlResponse(
        `<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt?mode=m1"))}</Redirect>`
      )
    );
});

app.post("/m2-gate-prompt", (req, res) => {
  const action = absUrl(req, "/m2-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 2. — Post application follow up. Risk containment. Press 7 to continue.",
    invalidText: "Gate not confirmed. Press 7.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/m2-gate", (req, res) => {
  const pass = (req.body.Digits || "").trim() === "7";
  if (!pass) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Gate not confirmed.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/m2-gate-prompt"))}</Redirect>`
      )
    );
  }
  return res
    .type("text/xml")
    .status(200)
    .send(
      twimlResponse(
        `<Redirect method="POST">${xmlEscape(absUrl(req, "/exam-prompt?mode=m2"))}</Redirect>`
      )
    );
});

// ---------------------------------------------------------
// Practice vs Exam
// ---------------------------------------------------------
app.post("/exam-prompt", (req, res) => {
  const mode = (req.query.mode || "").trim().toLowerCase();
  const action = absUrl(req, `/exam?mode=${encodeURIComponent(mode)}`);
  const inner = gatherOneDigit({
    action,
    promptText: "Select mode. Press 1 for Practice. Press 2 for Exam.",
    invalidText: "Invalid. Press 1 for Practice. Press 2 for Exam.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/exam", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";
  const mode = (req.query.mode || "").trim().toLowerCase();
  const digit = (req.body.Digits || "").trim();

  if (!["mcd", "m1", "m2"].includes(mode)) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Invalid mode.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`
      )
    );
  }

  const examMode = digit === "2";
  if (digit !== "1" && digit !== "2") {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Invalid selection.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, `/exam-prompt?mode=${encodeURIComponent(mode)}`))}</Redirect>`
      )
    );
  }

  const st = getOrInitState(callSid);
  st.from = from;
  st.mode = mode;
  st.examMode = examMode;

  // Refresh attempt id per call entry into exam/practice selection (helps audits if Twilio retries)
  st._audit.attemptId = crypto.randomBytes(6).toString("hex");
  st._audit.written = false;

  if (examMode) {
    if (!canStartExam(from, mode)) {
      return res.type("text/xml").status(200).send(
        twimlResponse(
          `${say("Exam already taken today for this module. Practice mode is available.")}` +
            `<Redirect method="POST">${xmlEscape(absUrl(req, `/exam-prompt?mode=${encodeURIComponent(mode)}`))}</Redirect>`
        )
      );
    }
    markExamStarted(from, mode);
  }

  return res.type("text/xml").status(200).send(
    twimlResponse(
      `<Redirect method="POST">${xmlEscape(absUrl(req, `/difficulty-prompt?mode=${encodeURIComponent(mode)}`))}</Redirect>`
    )
  );
});

// ---------------------------------------------------------
// Difficulty
// ---------------------------------------------------------
app.post("/difficulty-prompt", (req, res) => {
  const mode = (req.query.mode || "").trim().toLowerCase();
  const action = absUrl(req, `/difficulty?mode=${encodeURIComponent(mode)}`);
  const inner = gatherOneDigit({
    action,
    promptText: "Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.",
    invalidText: "Invalid selection. Press 1, 2, or 3.",
  });
  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/difficulty", (req, res) => {
  const sid = req.body.CallSid;
  const mode = (req.query.mode || "").trim().toLowerCase();
  const digit = (req.body.Digits || "").trim();

  const difficulty =
    digit === "1" ? "Standard" : digit === "2" ? "Moderate" : digit === "3" ? "Edge" : null;

  if (!difficulty || !["mcd", "m1", "m2"].includes(mode)) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Invalid selection.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, `/difficulty-prompt?mode=${encodeURIComponent(mode)}`))}</Redirect>`
      )
    );
  }

  const st = getOrInitState(sid);
  st.mode = mode;
  st.difficulty = difficulty;

  // Deterministic seed per call
  st.rotation.seed = stableSeed({ callSid: sid, from: st.from });
  const scenario = pickScenario(mode, difficulty, st.rotation.seed);

  if (!scenario) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("No scenarios available.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`
      )
    );
  }

  // Apply scenario to state
  st.scenario = scenario;
  st.scenarioId = scenario.id;
  st.borrowerName = scenario.borrowerName || "Steve";
  st.borrowerGender = (scenario.borrowerGender || "").toLowerCase();

  st.ruleFocus = scenario.ruleFocus || [];
  st.baitType = scenario.baitType || "";
  st.requiredOutcome = scenario.requiredOutcome || "";

  // Deterministic rotation indices
  st.rotation.openerIdx = scenario.openers?.length
    ? hexToInt(st.rotation.seed.slice(8, 16)) % scenario.openers.length
    : 0;
  st.rotation.pressureIdx = scenario.pressureLines?.length
    ? hexToInt(st.rotation.seed.slice(16, 24)) % scenario.pressureLines.length
    : 0;

  // Reset per-call artifacts for a fresh run
  st.transcript.modelText = [];
  st.transcript.callerText = [];
  st.governance.driftTriggered = false;
  st.governance.driftEvents = [];
  st.governance.violations = [];
  st.governance.checkpoints = [];
  st.ts.connectStartMs = 0;
  st.ts.playbackStartMs = 0;
  st.ts.endMs = 0;
  st.metrics.underflowTicks = 0;
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
      mode,
      difficulty,
      scenarioId: scenario.id,
      borrowerName: st.borrowerName,
      borrowerGender: st.borrowerGender,
      ruleFocus: st.ruleFocus,
      baitType: st.baitType,
    })
  );

  return res.type("text/xml").status(200).send(
    twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/connect-prompt"))}</Redirect>`)
  );
});

// ---------------------------------------------------------
// Connect vs Score (pre-stream)
// ---------------------------------------------------------
app.post("/connect-prompt", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);

  if (!st.scenario) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Scenario missing. Returning to main menu.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`
      )
    );
  }

  const connectAction = absUrl(req, "/connect");

  const inner = [
    say(`Scenario. ${String(st.scenario.summary || "")}`),
    st.scenario.objective ? say(`Primary objective. ${String(st.scenario.objective || "")}`) : "",
    say("Press 1 to connect."),
    say("Press 9 to end now and hear your scorecard."),
    `<Gather input="dtmf" numDigits="1" action="${xmlEscape(connectAction)}" method="POST" timeout="8">`,
    say("Make your selection now."),
    `</Gather>`,
    say("No input received. Returning to main menu."),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/connect", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const st = getOrInitState(sid);

  // 9 = immediate scorecard (no streaming)
  if (digit === "9") {
    st.operator.connectMode = "score";
    st.ts.endMs = Date.now();
    computeScorecard(st);
    finalizeAuditRecord(st, { endReason: "SCORE_ONLY_PRESTREAM" });

    return res
      .type("text/xml")
      .status(200)
      .send(
        twimlResponse(
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/score"))}</Redirect>`
        )
      );
  }

  if (digit !== "1") {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Invalid selection. Returning to main menu.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`
      )
    );
  }

  if (!st.scenario) {
    return res.type("text/xml").status(200).send(
      twimlResponse(
        `${say("Scenario missing. Returning to main menu.")}` +
          `<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`
      )
    );
  }

  st.operator.connectMode = "connect";
  st.ts.connectStartMs = Date.now();

  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const streamUrl = `wss://${host}/twilio`;

  const inner = [
    say("Connecting now. The borrower will speak first."),
    `<Connect><Stream url="${xmlEscape(streamUrl)}">`,
    `<Parameter name="callSid" value="${xmlEscape(sid)}" />`,
    `<Parameter name="from" value="${xmlEscape(st.from)}" />`,
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
// Score endpoint -> always routes to post-call loop (Block 5)
// ---------------------------------------------------------
app.post("/score", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);

  st.ts.endMs = st.ts.endMs || Date.now();
  const score = computeScorecard(st);

  // Ensure audit record exists (if not already written)
  finalizeAuditRecord(st, { endReason: "SCORED" });

  const inner = [
    say("Scorecard."),
    say(`Module ${st.mode}. Difficulty ${st.difficulty}. Scenario I D. ${st.scenarioId}.`),
    say(st.operator.lastScoreSpoken || spokenScorecard(score)),
    `<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`,
  ].join("");

  return res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
// NOTE: Next block = Twilio Media Streams WS + OpenAI Realtime bridge.
// - borrower-only instructions
// - caller STT via input_audio_transcription
// - barge-in / clear
// - timebox end + Twilio REST redirect to /score
// =========================================================
// PASTE BLOCK 4 of 6
// =========================================================
// Twilio Media Streams WS + OpenAI Realtime Bridge (Red-Team Hardened)
// - Borrower-only session instructions
// - Deterministic opener + pressure rotations
// - Caller STT (ISA speech) via input_audio_transcription -> addCallerText()
// - Borrower/model text transcript -> addModelText()
// - Barge-in: clear Twilio buffer + response.cancel + epoch gating
// - Timebox end: force Twilio call redirect to /score (no DTMF needed mid-stream)
// =========================================================

// Create HTTP server & attach WS server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

// ---------------- Twilio REST Redirect ----------------
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
      let body = "";
      resp.on("data", (d) => (body += d.toString("utf8")));
      resp.on("end", () => {
        const ok = resp.statusCode >= 200 && resp.statusCode < 300;
        console.log(
          JSON.stringify({
            event: "TWILIO_REDIRECT_RESULT",
            callSid,
            ok,
            statusCode: resp.statusCode,
            targetUrl: url,
          })
        );
        resolve(ok);
      });
    });
    r.on("error", (e) => {
      console.log(JSON.stringify({ event: "TWILIO_REDIRECT_ERROR", callSid, error: String(e?.message || e) }));
      resolve(false);
    });
    r.write(postData);
    r.end();
  });
}

// ---------------- Borrower Session Instructions ----------------
function voiceForBorrower(gender) {
  const g = String(gender || "").toLowerCase();
  if (g === "female" || g === "f") return VOICE_FEMALE;
  if (g === "male" || g === "m") return VOICE_MALE;
  return VOICE_MALE;
}

function pickRotatedOpener(state) {
  const s = state?.scenario;
  const arr = s?.openers || [];
  if (!arr.length) return `Hi. This is ${state.borrowerName}. I got a message about a home loan and I'm calling back.`;
  const idx = state.rotation?.openerIdx || 0;
  return String(arr[idx] || arr[0]);
}

function pickRotatedPressureLine(state) {
  const s = state?.scenario;
  const arr = s?.pressureLines || [];
  if (!arr.length) return "";
  const idx = state.rotation?.pressureIdx || 0;
  return String(arr[idx] || arr[0]);
}

function buildHardBorrowerSessionInstructions(state) {
  const s = state.scenario || {};
  const borrowerName = state.borrowerName || "Steve";
  const mode = String(state.mode || "mcd").toUpperCase();
  const difficulty = String(state.difficulty || "Standard");

  const opener = pickRotatedOpener(state);
  const pressure = pickRotatedPressureLine(state);

  const ruleFocus = Array.isArray(s.ruleFocus) && s.ruleFocus.length ? s.ruleFocus : state.ruleFocus || [];
  const baitType = s.baitType || state.baitType || "";
  const requiredOutcome = s.requiredOutcome || state.requiredOutcome || "";

  const loEscalationScript = String(s.loEscalationScript || "").trim();
  const handoffForbiddenUntil = String(s.handoffForbiddenUntil || "").trim();
  const escalationLadder = Array.isArray(s.escalationLadder) ? s.escalationLadder : [];

  return [
    `SYSTEM / NON-NEGOTIABLE ROLE LOCK:`,
    `You are the BORROWER in a mortgage scenario simulation.`,
    `You are NOT a lender, NOT an assistant, NOT a coach. Never help the caller do their job.`,
    `Never provide rates, approvals, program recommendations, underwriting steps, or "helpful" lender guidance.`,
    `Speak ONLY as the borrower named "${borrowerName}".`,
    `If you drift into assistant/lender behavior, that is a HARD FAILURE. Immediately return to borrower identity.`,
    ``,
    `SCENARIO CONTEXT (BORROWER INTERNAL):`,
    `Module: ${mode}. Difficulty: ${difficulty}.`,
    s.summary ? `Scenario summary: ${String(s.summary)}` : ``,
    s.objective ? `Borrower objective: ${String(s.objective)}` : ``,
    requiredOutcome ? `Required outcome (training target): ${String(requiredOutcome)}` : ``,
    baitType ? `Bait type: ${String(baitType)}` : ``,
    ruleFocus && ruleFocus.length ? `Rule focus tags: ${ruleFocus.join(", ")}` : ``,
    ``,
    `REALISM CUES:`,
    `Your first line MUST be exactly: "${opener}"`,
    pressure ? `Later, if appropriate, apply pressure line: "${pressure}"` : ``,
    escalationLadder.length
      ? `Escalation ladder if caller misses objectives (use step-by-step): ${escalationLadder
          .map((x, i) => `[${i + 1}] ${String(x)}`)
          .join(" ")}`
      : ``,
    ``,
    `SCC GOVERNANCE: LO ESCALATION VS LO HANDOFF`,
    `- LO escalation: caller uses compliant escalation script for a specific reason; not a shortcut or dump.`,
    `- LO handoff: caller tries to pass you to LO as a shortcut (forbidden unless allowed by scenario condition).`,
    handoffForbiddenUntil
      ? `HANDOFF FORBIDDEN UNTIL: ${handoffForbiddenUntil}. If caller attempts handoff early, resist and demand the correct next step.`
      : `If caller attempts early handoff, resist and demand the correct next step.`,
    loEscalationScript
      ? `If escalation is appropriate, ONLY acceptable escalation language is: "${loEscalationScript}". Otherwise resist.`
      : ``,
    ``,
    `BEHAVIOR:`,
    `Be human, concise, sometimes skeptical.`,
    `Do not volunteer lender knowledge.`,
    `Answer as borrower only; ask natural borrower questions.`,
    `If caller quotes rates/promises approvals/guarantees, push back and request basics instead.`,
    ``,
    `START NOW: speak the opener line immediately and then pause.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------- OpenAI Realtime WS ----------------
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
    epoch: 0,
    responseInFlight: false,
    lastResponseCreateMs: 0,

    // model transcript buffer
    modelTextBuf: "",
  };

  ws.on("open", () => {
    const voice = voiceForBorrower(state.borrowerGender);
    const instructions = buildHardBorrowerSessionInstructions(state);

    // Enable input audio transcription for CALLER (ISA). 
    // We append caller audio to input_audio_buffer; transcription events will arrive and feed addCallerText().
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions,
        voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        temperature: TUNE.TEMPERATURE,
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: TUNE.VAD_SILENCE_MS,
        },
        input_audio_transcription: {
          model: TRANSCRIBE_MODEL,
        },
      },
    };

    trySend(ws, sessionUpdate);
  });

  ws.on("message", (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    // Session ready gate
    if (msg.type === "session.created" || msg.type === "session.updated") {
      ws._scc.sessionReady = true;

      // Borrower speaks first exactly once
      if (!state._openerspoken) {
        state._openerspoken = true;
        safeCreateResponse(ws, `Speak the borrower opener line now, exactly once. Then stop.`);
      }
      return;
    }

    // ---------------- CALLER STT (ISA speech) ----------------
    // Event names vary slightly; handle common ones from docs/examples.
    if (
      msg.type === "conversation.item.input_audio_transcription.delta" ||
      msg.type === "input_audio_transcription.delta"
    ) {
      state.metrics.transcriptionEvents += 1;
      const delta = msg.delta || msg.text || "";
      if (delta) {
        // Keep deltas buffered lightly; we commit on completed events when possible.
        state._callerSttBuf = (state._callerSttBuf || "") + String(delta);
      }
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

    // ---------------- MODEL TEXT (borrower) ----------------
    if (
      msg.type === "response.text.delta" ||
      msg.type === "response.output_text.delta" ||
      msg.type === "response.content_part.delta"
    ) {
      const delta = msg.delta || msg.text || "";
      if (delta) ws._scc.modelTextBuf += String(delta);
      return;
    }

    if (msg.type === "response.text.done" || msg.type === "response.output_text.done" || msg.type === "response.done") {
      const t = String(ws._scc.modelTextBuf || "").trim();
      ws._scc.modelTextBuf = "";
      if (t) addModelText(state, t);
      ws._scc.responseInFlight = false;
      return;
    }
  });

  ws.on("error", (e) => {
    console.log(JSON.stringify({ event: "OPENAI_WS_ERROR", callSid: state.callSid, error: String(e?.message || e) }));
  });

  return ws;
}

function trySend(ws, obj) {
  if (!ws || ws.readyState !== WSClient.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function safeCreateResponse(ws, instructions) {
  if (!ws || ws.readyState !== WSClient.OPEN) return false;
  const s = ws._scc;
  if (!s || !s.sessionReady) return false;

  const now = Date.now();
  if (s.responseInFlight) return false;
  if (now - (s.lastResponseCreateMs || 0) < TUNE.RESPONSE_COOLDOWN_MS) return false;

  s.responseInFlight = true;
  s.lastResponseCreateMs = now;

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
  ws._scc.epoch += 1;
  ws._scc.responseInFlight = false;
  ws._scc.modelTextBuf = "";
  return trySend(ws, { type: "response.cancel" });
}

// ---------------- Twilio Stream Bridge ----------------
wss.on("connection", (twilioWs, req) => {
  let streamSid = null;
  let callSid = null;

  // Outbound audio queue to Twilio
  const outQueue = [];
  let outQueueBytes = 0;

  let sendTimer = null;
  let epoch = 0;

  // model speaking heuristic
  let lastModelAudioMs = 0;

  // OpenAI realtime socket
  let openaiWs = null;

  function queueAudioToTwilio(base64Audio) {
    if (!streamSid || !base64Audio) return;

    const payload = String(base64Audio);
    const bytes = Buffer.byteLength(payload, "utf8");

    // Backpressure trim
    if (outQueueBytes + bytes > TUNE.OUTQUEUE_MAX_BYTES) {
      while (outQueue.length && outQueueBytes + bytes > TUNE.OUTQUEUE_MAX_BYTES) {
        const dropped = outQueue.shift();
        outQueueBytes -= dropped?.bytes || 0;
      }
      const st = callSid ? getOrInitState(callSid) : null;
      if (st) st.metrics.staticIndicators.push({ ts: Date.now(), type: "OUTQUEUE_TRIM", outQueueBytes });
    }

    outQueue.push({ payload, bytes, epoch });
    outQueueBytes += bytes;

    const st = callSid ? getOrInitState(callSid) : null;
    if (st) {
      st.metrics.maxOutQueueBytes = Math.max(st.metrics.maxOutQueueBytes || 0, outQueueBytes);
      st.metrics.outQueueSamples += 1;
      st.metrics.avgOutQueueBytes =
        ((st.metrics.avgOutQueueBytes || 0) * (st.metrics.outQueueSamples - 1) + outQueueBytes) /
        st.metrics.outQueueSamples;
    }

    lastModelAudioMs = Date.now();
  }

  function startSenderLoop() {
    if (sendTimer) return;

    sendTimer = setInterval(() => {
      if (!streamSid) return;

      const st = callSid ? getOrInitState(callSid) : null;

      // Prebuffer gate to reduce initial underflow/static
      if (st && st.ts.playbackStartMs === 0) {
        if (outQueue.length < TUNE.PREBUFFER_FRAMES) {
          st.metrics.underflowTicks += 1;
          return;
        }
        st.ts.playbackStartMs = Date.now();
      }

      if (!outQueue.length) {
        if (st) st.metrics.underflowTicks += 1;
        return;
      }

      const item = outQueue.shift();
      outQueueBytes -= item.bytes;

      if (item.epoch !== epoch) return;

      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: item.payload } }));
        if (st) st.metrics.sentFrames += 1;
      } catch {
        // ignore
      }
    }, TUNE.SEND_INTERVAL_MS);
  }

  function clearTwilioPlayback() {
    if (!streamSid) return;
    try {
      // Twilio bidirectional stream supports "clear" to drop buffered audio 
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    } catch {}
    outQueue.length = 0;
    outQueueBytes = 0;
  }

  function bindOpenAIToTwilio(ws) {
    ws.on("message", (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      // audio delta event names vary; handle common
      if (msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta" || msg.type === "response.audio_chunk") {
        const audio = msg.delta || msg.audio || msg.chunk || "";
        if (audio) queueAudioToTwilio(audio);
        return;
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

    // Force Twilio to fetch /score (no DTMF mid-stream)
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
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      callSid = msg.start?.callSid || msg.start?.callSid || null;
      const custom = msg.start?.customParameters || {};
      callSid = callSid || custom.callSid || null;

      const st = callSid ? getOrInitState(callSid) : null;
      if (st) {
        st.from = custom.from || st.from || "";
        st.mode = (custom.mode || st.mode || "mcd").toLowerCase();
        st.difficulty = custom.difficulty || st.difficulty || "Standard";
        st.scenarioId = custom.scenarioId || st.scenarioId || "";
        st.borrowerName = custom.borrowerName || st.borrowerName || "Steve";
        st.borrowerGender = String(custom.borrowerGender || st.borrowerGender || "").toLowerCase();
        st.examMode = String(custom.examMode || (st.examMode ? "true" : "false")) === "true";
        st.ts.connectStartMs = st.ts.connectStartMs || Date.now();

        // Ensure scenario exists
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
            st.rotation.pressureIdx = sc.pressureLines?.length
              ? hexToInt(st.rotation.seed.slice(16, 24)) % sc.pressureLines.length
              : 0;
          }
        }
      }

      console.log(JSON.stringify({ event: "TWILIO_STREAM_START", streamSid, callSid, custom }));

      // Connect OpenAI
      if (st) {
        openaiWs = openaiRealtimeConnect(st);
        bindOpenAIToTwilio(openaiWs);
      }

      startSenderLoop();

      // Timebox: always end + score
      if (st) {
        const maxSec = st.examMode ? TUNE.EXAM_MAX_SECONDS : TUNE.PRACTICE_MAX_SECONDS;
        setTimeout(() => {
          if (CALL_STATE.has(st.callSid)) {
            endAndScore(st.examMode ? "EXAM_TIMEBOX" : "PRACTICE_TIMEBOX");
          }
        }, maxSec * 1000);
      }

      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload || "";
      if (!payload) return;

      const st = callSid ? getOrInitState(callSid) : null;
      if (!st || !openaiWs) return;

      // Barge-in: if model has been speaking recently and caller audio arrives, cancel + clear
      const now = Date.now();
      const modelSpeaking = now - lastModelAudioMs < 550;

      if (modelSpeaking) {
        epoch += 1;
        clearTwilioPlayback();
        cancelResponse(openaiWs);
      }

      // inbound size sanity
      const bytes = Buffer.byteLength(payload, "utf8");
      if (bytes > TUNE.INBOUND_MAX_B64_BYTES) {
        st.metrics.staticIndicators.push({ ts: Date.now(), type: "INBOUND_TOO_LARGE", bytes });
        return;
      }

      // Forward caller audio for BOTH:
      // - model turn-taking
      // - input_audio_transcription
      trySend(openaiWs, { type: "input_audio_buffer.append", audio: payload });

      return;
    }

    if (msg.event === "stop") {
      console.log(JSON.stringify({ event: "TWILIO_STREAM_STOP", callSid, streamSid }));
      endAndScore("TWILIO_STOP");
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log(JSON.stringify({ event: "TWILIO_WS_CLOSE", callSid, streamSid }));
    if (sendTimer) clearInterval(sendTimer);
  });

  twilioWs.on("error", (e) => {
    console.log(JSON.stringify({ event: "TWILIO_WS_ERROR", callSid, error: String(e?.message || e) }));
    if (sendTimer) clearInterval(sendTimer);
  });
});

// =========================================================
// NOTE: Next block = Post-call operator menu loop + feedback capture,
// plus scenario retry / reroll logic and audit thresholds + boot.
// =========================================================
// PASTE BLOCK 5 of 6
// =========================================================
// Post-Call Operator Menu Loop + Feedback Capture + Scenario Retry/Reroll
// =========================================================

// ---------------- Scenario Retry / Reroll ----------------
function resetForRetrySameScenario(state) {
  state.transcript.modelText = [];
  state.transcript.callerText = [];
  state.governance.driftTriggered = false;
  state.governance.driftEvents = [];
  state.governance.violations = [];
  state.governance.checkpoints = [];
  state.ts.connectStartMs = 0;
  state.ts.playbackStartMs = 0;
  state.ts.endMs = 0;

  state.metrics.underflowTicks = 0;
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
  const mode = state.mode;
  const difficulty = state.difficulty;
  const list = listScenarios(mode, difficulty);
  if (!list.length) return null;

  state.operator._rerollCount = (state.operator._rerollCount || 0) + 1;

  const seed = String(state.rotation?.seed || stableSeed({ callSid: state.callSid, from: state.from }));
  const nextSeed = crypto
    .createHash("sha256")
    .update(`${seed}::reroll::${state.operator._rerollCount}`)
    .digest("hex");

  state.rotation.seed = nextSeed;

  const scenario = pickScenario(mode, difficulty, nextSeed);
  if (!scenario) return null;

  state.scenario = scenario;
  state.scenarioId = scenario.id;
  state.borrowerName = scenario.borrowerName || state.borrowerName || "Steve";
  state.borrowerGender = String(scenario.borrowerGender || state.borrowerGender || "").toLowerCase();

  state.ruleFocus = scenario.ruleFocus || [];
  state.baitType = scenario.baitType || "";
  state.requiredOutcome = scenario.requiredOutcome || "";

  state.rotation.openerIdx = scenario.openers?.length
    ? hexToInt(state.rotation.seed.slice(8, 16)) % scenario.openers.length
    : 0;
  state.rotation.pressureIdx = scenario.pressureLines?.length
    ? hexToInt(state.rotation.seed.slice(16, 24)) % scenario.pressureLines.length
    : 0;

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
    say("No input received. Returning to the main menu."),
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
    return res
      .type("text/xml")
      .status(200)
      .send(
        twimlResponse(
          `${say("Replaying scorecard.")}${say(spoken)}<Redirect method="POST">${xmlEscape(
            absUrl(req, "/post-call")
          )}</Redirect>`
        )
      );
  }

  if (digit === "2") {
    resetForRetrySameScenario(st);
    return res
      .type("text/xml")
      .status(200)
      .send(twimlResponse(`${say("Retrying the same scenario.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/connect-prompt"))}</Redirect>`));
  }

  if (digit === "3") {
    const sc = rerollScenarioSameModuleDifficulty(st);
    if (!sc) {
      return res
        .type("text/xml")
        .status(200)
        .send(twimlResponse(`${say("No additional scenarios available.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`));
    }
    return res
      .type("text/xml")
      .status(200)
      .send(twimlResponse(`${say("New scenario loaded.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/connect-prompt"))}</Redirect>`));
  }

  if (digit === "4") {
    return res
      .type("text/xml")
      .status(200)
      .send(twimlResponse(`<Redirect method="POST">${xmlEscape(absUrl(req, "/feedback-prompt"))}</Redirect>`));
  }

  if (digit === "5") {
    return res
      .type("text/xml")
      .status(200)
      .send(twimlResponse(`${say("Returning to main menu.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/voice"))}</Redirect>`));
  }

  if (digit === "6") {
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Goodbye.")}<Hangup/>`));
  }

  return res
    .type("text/xml")
    .status(200)
    .send(twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`));
});

// ---------------- Feedback: 1–5 rating + optional voice note ----------------
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
    return res
      .type("text/xml")
      .status(200)
      .send(twimlResponse(`${say("Invalid rating.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/feedback-prompt"))}</Redirect>`));
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

  console.log(JSON.stringify({ event: "FEEDBACK_CAPTURED", callSid: sid, rating: st.operator.feedback.rating, recordingUrl: recUrl || null, recordingDuration: recDur || null }));

  return res
    .type("text/xml")
    .status(200)
    .send(twimlResponse(`${say("Thank you. Feedback saved.")}<Redirect method="POST">${xmlEscape(absUrl(req, "/post-call"))}</Redirect>`));
});

// =========================================================
// NOTE: Next block = technical validity thresholds, audit flush on shutdown, boot + listen.
// =========================================================
// PASTE BLOCK 6 of 6
// =========================================================
// Technical Validity + Audit Flush + Boot/Listen
// =========================================================

// ---------------- Observability thresholds ----------------
const OBS = {
  MAX_UNDERFLOW_TICKS_EXAM: clampInt(process.env.MAX_UNDERFLOW_TICKS_EXAM, 120, 0, 999999),
  MAX_UNDERFLOW_TICKS_PRACTICE: clampInt(process.env.MAX_UNDERFLOW_TICKS_PRACTICE, 240, 0, 999999),
  MAX_PLAYBACK_START_LATENCY_MS: clampInt(process.env.MAX_PLAYBACK_START_LATENCY_MS, 6000, 0, 60000),
  MIN_SENT_FRAMES_EXAM: clampInt(process.env.MIN_SENT_FRAMES_EXAM, 10, 0, 999999),
};

function technicalValidity(state) {
  if (!state) return { valid: true, reasons: [] };

  const reasons = [];
  const under = state.metrics?.underflowTicks || 0;
  const sent = state.metrics?.sentFrames || 0;

  const playbackStartMs = state.ts?.playbackStartMs || 0;
  const connectStartMs = state.ts?.connectStartMs || 0;

  const playbackLatency =
    playbackStartMs && connectStartMs ? playbackStartMs - connectStartMs : null;

  const maxUnder = state.examMode ? OBS.MAX_UNDERFLOW_TICKS_EXAM : OBS.MAX_UNDERFLOW_TICKS_PRACTICE;
  if (under > maxUnder) reasons.push(`UNDERFLOW_TICKS_EXCEEDED:${under}`);

  if (state.examMode && sent < OBS.MIN_SENT_FRAMES_EXAM) reasons.push(`LOW_SENT_FRAMES:${sent}`);

  if (playbackLatency !== null && playbackLatency > OBS.MAX_PLAYBACK_START_LATENCY_MS) {
    reasons.push(`PLAYBACK_START_LATENCY_MS:${playbackLatency}`);
  }

  // transcription health: if zero transcription events in a connected call, scoring may be weak
  if ((state.operator?.connectMode || "connect") === "connect") {
    const te = state.metrics?.transcriptionEvents || 0;
    if (te === 0) reasons.push("NO_TRANSCRIPTION_EVENTS");
  }

  return { valid: reasons.length === 0, reasons, playbackLatencyMs: playbackLatency };
}

// Wrap finalizeAuditRecord to include technical validity and to prevent PASS on invalid exam evidence
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

  return _finalizeAuditRecord(state, { ...extra, technicalValidity: tv });
};

// ---------------- Flush audits for all active calls ----------------
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
