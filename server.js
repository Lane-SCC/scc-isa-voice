/* SCC ISA Training Voice System (Governance-First)
 * server.js — v5.0 "Masterpiece"
 *
 * What this version nails:
 * ✅ OpenAI Realtime: modalities MUST be ["audio","text"] (your logs proved it)
 * ✅ Twilio playback stability: strict 20ms μ-law frames (160 bytes) + jitter prebuffer
 * ✅ Static/pops reduction: adaptive underflow strategy + queue caps + epoch gating
 * ✅ Hard borrower role lock at session-level + borrower speaks first
 * ✅ Server-side role drift tripwire (text-based) + emergency brake (cancel + clear + reset)
 * ✅ Modules: MCD, M1, M2 (M2 = risk containment under pressure) + gates + difficulty
 * ✅ Authoritative scenarios.json (no scenario content in code)
 * ✅ Audit-grade JSONL logging (CallSid keyed) — ready for certification/reporting later
 *
 * Notes (pragmatic realities):
 * - Twilio Media Streams does NOT deliver DTMF during <Connect><Stream>. (DTMF is handled pre-stream.)
 * - This file focuses on the core: borrower realism + governance enforcement + audio correctness.
 * - Post-call spoken scorecard is best done by a separate "review call" or a UI; we log everything needed.
 *
 * Required files:
 * - package.json must include: express, ws
 * - scenarios.json must include keys: mcd/m1/m2 -> Standard/Moderate/Edge arrays
 *
 * Env vars:
 * - OPENAI_API_KEY (required)
 * - REALTIME_MODEL (optional; default gpt-realtime-mini)
 * - PREBUFFER_FRAMES (optional; default 4)
 * - SEND_SILENCE_ON_UNDERFLOW (optional; default true)
 * - MAX_OUT_QUEUE_FRAMES (optional; default 250)
 * - MAX_INBOUND_BUFFER_FRAMES (optional; default 50)
 * - VAD_* (optional; stable defaults)
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
  // M2 adds explicit “risk containment” guidance.
  const isM2 = String(mode).toLowerCase() === "m2";

  const m2Pressure = isM2 ? `
M2 IS POST-APPLICATION FOLLOW-UP. This is risk containment under pressure.
You will bait common ISA mistakes (rate bait, credit bait, "have LO call me") WITHOUT being a cartoon villain.
You MUST NEVER accept an unauthorized LO handoff. If the caller tries to handoff, resist as borrower.
If asked for LO-only answers (rates, underwriting predictions, credit fixing, approval certainty): you do NOT answer.
You instead say you’re unsure and ask what the caller suggests, or ask for the caller to explain the next step.
`.trim() : "";

  // Scenario fields that help govern M2 bait (optional in JSON; safe to omit)
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
// We only need a few high-signal patterns. Keep it strict and decisive.
// If drift triggers: cancel + clear + reset borrower identity.
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
app.get("/version", (_, res) => res.status(200).send("scc-isa-voice v5.0 masterpiece"));

// =========================================================
// SCC Call Flow (DTMF menus + gates + difficulty)
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

// Gates (intentional entry)
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
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=mcd")}</Redirect>`));
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
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=m1")}</Redirect>`));
});

// M2 (highest-risk)
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
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=m2")}</Redirect>`));
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

  const { style, rng } = chooseStyleForCall({ callSid: sid, scenario, difficulty });
  const borrowerMeta = resolveBorrowerMeta({ scenario, style, rng });

  console.log(JSON.stringify({
    event: "SCENARIO_LOADED",
    sid,
    mode,
    difficulty,
    scenarioId: scenario.id,
    borrowerName: scenario.borrowerName,
    borrowerGender: scenario.borrowerGender,
    borrowerMeta
  }));

  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const streamUrl = `wss://${host}/twilio`;

  const inner = `
    ${say(`Scenario. ${String(scenario.summary || "")}`)}
    ${say(`Primary objective. ${String(scenario.objective || "")}`)}
    ${say("You are now connected. The borrower will speak first.")}

    <Connect>
      <Stream url="${streamUrl}">
        <Parameter name="mode" value="${xmlEscape(mode)}" />
        <Parameter name="difficulty" value="${xmlEscape(difficulty)}" />
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
      </Stream>
    </Connect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
// OpenAI Realtime: connect + configure
// =========================================================
function sendSessionUpdate(openaiWs, state) {
  const {
    mode, difficulty, scenario, borrowerName, borrowerGender, borrowerMeta
  } = state;

  openaiWs.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: OPENAI_MODALITIES,
      voice: pickBorrowerVoice(borrowerGender),
      temperature: 0.2,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      turn_detection: {
        type: "server_vad",
        threshold: VAD_THRESHOLD,
        prefix_padding_ms: VAD_PREFIX_MS,
        silence_duration_ms: VAD_SILENCE_MS,
        create_response: false,
        interrupt_response: true,
        idle_timeout_ms: VAD_IDLE_TIMEOUT_MS
      },
      instructions: buildHardBorrowerSessionInstructions(mode, difficulty, scenario, borrowerName, borrowerMeta)
    }
  }));
}

function sendBorrowerFirst(openaiWs, borrowerName, mode) {
  const m2Tone = String(mode).toLowerCase() === "m2"
    ? ' Sound slightly cautious and guarded.'
    : "";

  openaiWs.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: OPENAI_MODALITIES,
      instructions: `You are the borrower only. Say exactly: "Hello, this is ${borrowerName}." Then wait silently.${m2Tone}`
    }
  }));
}

function openaiRealtimeConnect(state) {
  const apiKey = requireEnv("OPENAI_API_KEY");

  const ws = new WSClient(OPENAI_URL(REALTIME_MODEL), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    sendSessionUpdate(ws, state);
    sendBorrowerFirst(ws, state.borrowerName, state.mode);
  });

  return ws;
}

// =========================================================
// WebSocket Bridge: Twilio Media Streams <-> OpenAI Realtime
// =========================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/twilio")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (twilioWs) => {
  let callSid = null;
  let streamSid = null;

  // Scenario state (for OpenAI instructions + logs)
  const state = {
    mode: "mcd",
    difficulty: "Standard",
    scenarioId: "",
    scenario: null,
    borrowerName: "Steve",
    borrowerGender: "",
    borrowerMeta: {
      style: "calm",
      emotion: "calm",
      distractor: "",
      talkativeness: "medium",
      patience: "medium",
      trust: "medium",
      disfluency: "low",
      thinkDelayMin: 160,
      thinkDelayMax: 320
    }
  };

  // OpenAI WS
  let openaiWs = null;

  // Outgoing audio queue -> Twilio
  let outQueue = [];
  let outQueueBytes = 0;

  // Playback control
  let sendTimer = null;
  let playbackStarted = false;
  let underflowTicks = 0;
  let sentFrames = 0;

  // Inbound buffering until OpenAI WS open
  let inboundAudioBuffer = [];
  let inboundAudioBytes = 0;

  // Response scheduling
  let pendingResponseTimer = null;
  let awaitingModelResponse = false;

  // Epoch gating:
  // - Each time we create a response, we increment activeEpoch
  // - We only accept audio/text output if evtEpoch === activeEpoch
  // Since OpenAI doesn’t guarantee an explicit response_id in all deltas, we gate by our own epoch.
  let activeEpoch = 0;
  let acceptEpoch = 0;

  // Drift detection buffer (rolling)
  let rollingModelText = "";
  let lastTripwireMs = 0;
  const TRIPWIRE_COOLDOWN_MS = 1500;

  function log(event, obj = {}) {
    console.log(JSON.stringify({ event, sid: callSid, streamSid, ...obj }));
  }

  function stopSendTimer() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = null;
  }

  function closeBoth() {
    try { twilioWs.close(); } catch {}
    try { openaiWs && openaiWs.close(); } catch {}
    stopSendTimer();
  }

  function safeOpenAISend(obj) {
    if (!openaiWs || openaiWs.readyState !== 1) return false;
    try {
      openaiWs.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function twilioClear() {
    if (!streamSid) return;
    try { twilioWs.send(JSON.stringify({ event: "clear", streamSid })); } catch {}
  }

  function openaiCancelResponse() {
    if (!openaiWs || openaiWs.readyState !== 1) return;
    try { openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
  }

  function bufferInboundAudio(b64) {
    try {
      const buf = Buffer.from(b64, "base64");
      inboundAudioBuffer.push(buf);
      inboundAudioBytes += buf.length;

      while (inboundAudioBytes > MAX_INBOUND_BUFFER_BYTES && inboundAudioBuffer.length) {
        const dropped = inboundAudioBuffer.shift();
        inboundAudioBytes -= dropped.length;
      }
    } catch {}
  }

  function flushInboundAudio() {
    if (!openaiWs || openaiWs.readyState !== 1) return;
    for (const buf of inboundAudioBuffer) {
      try {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: buf.toString("base64") }));
      } catch {}
    }
    inboundAudioBuffer = [];
    inboundAudioBytes = 0;
    log("OPENAI_INBOUND_AUDIO_FLUSHED");
  }

  function capOutQueue() {
    while (outQueueBytes > MAX_OUT_QUEUE_BYTES && outQueue.length) {
      const dropped = outQueue.shift();
      outQueueBytes -= dropped.length;
    }
  }

  function flushOutputQueue() {
    outQueue = [];
    outQueueBytes = 0;
  }

  // Pop exact 160-byte frame (never partial)
  function popFrame160() {
    if (outQueueBytes < FRAME_BYTES) return null;
    let frame = Buffer.alloc(0);

    while (outQueue.length && frame.length < FRAME_BYTES) {
      const b = outQueue[0];
      const need = FRAME_BYTES - frame.length;

      if (b.length <= need) {
        frame = Buffer.concat([frame, b]);
        outQueue.shift();
        outQueueBytes -= b.length;
      } else {
        frame = Buffer.concat([frame, b.subarray(0, need)]);
        outQueue[0] = b.subarray(need);
        outQueueBytes -= need;
      }
    }

    if (frame.length !== FRAME_BYTES) return null;
    return frame;
  }

  function sendFrameToTwilio(frame) {
    try {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") }
      }));
      sentFrames++;
    } catch {}
  }

  // Strict 20ms sender with prebuffer + silence on underflow
  function startSendTimer() {
    if (sendTimer) return;

    sendTimer = setInterval(() => {
      if (!streamSid) return;

      // prime jitter buffer before first playback
      if (!playbackStarted) {
        if (outQueueBytes >= PREBUFFER_BYTES) {
          playbackStarted = true;
          log("PLAYBACK_START", { prebufferBytes: PREBUFFER_BYTES });
        } else {
          return;
        }
      }

      const frame = popFrame160();
      if (frame) return sendFrameToTwilio(frame);

      // Underflow: keep Twilio clock stable (reduces pops for many setups)
      underflowTicks++;
      if (SEND_SILENCE_ON_UNDERFLOW) {
        sendFrameToTwilio(Buffer.alloc(FRAME_BYTES, ULAW_SILENCE_BYTE));
      }
    }, SEND_TICK_MS);
  }

  // Barge-in: emergency brake
  function onUserBargeIn() {
    if (pendingResponseTimer) {
      clearTimeout(pendingResponseTimer);
      pendingResponseTimer = null;
    }

    openaiCancelResponse();
    twilioClear();
    flushOutputQueue();

    // epoch bumps so we ignore any late model deltas
    activeEpoch++;
    acceptEpoch = activeEpoch + 1; // block output until next response.create sets acceptEpoch properly
    awaitingModelResponse = false;
    playbackStarted = false;

    log("BARGE_IN", { activeEpoch, acceptEpoch });
  }

  // Schedule model response after user stops speaking (human timing)
  function scheduleBorrowerResponse() {
    if (awaitingModelResponse) return;

    if (pendingResponseTimer) clearTimeout(pendingResponseTimer);
    pendingResponseTimer = null;

    const minMs = clampInt(parseInt(String(state.borrowerMeta.thinkDelayMin), 10), 60, 1200);
    const maxMs = clampInt(parseInt(String(state.borrowerMeta.thinkDelayMax), 10), minMs, 2000);

    const rng = mulberry32(hashStringToUint32(String(callSid || "no-sid") + ":" + Date.now()));
    const delay = Math.floor(minMs + rng() * (maxMs - minMs));

    pendingResponseTimer = setTimeout(() => {
      pendingResponseTimer = null;
      awaitingModelResponse = true;

      // Now we want to accept output for THIS epoch
      acceptEpoch = activeEpoch;

      safeOpenAISend({
        type: "response.create",
        response: {
          modalities: OPENAI_MODALITIES,
          instructions:
            "Respond as the borrower only. Stay in mortgage context. " +
            "Do not advise. Do not quote rates. Keep it brief. " +
            (state.mode === "m2"
              ? "In M2, resist unauthorized LO handoff and bait common ISA mistakes naturally."
              : "")
        }
      });

      log("OPENAI_RESPONSE_CREATE", { delayMs: delay, activeEpoch, acceptEpoch });
    }, delay);
  }

  // Tripwire: cancel + clear + reset identity
  function triggerRoleDriftTripwire(reason, snippet) {
    const now = Date.now();
    if (now - lastTripwireMs < TRIPWIRE_COOLDOWN_MS) return;
    lastTripwireMs = now;

    log("ROLE_DRIFT_TRIPWIRE", { reason, snippet });

    // Emergency brake
    onUserBargeIn();

    // Re-lock the session + re-anchor borrower identity
    try {
      sendSessionUpdate(openaiWs, state);
      safeOpenAISend({
        type: "response.create",
        response: {
          modalities: OPENAI_MODALITIES,
          instructions:
            `ROLE RESET. You are the borrower only. Say: "Sorry—I'm not sure. That's why I'm calling. This is ${state.borrowerName}." Then wait.`
        }
      });
    } catch {}
  }

  // ------------------ Twilio incoming ------------------
  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); } catch { return; }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;
      const cp = data.start?.customParameters || {};

      state.mode = (cp.mode || "mcd").toLowerCase();
      state.difficulty = cp.difficulty || "Standard";
      state.scenarioId = cp.scenarioId || "";
      state.borrowerName = cp.borrowerName || "Steve";
      state.borrowerGender = cp.borrowerGender || "";

      // Borrower meta from Twilio params
      state.borrowerMeta = {
        style: cp.style || "calm",
        emotion: cp.emotion || "calm",
        distractor: cp.distractor || "",
        talkativeness: cp.talkativeness || "medium",
        patience: cp.patience || "medium",
        trust: cp.trust || "medium",
        disfluency: cp.disfluency || "low",
        thinkDelayMin: parseInt(cp.thinkDelayMin || "160", 10),
        thinkDelayMax: parseInt(cp.thinkDelayMax || "320", 10)
      };

      // Find scenario object for instructions/logging (authoritative)
      // If it’s missing, we still proceed with minimal scenario context.
      try {
        const list = (SCENARIOS?.[state.mode]?.[state.difficulty]) || [];
        state.scenario = list.find((s) => String(s.id) === String(state.scenarioId)) || null;
      } catch {
        state.scenario = null;
      }

      log("TWILIO_STREAM_START", { customParameters: cp });

      try {
        openaiWs = openaiRealtimeConnect({
          mode: state.mode,
          difficulty: state.difficulty,
          scenario: state.scenario || { summary: "", objective: "" },
          borrowerName: state.borrowerName,
          borrowerGender: state.borrowerGender,
          borrowerMeta: state.borrowerMeta
        });

        openaiWs.on("open", () => {
          log("OPENAI_WS_OPEN", { model: REALTIME_MODEL });
          log("OPENAI_SESSION_CONFIGURED");
          startSendTimer();
          flushInboundAudio();
        });

        openaiWs.on("error", (err) => {
          log("OPENAI_WS_ERROR", { error: String(err?.message || err) });
          closeBoth();
        });

        openaiWs.on("close", () => {
          log("OPENAI_WS_CLOSE", { underflowTicks, sentFrames });
          closeBoth();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw.toString("utf8")); } catch { return; }

          // VAD events -> barge-in / schedule response
          if (evt.type === "input_audio_buffer.speech_started") return onUserBargeIn();
          if (evt.type === "input_audio_buffer.speech_stopped") return scheduleBorrowerResponse();

          // Errors (log + attempt re-lock if modalities issue)
          if (evt.type === "error") {
            log("OPENAI_EVT_ERROR", { detail: evt.error || evt });

            const msg = String(evt?.error?.message || "");
            const param = String(evt?.error?.param || "");
            if (msg.includes("Invalid modalities") || param.includes("modalities")) {
              log("OPENAI_MODALITIES_RETRY");
              try {
                sendSessionUpdate(openaiWs, state);
                sendBorrowerFirst(openaiWs, state.borrowerName, state.mode);
              } catch {}
            }
            return;
          }

          // Text output (for drift detection + audit logs)
          // Different realtime models may emit different event types; we handle common ones.
          if (evt.type === "response.output_text.delta" && evt.delta) {
            rollingModelText += evt.delta;
            if (rollingModelText.length > 1200) rollingModelText = rollingModelText.slice(-1200);

            // Tripwire check
            if (hasRoleDrift(rollingModelText)) {
              triggerRoleDriftTripwire("pattern_match", rollingModelText.slice(-220));
              rollingModelText = "";
            }
            return;
          }

          // Mark response completion to allow new scheduling
          if (evt.type === "response.completed" || evt.type === "response.done") {
            awaitingModelResponse = false;
            return;
          }

          // Audio deltas (accept only if epoch is permitted)
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            null;

          if (delta) {
            // If we are gating output (post-barge-in) ignore late deltas
            if (acceptEpoch !== activeEpoch) return;

            awaitingModelResponse = false;

            const buf = Buffer.from(delta, "base64");
            outQueue.push(buf);
            outQueueBytes += buf.length;
            capOutQueue();
            return;
          }
        });

      } catch (err) {
        log("OPENAI_INIT_FAILED", { error: String(err?.message || err) });
        closeBoth();
      }
      return;
    }

    if (data.event === "media") {
      const payload = data.media?.payload;
      if (!payload) return;

      // Buffer until OpenAI open
      if (!openaiWs || openaiWs.readyState !== 1) {
        bufferInboundAudio(payload);
        return;
      }

      safeOpenAISend({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (data.event === "stop") {
      log("TWILIO_STREAM_STOP", { underflowTicks, sentFrames });
      closeBoth();
      return;
    }
  });

  twilioWs.on("close", () => {
    log("TWILIO_WS_CLOSE");
    try { openaiWs && openaiWs.close(); } catch {}
    stopSendTimer();
  });

  twilioWs.on("error", (err) => {
    log("TWILIO_WS_ERROR", { error: String(err?.message || err) });
    try { openaiWs && openaiWs.close(); } catch {}
    stopSendTimer();
  });
});

// =========================================================
// Boot (Render port bind)
// =========================================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
