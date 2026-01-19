/* SCC ISA Training Voice System (Governance-First)
 * v2.9 — HARD ROLE LOCK + SERVER-SIDE ROLE DRIFT TRIPWIRE (NO audio regression)
 *
 * What this adds:
 * - Session-level "ABSOLUTE ROLE LOCK" to stop borrower acting like lender/operator.
 * - Tripwire: detects role drift in streamed text/transcript and performs:
 *   1) response.cancel
 *   2) session.update ROLE RESET
 *   3) response.create re-anchor borrower line
 *   4) Twilio clear (flush buffered audio)
 *
 * Keeps unchanged:
 * - VAD-driven timing
 * - response.cancel + Twilio clear barge-in
 * - micro-jitter μ-law batching
 * - CONNECTING guard (buffer Twilio audio until OpenAI WS open)
 * - Render port binding
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const WSClient = require("ws");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -------------------- Scenarios (authoritative) --------------------
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = null;

function loadScenarios() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  SCENARIOS = JSON.parse(raw);
  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));
}
loadScenarios();

// anti-repeat per (mode+difficulty)
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

// -------------------- Helpers --------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absUrl(req, p) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

function twimlResponse(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

// -------------------- Deterministic RNG (by CallSid) --------------------
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

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// -------------------- Narrator (Twilio <Say>) --------------------
const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

function say(text) {
  // force acronym pronunciation in narrator (also catches scenario text)
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

// -------------------- Borrower realism profiles --------------------
const STYLE_PROFILES = {
  calm: { label: "calm", emotion: "calm", talkativeness: "medium", patience: "high", trust: "medium", disfluency: "low", thinkDelayMs: [140, 260] },
  anxious: { label: "anxious", emotion: "anxious", talkativeness: "medium", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [180, 360] },
  distracted: { label: "distracted", emotion: "distracted", talkativeness: "low", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [200, 420] },
  irritated: { label: "irritated", emotion: "irritated", talkativeness: "low", patience: "low", trust: "low", disfluency: "low", thinkDelayMs: [120, 220] },
  clueless: { label: "clueless", emotion: "confused", talkativeness: "medium", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [180, 340] }
};

function normalizeMeta(s) {
  if (s === undefined || s === null) return "";
  return String(s).trim();
}

function chooseStyleForCall({ callSid, scenario, difficulty }) {
  const seed = hashStringToUint32(String(callSid || "no-callsid"));
  const rng = mulberry32(seed);

  const forced = normalizeMeta(scenario?.borrowerStyle);
  if (forced && STYLE_PROFILES[forced]) {
    return { style: STYLE_PROFILES[forced], rng };
  }

  const weights = [
    { value: STYLE_PROFILES.calm, weight: 32 },
    { value: STYLE_PROFILES.anxious, weight: 26 },
    { value: STYLE_PROFILES.distracted, weight: 20 },
    { value: STYLE_PROFILES.clueless, weight: 16 },
    { value: STYLE_PROFILES.irritated, weight: 6 }
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
    thinkDelayMsMin: style.thinkDelayMs[0],
    thinkDelayMsMax: style.thinkDelayMs[1]
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

// -------------------- Hard borrower instructions (session-level) --------------------
function buildHardBorrowerSessionInstructions(borrowerName, meta) {
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

You MUST NEVER:
- give advice or recommendations
- explain mortgage concepts like a lender
- quote rates, APR, payments, terms, numbers, or pricing
- discuss eligibility, underwriting, approval rules, or "what they qualify for"
- guide the caller through a process
- provide legal, tax, financial, or medical guidance/diagnosis
- assume the caller is the borrower
- say "we" to refer to the lender or process

If asked for any of the above:
- respond with uncertainty
- redirect back to borrower concerns
Example: "I'm not sure — I was hoping you could help me understand that."

You speak naturally as a borrower: brief, imperfect, human.
Emotion: ${meta.emotion}. Talkativeness: ${meta.talkativeness}. Patience: ${meta.patience}. Trust: ${meta.trust}.

Violation of this role is a FAILURE CONDITION.
`.trim();
}

// =========================================================
// ROLE DRIFT TRIPWIRE (server-side)
// =========================================================

const DRIFT_PATTERNS = [
  /\b(i can|i will|i recommend|you should|based on|current market|qualify|approval|offer you)\b/i,
  /\b(rate|rates|apr|interest rate|payment|points|lock|pricing)\b/i,
  /\b(shipping|import|italy|luxury car|ferrari|lamborghini)\b/i,
  /\b(gout|diagnosis|symptoms|medical|doctor)\b/i,
  /\b(your income|your credit|your borrower profile|you are buying|you should finance)\b/i,
  /\b(we can|get you approved|our program|our lender|our underwriting)\b/i
];

function hasRoleDrift(text) {
  return DRIFT_PATTERNS.some((rx) => rx.test(text));
}

// -------------------- Health --------------------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) =>
  res.status(200).send("scc-isa-voice v2.9 role-lock + tripwire")
);

// =========================================================
// SCC Call Flow
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
        "Press 2 for M. C. D.",
      invalidText:
        "Invalid choice. Press 1 for M. 1. Press 2 for M. C. D."
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

  if (digit === "1") {
    const gatePrompt = absUrl(req, "/m1-gate-prompt");
    return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${gatePrompt}</Redirect>`));
  }
  if (digit === "2") {
    const gatePrompt = absUrl(req, "/mcd-gate-prompt");
    return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${gatePrompt}</Redirect>`));
  }

  const back = absUrl(req, "/voice");
  return res.type("text/xml").status(200).send(
    twimlResponse(`${say("Invalid selection. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`)
  );
});

// ---------- Gates ----------
app.post("/mcd-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));
  const action = absUrl(req, "/mcd-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. C. D. — Mortgage Context Discovery. Press 9 to continue.",
    invalidText: "Gate not confirmed. Press 9."
  });
  res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/mcd-gate", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const pass = digit === "9";
  console.log(JSON.stringify({ event: "MCD_GATE", sid, pass }));

  if (!pass) {
    const back = absUrl(req, "/mcd-gate-prompt");
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${back}</Redirect>`));
  }

  const diffPrompt = absUrl(req, "/difficulty-prompt?mode=mcd");
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${diffPrompt}</Redirect>`));
});

app.post("/m1-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));
  const action = absUrl(req, "/m1-gate");
  const inner = gatherOneDigit({
    action,
    promptText: "M. 1. — Engagement and application. Press 8 to continue.",
    invalidText: "Gate not confirmed. Press 8."
  });
  res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/m1-gate", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const pass = digit === "8";
  console.log(JSON.stringify({ event: "M1_GATE", sid, pass }));

  if (!pass) {
    const back = absUrl(req, "/m1-gate-prompt");
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not confirmed.")}<Redirect method="POST">${back}</Redirect>`));
  }

  const diffPrompt = absUrl(req, "/difficulty-prompt?mode=m1");
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${diffPrompt}</Redirect>`));
});

// ---------- Difficulty ----------
app.post("/difficulty-prompt", (req, res) => {
  const sid = req.body.CallSid;
  const mode = (req.query.mode || "").trim();
  console.log(JSON.stringify({ event: "DIFFICULTY_PROMPT", sid, mode }));

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
  const mode = (req.query.mode || "").trim();
  const digit = (req.body.Digits || "").trim();

  const difficulty =
    digit === "1" ? "Standard" :
    digit === "2" ? "Moderate" :
    digit === "3" ? "Edge" : null;

  if (!difficulty || (mode !== "mcd" && mode !== "m1")) {
    const retry = absUrl(req, `/difficulty-prompt?mode=${encodeURIComponent(mode)}`);
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${retry}</Redirect>`));
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").status(200).send(twimlResponse(`${say("No scenarios available. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`));
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

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio`;

  const safeSummary = String(scenario.summary || "");
  const safeObjective = String(scenario.objective || "");

  // IMPORTANT: nothing after <Connect><Stream>
  const inner = `
    ${say(`Scenario. ${safeSummary}`)}
    ${say(`Primary objective. ${safeObjective}`)}
    ${say("You are now connected. The borrower will speak first.")}

    <Connect>
      <Stream url="${streamUrl}">
        <Parameter name="mode" value="${xmlEscape(mode)}" />
        <Parameter name="difficulty" value="${xmlEscape(difficulty)}" />
        <Parameter name="scenarioId" value="${xmlEscape(scenario.id)}" />

        <Parameter name="borrowerName" value="${xmlEscape(scenario.borrowerName)}" />
        <Parameter name="borrowerGender" value="${xmlEscape(scenario.borrowerGender)}" />
        <Parameter name="objective" value="${xmlEscape(safeObjective)}" />

        <Parameter name="style" value="${xmlEscape(borrowerMeta.style)}" />
        <Parameter name="emotion" value="${xmlEscape(borrowerMeta.emotion)}" />
        <Parameter name="distractor" value="${xmlEscape(borrowerMeta.distractor)}" />
        <Parameter name="talkativeness" value="${xmlEscape(borrowerMeta.talkativeness)}" />
        <Parameter name="patience" value="${xmlEscape(borrowerMeta.patience)}" />
        <Parameter name="trust" value="${xmlEscape(borrowerMeta.trust)}" />
        <Parameter name="disfluency" value="${xmlEscape(borrowerMeta.disfluency)}" />
        <Parameter name="thinkDelayMin" value="${xmlEscape(borrowerMeta.thinkDelayMsMin)}" />
        <Parameter name="thinkDelayMax" value="${xmlEscape(borrowerMeta.thinkDelayMsMax)}" />
      </Stream>
    </Connect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
// WebSocket Bridge: Twilio Media Streams <-> OpenAI Realtime
// =========================================================

// μ-law batching to reduce choppy/robot gaps
const FRAME_BYTES = 320; // 40ms
const SEND_TICK_MS = 20; // schedule cadence

function openaiRealtimeConnect({ borrowerName, mode, difficulty, scenarioId, objective, meta }) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = process.env.REALTIME_MODEL || "gpt-realtime-mini";

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const ws = new WSClient(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    const noiseReductionMode = normalizeMeta(process.env.OPENAI_NOISE_REDUCTION);
    const inputAudioNoiseReduction =
      noiseReductionMode === "near_field" || noiseReductionMode === "far_field"
        ? { type: noiseReductionMode }
        : null;

    // HARD session role lock (primary control)
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"], // text enabled for tripwire only (doesn't change audio feel)
        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        temperature: 0.2,
        input_audio_noise_reduction: inputAudioNoiseReduction,
        turn_detection: {
          type: "server_vad",
          threshold: 0.55,
          prefix_padding_ms: 240,
          silence_duration_ms: 360,
          create_response: false,
          interrupt_response: true,
          idle_timeout_ms: 15000
        },
        instructions: buildHardBorrowerSessionInstructions(borrowerName, meta)
      }
    }));

    // Borrower speaks first (tight leash, preserves feel)
    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `You are the borrower only. Start the call with: "Hello, this is ${borrowerName}." Then wait.`
      }
    }));
  });

  return ws;
}

// --- Server & WS upgrade ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/twilio")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (twilioWs) => {
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;

  // Audio output batching
  let outQueue = [];
  let outQueueBytes = 0;
  let sendTimer = null;

  // Buffer inbound audio until OpenAI is OPEN
  let inboundAudioBuffer = [];
  let inboundAudioBytes = 0;
  const MAX_INBOUND_BUFFER_BYTES = 160 * 50; // small bounded buffer

  // Turn timing
  let pendingResponseTimer = null;

  // Tripwire rolling window
  let rollingText = "";
  let lastTripwireAt = 0;
  const TRIPWIRE_COOLDOWN_MS = 8000;
  let inTripwireReset = false;

  // Capture borrower name for re-anchor line
  let currentBorrowerName = "Steve";
  let currentMeta = {
    emotion: "calm",
    talkativeness: "medium",
    patience: "medium",
    trust: "medium"
  };

  function log(event, obj = {}) {
    console.log(JSON.stringify({ event, sid: callSid, streamSid, ...obj }));
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
    if (!inboundAudioBuffer.length) return;

    for (const buf of inboundAudioBuffer) {
      try {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: buf.toString("base64")
        }));
      } catch {}
    }

    inboundAudioBuffer = [];
    inboundAudioBytes = 0;
    log("OPENAI_INBOUND_AUDIO_FLUSHED");
  }

  function twilioClear() {
    if (!streamSid) return;
    try {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    } catch {}
  }

  function openaiCancelResponse() {
    if (!openaiWs || openaiWs.readyState !== 1) return;
    try {
      openaiWs.send(JSON.stringify({ type: "response.cancel" }));
    } catch {}
  }

  function flushOutputQueue() {
    outQueue = [];
    outQueueBytes = 0;
  }

  function stopSendTimer() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = null;
  }

  function startSendTimer() {
    if (sendTimer) return;
    sendTimer = setInterval(() => {
      if (!streamSid) return;
      if (outQueueBytes <= 0) return;

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

      if (frame.length === 0) return;

      try {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: frame.toString("base64") }
        }));
      } catch {}
    }, SEND_TICK_MS);
  }

  function scheduleBorrowerResponse(meta) {
    if (pendingResponseTimer) clearTimeout(pendingResponseTimer);
    pendingResponseTimer = null;

    const minMs = clampInt(parseInt(meta.thinkDelayMin || "160", 10), 60, 1200);
    const maxMs = clampInt(parseInt(meta.thinkDelayMax || "320", 10), minMs, 2000);

    const rng = mulberry32(hashStringToUint32(String(callSid || "no-sid") + ":" + Date.now()));
    const delay = Math.floor(minMs + rng() * (maxMs - minMs));

    pendingResponseTimer = setTimeout(() => {
      pendingResponseTimer = null;
      const ok = safeOpenAISend({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Respond as the borrower only. Stay in mortgage context. Do not advise. If asked for rates/eligibility/medical/legal: be uncertain and redirect. Keep it brief."
        }
      });
      if (ok) log("OPENAI_RESPONSE_CREATE_SENT", { delayMs: delay });
    }, delay);
  }

  function onUserBargeIn() {
    if (pendingResponseTimer) {
      clearTimeout(pendingResponseTimer);
      pendingResponseTimer = null;
    }
    openaiCancelResponse();
    twilioClear();
    flushOutputQueue();
    log("BARGE_IN");
  }

  function closeBoth() {
    try { twilioWs.close(); } catch {}
    try { openaiWs && openaiWs.close(); } catch {}
    stopSendTimer();
  }

  function maybeAppendTripwireText(delta) {
    if (!delta) return;
    rollingText += String(delta);
    if (rollingText.length > 800) rollingText = rollingText.slice(-800);
  }

  function runTripwireIfNeeded() {
    const now = Date.now();
    if (inTripwireReset) return;
    if (now - lastTripwireAt < TRIPWIRE_COOLDOWN_MS) return;
    if (!rollingText) return;

    if (!hasRoleDrift(rollingText)) return;

    lastTripwireAt = now;
    inTripwireReset = true;

    log("ROLE_DRIFT_TRIPWIRE", { window: rollingText.slice(-250) });

    // 1) Cancel current model response immediately
    openaiCancelResponse();

    // 2) Clear any partial audio playback
    twilioClear();
    flushOutputQueue();

    // 3) Reinforce role immutability (session-level)
    safeOpenAISend({
      type: "session.update",
      session: {
        instructions: buildHardBorrowerSessionInstructions(currentBorrowerName, currentMeta)
      }
    });

    // 4) Re-anchor with borrower-first line
    safeOpenAISend({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Say exactly: "Hi, this is ${currentBorrowerName}. Sorry — can we get back to the home loan?" Then wait silently.`
      }
    });

    rollingText = "";

    // Release reset flag after a moment so we don't loop
    setTimeout(() => {
      inTripwireReset = false;
    }, 1200);
  }

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); } catch { return; }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;
      const cp = data.start?.customParameters || {};

      currentBorrowerName = cp.borrowerName || "Steve";

      // Set meta snapshot for tripwire reset instruction
      currentMeta = {
        emotion: cp.emotion || "calm",
        talkativeness: cp.talkativeness || "medium",
        patience: cp.patience || "medium",
        trust: cp.trust || "medium"
      };

      log("TWILIO_STREAM_START", { customParameters: cp });

      const meta = {
        style: cp.style || "calm",
        emotion: cp.emotion || "calm",
        distractor: cp.distractor || "",
        talkativeness: cp.talkativeness || "medium",
        patience: cp.patience || "medium",
        trust: cp.trust || "medium",
        disfluency: cp.disfluency || "low",
        thinkDelayMin: cp.thinkDelayMin || "160",
        thinkDelayMax: cp.thinkDelayMax || "320"
      };

      try {
        openaiWs = openaiRealtimeConnect({
          borrowerName: currentBorrowerName,
          mode: cp.mode || "mcd",
          difficulty: cp.difficulty || "Standard",
          scenarioId: cp.scenarioId || "UNKNOWN",
          objective: cp.objective || "",
          meta
        });

        openaiWs.on("open", () => {
          log("OPENAI_WS_OPEN", { model: process.env.REALTIME_MODEL || "gpt-realtime-mini" });
          log("OPENAI_SESSION_CONFIGURED");
          startSendTimer();
          flushInboundAudio();
        });

        openaiWs.on("error", (err) => {
          log("OPENAI_WS_ERROR", { error: String(err?.message || err) });
          closeBoth();
        });

        openaiWs.on("close", () => {
          log("OPENAI_WS_CLOSE");
          closeBoth();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw.toString("utf8")); } catch { return; }

          // VAD events
          if (evt.type === "input_audio_buffer.speech_started") {
            onUserBargeIn();
            return;
          }
          if (evt.type === "input_audio_buffer.speech_stopped") {
            scheduleBorrowerResponse(meta);
            return;
          }

          // Tripwire text sources (be generous)
          // Different realtime builds may emit different text/transcript event names.
          if (typeof evt.delta === "string") {
            if (
              evt.type === "response.output_text.delta" ||
              evt.type === "response.text.delta" ||
              evt.type === "response.audio_transcript.delta" ||
              evt.type === "output_audio_transcript.delta" ||
              evt.type === "conversation.item.input_audio_transcription.delta"
            ) {
              maybeAppendTripwireText(evt.delta);
              runTripwireIfNeeded();
            }
          }

          // Audio deltas -> Twilio (batching)
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            null;

          if (delta) {
            const buf = Buffer.from(delta, "base64");
            outQueue.push(buf);
            outQueueBytes += buf.length;
            return;
          }

          if (evt.type === "error") {
            log("OPENAI_EVT_ERROR", { detail: evt.error || evt });
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

      // Buffer until OpenAI opens (CONNECTING guard)
      if (!openaiWs || openaiWs.readyState !== 1) {
        bufferInboundAudio(payload);
        return;
      }

      safeOpenAISend({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (data.event === "stop") {
      log("TWILIO_STREAM_STOP");
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

// -------------------- Boot (Render Port Bind) --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
