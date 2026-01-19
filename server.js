/* SCC ISA Training Voice System (Governance-First)
 * server.js — v5.1 "Scorecard + Exam Mode"
 *
 * Adds (without destabilizing audio layer):
 * ✅ Practice vs Exam selection BEFORE streaming
 * ✅ Exam lockout: 1 exam/day per phone number per module
 * ✅ Connect vs Scorecard choice BEFORE streaming
 * ✅ Scorecard endpoint (spoken) — PASS/FAIL + RuleFocus + violations + directive
 * ✅ Exam-mode tripwire = HARD FAIL (no reset)
 *
 * Keeps:
 * ✅ OpenAI modalities ["audio","text"]
 * ✅ Strict 20ms μ-law framing + jitter prebuffer
 * ✅ Epoch gating
 * ✅ Role lock + borrower speaks first
 * ✅ Drift tripwire + emergency brake (practice mode)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const WSClient = require("ws");

// =========================================================
// App
// =========================================================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// =========================================================
// Config + Constants
// =========================================================
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime-mini";
const OPENAI_URL = (model) =>
  `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

// Your logs: supported combos are ["text"] or ["audio","text"]. Not ["audio"].
const OPENAI_MODALITIES = ["audio", "text"];

// Twilio strict μ-law framing
const FRAME_BYTES = 160; // 20ms @ 8kHz g711_ulaw (PCMU)
const SEND_TICK_MS = 20;

// Jitter buffer / playback priming
const PREBUFFER_FRAMES = parseInt(process.env.PREBUFFER_FRAMES || "4", 10); // 80ms default
const PREBUFFER_BYTES = FRAME_BYTES * Math.max(1, PREBUFFER_FRAMES);

// Underflow policy
const SEND_SILENCE_ON_UNDERFLOW =
  String(process.env.SEND_SILENCE_ON_UNDERFLOW || "true") === "true";
const ULAW_SILENCE_BYTE = 0xff;

// Queue caps
const MAX_OUT_QUEUE_FRAMES = parseInt(process.env.MAX_OUT_QUEUE_FRAMES || "250", 10); // ~5s
const MAX_OUT_QUEUE_BYTES = FRAME_BYTES * Math.max(50, MAX_OUT_QUEUE_FRAMES);

const MAX_INBOUND_BUFFER_FRAMES = parseInt(process.env.MAX_INBOUND_BUFFER_FRAMES || "50", 10); // ~1s
const MAX_INBOUND_BUFFER_BYTES = FRAME_BYTES * Math.max(10, MAX_INBOUND_BUFFER_FRAMES);

// VAD tuning (stable defaults)
const VAD_THRESHOLD = parseFloat(process.env.VAD_THRESHOLD || "0.55");
const VAD_PREFIX_MS = parseInt(process.env.VAD_PREFIX_MS || "240", 10);
const VAD_SILENCE_MS = parseInt(process.env.VAD_SILENCE_MS || "360", 10);
const VAD_IDLE_TIMEOUT_MS = parseInt(process.env.VAD_IDLE_TIMEOUT_MS || "15000", 10);

// Narrator
const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

// =========================================================
// Scenarios (authoritative)
// =========================================================
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = null;

function loadScenarios() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  SCENARIOS = JSON.parse(raw);
  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));
}
loadScenarios();

// Anti-repeat per (mode + difficulty)
const lastScenarioByKey = new Map();
function pickScenario(mode, difficulty) {
  const list = (SCENARIOS?.[mode]?.[difficulty]) || [];
  if (!list.length) return null;

  const key = `${mode}:${difficulty}`;
  const last = lastScenarioByKey.get(key);

  let pick = list[Math.floor(Math.random() * list.length)];
  if (list.length > 1 && pick.id === last) {
    for (let i = 0; i < 6; i++) {
      const alt = list[Math.floor(Math.random() * list.length)];
      if (alt.id !== last) {
        pick = alt;
        break;
      }
    }
  }

  lastScenarioByKey.set(key, pick.id);
  return pick;
}

// =========================================================
// In-memory call state (Pilot v1)
// NOTE: resets on deploy/restart. Perfect for pre-pilot.
// =========================================================
const CALL_STATE = new Map(); // CallSid -> state
const EXAM_ATTEMPTS = new Map(); // `${date}:${from}:${mode}` -> {ts, callSid}

function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getOrInitState(callSid) {
  if (!CALL_STATE.has(callSid)) {
    CALL_STATE.set(callSid, {
      callSid,
      from: "",
      mode: "",
      difficulty: "",
      examMode: false,

      scenarioId: "",
      ruleFocus: [],
      baitType: "",
      requiredOutcome: "",

      violations: [], // {code, detail, ts}
      tripwireCount: 0,
      underflowTicks: 0,

      startedAt: Date.now(),
      endedAt: null
    });
  }
  return CALL_STATE.get(callSid);
}

function addViolation(callSid, code, detail) {
  const st = getOrInitState(callSid);
  st.violations.push({ code, detail: String(detail || ""), ts: Date.now() });
}

function computeScore(callSid) {
  const st = getOrInitState(callSid);
  const fail = st.tripwireCount > 0 || st.violations.length > 0;
  return { pass: !fail, tripwireCount: st.tripwireCount, violations: st.violations };
}

function coachingDirective(st) {
  const rf = st.ruleFocus || [];
  if (rf.includes("NO_HANDOFF"))
    return "Next rep: do not use LO handoff to exit pressure. Keep ownership and set a time.";
  if (rf.includes("NO_RATES"))
    return "Next rep: deflect rate bait cleanly and return to the next step.";
  if (rf.includes("NO_ASSUME_INTENT"))
    return "Next rep: do not label intent until borrower states it explicitly.";
  if (rf.includes("APPLICATION_REQUIRED"))
    return "Next rep: make the application attempt cleanly and early once intent is explicit.";
  if (rf.includes("ESCALATION_NOT_HANDOFF"))
    return "Next rep: escalate LO-only questions without handing off ownership.";
  return "Next rep: keep it simple — confirm status, set next step, protect the LO.";
}

// =========================================================
// Helpers
// =========================================================
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function absUrl(req, p) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}${p}`;
}

function twimlResponse(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function say(text) {
  const cleaned = String(text).replace(/\bISA\b/g, "I. S. A.");
  return `<Say voice="${NARRATOR_VOICE}">${xmlEscape(cleaned)}</Say>`;
}

function gatherOneDigit({ action, promptText, invalidText }) {
  return `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
      ${say(promptText)}
    </Gather>
    ${say(invalidText)}
    <Redirect method="POST">${action}</Redirect>
  `;
}

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeMeta(s) {
  if (s === undefined || s === null) return "";
  return String(s).trim();
}

// =========================================================
// Borrower realism profiles (deterministic + scenario override)
// =========================================================
const STYLE_PROFILES = {
  calm:       { label: "calm",      emotion: "calm",      talkativeness: "medium", patience: "high",   trust: "medium", disfluency: "low",    thinkDelayMs: [140, 260] },
  anxious:    { label: "anxious",   emotion: "anxious",   talkativeness: "medium", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [180, 360] },
  distracted: { label: "distracted",emotion: "distracted",talkativeness: "low",    patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [200, 420] },
  irritated:  { label: "irritated", emotion: "irritated", talkativeness: "low",    patience: "low",    trust: "low",    disfluency: "low",    thinkDelayMs: [120, 220] },
  clueless:   { label: "clueless",  emotion: "confused",  talkativeness: "medium", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [180, 340] }
};

function hashStringToUint32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rng, items) {
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  let r = rng() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it.value;
  }
  return items[items.length - 1].value;
}

function chooseStyleForCall({ callSid, scenario, difficulty }) {
  const rng = mulberry32(hashStringToUint32(String(callSid || "no-callsid")));

  const forced = normalizeMeta(scenario?.borrowerStyle);
  if (forced && STYLE_PROFILES[forced]) return { style: STYLE_PROFILES[forced], rng };

  const weights = [
    { value: STYLE_PROFILES.calm,       weight: 32 },
    { value: STYLE_PROFILES.anxious,    weight: 26 },
    { value: STYLE_PROFILES.distracted, weight: 20 },
    { value: STYLE_PROFILES.clueless,   weight: 16 },
    { value: STYLE_PROFILES.irritated,  weight: 6  }
  ];

  if (/Edge/i.test(String(difficulty || ""))) {
    weights.forEach((w) => {
      if (w.value.label === "irritated") w.weight += 12;
      if (w.value.label === "anxious") w.weight += 6;
    });
  }

  return { style: pickWeighted(rng, weights), rng };
}

function resolveBorrowerMeta({ scenario, style, rng }) {
  const meta = {
    style: style.label,
    emotion: normalizeMeta(scenario?.emotionalBaseline) || style.emotion,
    distractor: normalizeMeta(scenario?.distractor) || "",
    talkativeness: normalizeMeta(scenario?.talkativeness) || style.talkativeness,
    patience: normalizeMeta(scenario?.patience) || style.patience,
    trust: normalizeMeta(scenario?.trustLevel) || style.trust,
    disfluency: normalizeMeta(scenario?.disfluencyRate) || style.disfluency,
    interruptions: normalizeMeta(scenario?.interruptions) || "low",
    thinkDelayMin: style.thinkDelayMs[0],
    thinkDelayMax: style.thinkDelayMs[1]
  };

  if (!meta.distractor && meta.style === "distracted") {
    meta.distractor = pickWeighted(rng, [
      { value: "kid in the background", weight: 42 },
      { value: "driving / road noise", weight: 33 },
      { value: "at work, someone asking questions", weight: 25 }
    ]);
  }

  return meta;
}

// =========================================================
// Borrower role lock (session-level; non-negotiable)
// =========================================================
function buildHardBorrowerSessionInstructions(mode, difficulty, scenario, borrowerName, borrowerMeta) {
  const isM2 = String(mode).toLowerCase() === "m2";

  const m2Pressure = isM2 ? `
M2 IS POST-APPLICATION FOLLOW-UP. This is risk containment under pressure.
You will bait common ISA mistakes (rate bait, credit bait, "have LO call me") WITHOUT being a cartoon villain.
You MUST NEVER accept an unauthorized LO handoff. If the caller tries to handoff, resist as borrower.
If asked for LO-only answers (rates, underwriting predictions, credit fixing, approval certainty): you do NOT answer.
You instead say you’re unsure and ask what the caller suggests, or ask for the caller to explain the next step.
`.trim() : "";

  const stallReason = normalizeMeta(scenario?.stallReason);
  const baitType = normalizeMeta(scenario?.baitType);
  const escalationTrigger = normalizeMeta(scenario?.escalationTrigger);
  const redLine = normalizeMeta(scenario?.redLine);
  const requiredOutcome = normalizeMeta(scenario?.requiredOutcome);

  const m2Fields = isM2 ? `
M2 SCENARIO FIELDS (authoritative):
- stallReason: ${stallReason || "(unspecified)"}
- baitType: ${baitType || "(unspecified)"}
- escalationTrigger: ${escalationTrigger || "(unspecified)"}
- redLine: ${redLine || "(unspecified)"}
- requiredOutcome: ${requiredOutcome || "(unspecified)"}
`.trim() : "";

  return `
ABSOLUTE ROLE LOCK — NON-NEGOTIABLE

You are a SIMULATED MORTGAGE BORROWER named ${borrowerName}.
The HUMAN CALLER is an ISA TRAINEE.

You are NOT an assistant.
You are NOT the lender.
You are NOT the ISA.
You are NOT a loan officer.
You are NOT an advisor or expert.

You MUST ALWAYS speak ONLY from the BORROWER perspective.
You MUST be imperfect: incomplete information, uncertainty, normal human behavior.

You MUST NEVER:
- give advice or recommendations
- explain mortgage concepts like a lender
- quote rates/APR/payments/terms/pricing
- discuss eligibility, underwriting rules, approval certainty
- coach credit, underwriting, or "what to do" as an expert
- provide legal/tax/financial/medical guidance
- assume the caller is the borrower
- say "we" as the lender/processor/etc.

If asked for any forbidden item:
- respond with uncertainty as borrower
- redirect back to borrower concerns
Example: "I'm not sure — I was hoping you could help me understand that."

BORROWER BEHAVIOR SETTINGS:
- Emotion: ${borrowerMeta.emotion}
- Talkativeness: ${borrowerMeta.talkativeness}
- Patience: ${borrowerMeta.patience}
- Trust: ${borrowerMeta.trust}
- Distractor: ${borrowerMeta.distractor || "none"}

SCENARIO (authoritative):
- Mode: ${mode}
- Difficulty: ${difficulty}
- Summary: ${String(scenario?.summary || "")}
- Objective: ${String(scenario?.objective || "")}

${m2Pressure}
${m2Fields}

VIOLATION OF ROLE = FAILURE CONDITION.
`.trim();
}

function pickBorrowerVoice(gender) {
  const g = String(gender || "").toLowerCase();
  if (g.includes("f")) return process.env.OPENAI_VOICE_FEMALE || "alloy";
  if (g.includes("m")) return process.env.OPENAI_VOICE_MALE || "marin";
  return process.env.OPENAI_VOICE_DEFAULT || "marin";
}

// =========================================================
// Role drift tripwire (text-based)
// =========================================================
const DRIFT_PATTERNS = [
  /\b(i can|i will|i recommend|you should|based on|current market|qualify|approval|apr|rate|offer you)\b/i,
  /\b(underwriting|eligible|you qualify|debt to income|dti|fico|credit score|loan program)\b/i,
  /\b(gout|diagnosis|symptoms|medical|doctor)\b/i,
  /\b(import|shipping|italy|luxury car|ferrari|lamborghini)\b/i,
  /\b(your income|your borrower profile|you are buying|you should finance)\b/i
];

function hasRoleDrift(text) {
  if (!text) return false;
  return DRIFT_PATTERNS.some((rx) => rx.test(text));
}

// =========================================================
// Health
// =========================================================
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) => res.status(200).send("scc-isa-voice v5.1 scorecard+exam"));

// =========================================================
// SCC Call Flow (DTMF menus + gates + exam + difficulty + connect/score)
// =========================================================
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
      invalidText:
        "Invalid choice. Press 1 for M. 1. Press 2 for M. C. D. Press 3 for M. 2."
    });

    res.type("text/xml").status(200).send(twimlResponse(inner));
  } catch (err) {
    console.log(JSON.stringify({ event: "VOICE_FATAL", error: String(err?.message || err) }));
    res.type("text/xml").status(200).send(twimlResponse(say("System error. Please hang up and try again.")));
  }
});

app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  if (digit === "1") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/m1-gate-prompt")}</Redirect>`));
  if (digit === "2") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/mcd-gate-prompt")}</Redirect>`));
  if (digit === "3") return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/m2-gate-prompt")}</Redirect>`));

  return res.type("text/xml").status(200).send(
    twimlResponse(`${say("Invalid selection. Returning to main menu.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
  );
});

// Gates
app.post("/mcd-gate-prompt", (req, res) => {
  const action = absUrl(req, "/mcd-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. C. D. — Mortgage Context Discovery. Press 9 to continue.",
    invalidText: "Gate not confirmed. Press 9."
  });
  res.type("text/xml").status(200).send(twimlResponse(inner));
});
app.post("/mcd-gate", (req, res) => {
  const pass = (req.body.Digits || "").trim() === "9";
  if (!pass) return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${absUrl(req, "/mcd-gate-prompt")}</Redirect>`));
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/exam-prompt?mode=mcd")}</Redirect>`));
});

app.post("/m1-gate-prompt", (req, res) => {
  const action = absUrl(req, "/m1-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 1. — Engagement and application. Press 8 to continue.",
    invalidText: "Gate not confirmed. Press 8."
  });
  res.type("text/xml").status(200).send(twimlResponse(inner));
});
app.post("/m1-gate", (req, res) => {
  const pass = (req.body.Digits || "").trim() === "8";
  if (!pass) return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${absUrl(req, "/m1-gate-prompt")}</Redirect>`));
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/exam-prompt?mode=m1")}</Redirect>`));
});

app.post("/m2-gate-prompt", (req, res) => {
  const action = absUrl(req, "/m2-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 2. — Post application follow up. Risk containment. Press 7 to continue.",
    invalidText: "Gate not confirmed. Press 7."
  });
  res.type("text/xml").status(200).send(twimlResponse(inner));
});
app.post("/m2-gate", (req, res) => {
  const pass = (req.body.Digits || "").trim() === "7";
  if (!pass) return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${absUrl(req, "/m2-gate-prompt")}</Redirect>`));
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/exam-prompt?mode=m2")}</Redirect>`));
});

// Practice vs Exam
app.post("/exam-prompt", (req, res) => {
  const mode = (req.query.mode || "").trim().toLowerCase();
  const action = absUrl(req, `/exam?mode=${encodeURIComponent(mode)}`);

  const inner = gatherOneDigit({
    action,
    promptText: "Select mode. Press 1 for Practice. Press 2 for Exam.",
    invalidText: "Invalid. Press 1 for Practice. Press 2 for Exam."
  });

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/exam", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From || "";
  const mode = (req.query.mode || "").trim().toLowerCase();
  const digit = (req.body.Digits || "").trim();

  if (!["mcd", "m1", "m2"].includes(mode)) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid mode.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
    );
  }

  const examMode = digit === "2";
  if (digit !== "1" && digit !== "2") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${absUrl(req, `/exam-prompt?mode=${encodeURIComponent(mode)}`)}</Redirect>`)
    );
  }

  const st = getOrInitState(callSid);
  st.from = from;
  st.mode = mode;
  st.examMode = examMode;

  if (examMode) {
    const key = `${todayKey()}:${from}:${mode}`;
    if (EXAM_ATTEMPTS.has(key)) {
      return res.type("text/xml").status(200).send(
        twimlResponse(`${say("Exam already taken today for this module. Practice mode is available.")}<Redirect method="POST">${absUrl(req, `/exam-prompt?mode=${encodeURIComponent(mode)}`)}</Redirect>`)
      );
    }
    EXAM_ATTEMPTS.set(key, { ts: Date.now(), callSid });
  }

  return res.type("text/xml").status(200).send(
    twimlResponse(`<Redirect method="POST">${absUrl(req, `/difficulty-prompt?mode=${encodeURIComponent(mode)}`)}</Redirect>`)
  );
});

// Difficulty selection
app.post("/difficulty-prompt", (req, res) => {
  const mode = (req.query.mode || "").trim();
  const action = absUrl(req, `/difficulty?mode=${encodeURIComponent(mode)}`);

  const inner = gatherOneDigit({
    action,
    promptText: "Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.",
    invalidText: "Invalid selection. Press 1, 2, or 3."
  });

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/difficulty", (req, res) => {
  const sid = req.body.CallSid;
  const mode = (req.query.mode || "").trim().toLowerCase();
  const digit = (req.body.Digits || "").trim();

  const difficulty =
    digit === "1" ? "Standard" :
    digit === "2" ? "Moderate" :
    digit === "3" ? "Edge" : null;

  if (!difficulty || !["mcd", "m1", "m2"].includes(mode)) {
    const retry = absUrl(req, `/difficulty-prompt?mode=${encodeURIComponent(mode)}`);
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${retry}</Redirect>`));
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("No scenarios available.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
    );
  }

  const st = getOrInitState(sid);
  st.mode = mode;
  st.difficulty = difficulty;
  st.scenarioId = scenario.id;
  st.ruleFocus = scenario.ruleFocus || [];
  st.baitType = scenario.baitType || "";
  st.requiredOutcome = scenario.requiredOutcome || "";

  console.log(JSON.stringify({
    event: "SCENARIO_LOADED",
    sid,
    mode,
    difficulty,
    scenarioId: scenario.id,
    borrowerName: scenario.borrowerName,
    borrowerGender: scenario.borrowerGender,
    ruleFocus: st.ruleFocus,
    baitType: st.baitType
  }));

  const inner = `
    ${say(`Scenario. ${String(scenario.summary || "")}`)}
    ${say(`Primary objective. ${String(scenario.objective || "")}`)}
    ${say("Press 1 to connect. Press 9 to end and hear your scorecard.")}

    <Gather input="dtmf" numDigits="1" action="${absUrl(req, "/connect")}" method="POST" timeout="8">
      ${say("Make your selection now.")}
    </Gather>

    ${say("No input received. Press 1 to connect. Press 9 for scorecard.")}
    <Redirect method="POST">${absUrl(req, "/connect")}</Redirect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// Connect or Scorecard
app.post("/connect", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const st = getOrInitState(sid);

  if (digit === "9") {
    st.endedAt = Date.now();
    return res.type("text/xml").status(200).send(
      twimlResponse(`<Redirect method="POST">${absUrl(req, "/score")}</Redirect>`)
    );
  }

  if (digit !== "1") {
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid selection. Returning to main menu.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
    );
  }

  const list = (SCENARIOS?.[st.mode]?.[st.difficulty]) || [];
  const scenario = list.find((s) => String(s.id) === String(st.scenarioId)) || null;

  if (!scenario) {
    addViolation(sid, "SCENARIO_MISSING", "Scenario not found at connect time.");
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Scenario missing. Returning to main menu.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
    );
  }

  const { style, rng } = chooseStyleForCall({ callSid: sid, scenario, difficulty: st.difficulty });
  const borrowerMeta = resolveBorrowerMeta({ scenario, style, rng });

  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const streamUrl = `wss://${host}/twilio`;

  const inner = `
    ${say("Connecting now. The borrower will speak first.")}

    <Connect>
      <Stream url="${streamUrl}">
        <Parameter name="mode" value="${xmlEscape(st.mode)}" />
        <Parameter name="difficulty" value="${xmlEscape(st.difficulty)}" />
        <Parameter name="scenarioId" value="${xmlEscape(scenario.id)}" />

        <Parameter name="borrowerName" value="${xmlEscape(scenario.borrowerName)}" />
        <Parameter name="borrowerGender" value="${xmlEscape(scenario.borrowerGender)}" />

        <Parameter name="style" value="${xmlEscape(borrowerMeta.style)}" />
        <Parameter name="emotion" value="${xmlEscape(borrowerMeta.emotion)}" />
        <Parameter name="distractor" value="${xmlEscape(borrowerMeta.distractor)}" />
        <Parameter name="talkativeness" value="${xmlEscape(borrowerMeta.talkativeness)}" />
        <Parameter name="patience" value="${xmlEscape(borrowerMeta.patience)}" />
        <Parameter name="trust" value="${xmlEscape(borrowerMeta.trust)}" />
        <Parameter name="disfluency" value="${xmlEscape(borrowerMeta.disfluency)}" />
        <Parameter name="thinkDelayMin" value="${xmlEscape(borrowerMeta.thinkDelayMin)}" />
        <Parameter name="thinkDelayMax" value="${xmlEscape(borrowerMeta.thinkDelayMax)}" />

        <Parameter name="examMode" value="${xmlEscape(st.examMode ? "true" : "false")}" />
      </Stream>
    </Connect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// Scorecard (spoken)
app.post("/score", (req, res) => {
  const sid = req.body.CallSid;
  const st = getOrInitState(sid);
  const score = computeScore(sid);

  const rf = (st.ruleFocus || []).length ? st.ruleFocus.join(", ") : "none";
  const verdict = score.pass ? "PASS" : "FAIL";

  const v1 = score.violations[0] ? score.violations[0].code : "";
  const v2 = score.violations[1] ? score.violations[1].code : "";

  const inner = `
    ${say("Scorecard.")}
    ${say(`Mode ${st.mode}. Difficulty ${st.difficulty}. Scenario I D. ${st.scenarioId}.`)}
    ${say(`Rule focus. ${rf}.`)}
    ${say(`Result. ${verdict}.`)}

    ${score.tripwireCount > 0 ? say(`Tripwire triggered. ${score.tripwireCount}.`) : ""}

    ${v1 ? say(`Violation 1. ${v1}.`) : say("No violations recorded.")}
    ${v2 ? say(`Violation 2. ${v2}.`) : ""}

    ${say(coachingDirective(st))}
    ${say("End of scorecard. Goodbye.")}
    <Hangup/>
  `;

  res.type("text/xml").status(200).send(twimlResponse
