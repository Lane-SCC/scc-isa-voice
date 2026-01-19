/* SCC ISA Training Voice System (Governance-First)
 * server.js — v4.0 "Role-Locked, Frame-Locked, Jitter-Buffered"
 *
 * Primary fixes:
 * 1) OpenAI Realtime modalities bug: this model requires ["audio","text"] (NOT ["audio"]).
 * 2) Twilio playback stability: send ONLY exact 160-byte (20ms @ 8kHz μ-law) frames.
 * 3) Reduce pops/stutter: jitter buffer + optional silence fill on underflow.
 * 4) Hard barge-in: response.cancel + Twilio clear + epoch gate (ignore late deltas).
 *
 * SCC invariants:
 * - Borrower speaks first.
 * - Role lock at session level.
 * - VAD-driven turns (server_vad).
 * - No “helpful assistant” drift (hard prohibitions).
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

// ------------------------- Config -------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime-mini";
const OPENAI_URL = (model) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

// IMPORTANT: Your log proves this session expects ["audio","text"] and rejects ["audio"].
const OPENAI_MODALITIES = ["audio", "text"]; // <-- FIX

// Twilio strict μ-law framing
const FRAME_BYTES = 160;   // 20ms @ 8kHz PCMU
const SEND_TICK_MS = 20;

// Jitter buffer / underflow behavior
const PREBUFFER_FRAMES = parseInt(process.env.PREBUFFER_FRAMES || "4", 10); // 80ms default
const PREBUFFER_BYTES = FRAME_BYTES * Math.max(1, PREBUFFER_FRAMES);
const SEND_SILENCE_ON_UNDERFLOW = String(process.env.SEND_SILENCE_ON_UNDERFLOW || "true") === "true";
const ULAW_SILENCE_BYTE = 0xff;

// Queue limits
const MAX_OUT_QUEUE_BYTES = parseInt(process.env.MAX_OUT_QUEUE_BYTES || String(FRAME_BYTES * 250), 10); // ~5s
const MAX_INBOUND_BUFFER_BYTES = parseInt(process.env.MAX_INBOUND_BUFFER_BYTES || String(FRAME_BYTES * 50), 10); // ~1s

// VAD tuning (stable defaults; adjust only after audio is “frozen”)
const VAD_THRESHOLD = parseFloat(process.env.VAD_THRESHOLD || "0.55");
const VAD_PREFIX_MS = parseInt(process.env.VAD_PREFIX_MS || "240", 10);
const VAD_SILENCE_MS = parseInt(process.env.VAD_SILENCE_MS || "360", 10);
const VAD_IDLE_TIMEOUT_MS = parseInt(process.env.VAD_IDLE_TIMEOUT_MS || "15000", 10);

// Narrator
const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

// ------------------------- Scenarios -------------------------
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
      if (alt.id !== last) { pick = alt; break; }
    }
  }

  lastScenarioByKey.set(key, pick.id);
  return pick;
}

// ------------------------- Helpers -------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// robust behind proxies
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

// -------------------- Borrower style profiles --------------------
const STYLE_PROFILES = {
  calm:       { label: "calm", emotion: "calm", talkativeness: "medium", patience: "high",   trust: "medium", disfluency: "low",    thinkDelayMs: [140, 260] },
  anxious:    { label: "anxious", emotion: "anxious", talkativeness: "medium", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [180, 360] },
  distracted: { label: "distracted", emotion: "distracted", talkativeness: "low", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [200, 420] },
  irritated:  { label: "irritated", emotion: "irritated", talkativeness: "low", patience: "low", trust: "low", disfluency: "low", thinkDelayMs: [120, 220] },
  clueless:   { label: "clueless", emotion: "confused", talkativeness: "medium", patience: "medium", trust: "medium", disfluency: "medium", thinkDelayMs: [180, 340] }
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
  for (const it of items) { r -= it.weight; if (r <= 0) return it.value; }
  return items[items.length - 1].value;
}

function chooseStyleForCall({ callSid, scenario, difficulty }) {
  const rng = mulberry32(hashStringToUint32(String(callSid || "no-callsid")));
  const forced = normalizeMeta(scenario?.borrowerStyle);
  if (forced && STYLE_PROFILES[forced]) return { style: STYLE_PROFILES[forced], rng };

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

function buildHardBorrowerSessionInstructions(borrowerName, meta) {
  return `
ABSOLUTE ROLE LOCK — NON-NEGOTIABLE

You are a SIMULATED MORTGAGE BORROWER named ${borrowerName}.
The HUMAN CALLER is an ISA TRAINEE.

You are NOT an assistant. NOT the lender. NOT the ISA. NOT a loan officer. NOT an expert.

You MUST speak ONLY from the BORROWER perspective.

You MUST NEVER:
- give advice/recommendations
- explain mortgage concepts like a lender
- quote rates/APR/payments/terms/pricing
- discuss eligibility/underwriting/approval rules
- provide legal/tax/financial/medical guidance
- assume the caller is the borrower
- say "we" as the lender

If asked for advice/rates/medical/etc:
- respond with uncertainty as the borrower
- redirect back to borrower concerns
Example: "I'm not sure — I was hoping you could help me understand that."

Emotion: ${meta.emotion}. Talkativeness: ${meta.talkativeness}. Patience: ${meta.patience}. Trust: ${meta.trust}.
`.trim();
}

function pickBorrowerVoice(gender) {
  const g = String(gender || "").toLowerCase();
  if (g.includes("f")) return process.env.OPENAI_VOICE_FEMALE || "alloy";
  if (g.includes("m")) return process.env.OPENAI_VOICE_MALE || "marin";
  return process.env.OPENAI_VOICE_DEFAULT || "marin";
}

// ------------------------- Health -------------------------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) => res.status(200).send("scc-isa-voice v4.0 role+frame+jitter"));

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
      promptText: "Sharpe Command Center. I. S. A. training. Press 1 for M. 1. Press 2 for M. C. D.",
      invalidText: "Invalid choice. Press 1 for M. 1. Press 2 for M. C. D."
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

// Difficulty
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
  const mode = (req.query.mode || "").trim();
  const digit = (req.body.Digits || "").trim();

  const difficulty = digit === "1" ? "Standard" : digit === "2" ? "Moderate" : digit === "3" ? "Edge" : null;
  if (!difficulty || (mode !== "mcd" && mode !== "m1")) {
    const retry = absUrl(req, `/difficulty-prompt?mode=${encodeURIComponent(mode)}`);
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${retry}</Redirect>`));
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) return res.type("text/xml").status(200).send(twimlResponse(`${say("No scenarios available.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`));

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
// OpenAI Realtime connect + configure
// =========================================================
function sendSessionUpdate(openaiWs, { borrowerName, borrowerGender, meta }) {
  openaiWs.send(JSON.stringify({
    type: "session.update",
    session: {
      // FIX: set modalities to ["audio","text"] or this model rejects it
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

      instructions: buildHardBorrowerSessionInstructions(borrowerName, meta)
    }
  }));
}

function sendBorrowerFirst(openaiWs, borrowerName) {
  openaiWs.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: OPENAI_MODALITIES, // FIX
      instructions: `You are the borrower only. Say exactly: "Hello, this is ${borrowerName}." Then wait silently.`
    }
  }));
}

function openaiRealtimeConnect({ borrowerName, borrowerGender, meta }) {
  const apiKey = requireEnv("OPENAI_API_KEY");

  const ws = new WSClient(OPENAI_URL(REALTIME_MODEL), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    sendSessionUpdate(ws, { borrowerName, borrowerGender, meta });
    sendBorrowerFirst(ws, borrowerName);
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
  let openaiWs = null;

  // output buffer
  let outQueue = [];
  let outQueueBytes = 0;
  let sendTimer = null;
  let playbackStarted = false;

  // inbound buffer until openai opens
  let inboundAudioBuffer = [];
  let inboundAudioBytes = 0;

  // scheduling / barge-in
  let pendingResponseTimer = null;
  let awaitingModelResponse = false;

  // epoch gate: ignore late deltas after cancel
  let outputEpoch = 0;
  let acceptEpoch = 0;

  // stats
  let underflowTicks = 0;
  let sentFrames = 0;
  let receivedAudioBytes = 0;

  let borrowerName = "Steve";
  let borrowerGender = "";
  let borrowerMeta = null;

  function log(event, obj = {}) {
    console.log(JSON.stringify({ event, sid: callSid, streamSid, ...obj }));
  }

  function safeOpenAISend(obj) {
    if (!openaiWs || openaiWs.readyState !== 1) return false;
    try { openaiWs.send(JSON.stringify(obj)); return true; } catch { return false; }
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

  function twilioClear() {
    if (!streamSid) return;
    try { twilioWs.send(JSON.stringify({ event: "clear", streamSid })); } catch {}
  }

  function openaiCancelResponse() {
    if (!openaiWs || openaiWs.readyState !== 1) return;
    try { openaiWs.send(JSON.stringify({ type: "response.cancel" })); } catch {}
  }

  function capOutQueue() {
    while (outQueueBytes > MAX_OUT_QUEUE_BYTES && outQueue.length) {
      const dropped = outQueue.shift();
      outQueueBytes -= dropped.length;
    }
  }

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

  function startSendTimer() {
    if (sendTimer) return;

    sendTimer = setInterval(() => {
      if (!streamSid) return;

      // jitter buffer prime
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

      // underflow
      underflowTicks++;
      if (SEND_SILENCE_ON_UNDERFLOW) {
        sendFrameToTwilio(Buffer.alloc(FRAME_BYTES, ULAW_SILENCE_BYTE));
      }
    }, SEND_TICK_MS);
  }

  function stopSendTimer() {
    if (sendTimer) clearInterval(sendTimer);
    sendTimer = null;
  }

  function flushOutputQueue() {
    outQueue = [];
    outQueueBytes = 0;
  }

  function onUserBargeIn() {
    if (pendingResponseTimer) {
      clearTimeout(pendingResponseTimer);
      pendingResponseTimer = null;
    }

    openaiCancelResponse();
    twilioClear();
    flushOutputQueue();

    outputEpoch++;
    acceptEpoch = outputEpoch; // only accept future deltas after next response.create
    awaitingModelResponse = false;
    playbackStarted = false;

    log("BARGE_IN", { outputEpoch });
  }

  function scheduleBorrowerResponse() {
    if (!borrowerMeta) return;
    if (awaitingModelResponse) return;

    if (pendingResponseTimer) clearTimeout(pendingResponseTimer);
    pendingResponseTimer = null;

    const minMs = clampInt(parseInt(borrowerMeta.thinkDelayMin || "160", 10), 60, 1200);
    const maxMs = clampInt(parseInt(borrowerMeta.thinkDelayMax || "320", 10), minMs, 2000);

    // small natural delay; random per stop
    const rng = mulberry32(hashStringToUint32(String(callSid || "no-sid") + ":" + Date.now()));
    const delay = Math.floor(minMs + rng() * (maxMs - minMs));

    pendingResponseTimer = setTimeout(() => {
      pendingResponseTimer = null;
      awaitingModelResponse = true;

      // once we ask for a new response, start accepting output again for this epoch
      acceptEpoch = outputEpoch;

      safeOpenAISend({
        type: "response.create",
        response: {
          modalities: OPENAI_MODALITIES,
          instructions: "Respond as the borrower only. Stay in mortgage context. Do not advise. Keep it brief."
        }
      });

      log("OPENAI_RESPONSE_CREATE", { delayMs: delay, outputEpoch });
    }, delay);
  }

  function closeBoth() {
    try { twilioWs.close(); } catch {}
    try { openaiWs && openaiWs.close(); } catch {}
    stopSendTimer();
  }

  // ------------------ Twilio incoming ------------------
  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); } catch { return; }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;
      const cp = data.start?.customParameters || {};

      borrowerName = cp.borrowerName || "Steve";
      borrowerGender = cp.borrowerGender || "";

      borrowerMeta = {
        emotion: cp.emotion || "calm",
        talkativeness: cp.talkativeness || "medium",
        patience: cp.patience || "medium",
        trust: cp.trust || "medium",
        disfluency: cp.disfluency || "low",
        thinkDelayMin: cp.thinkDelayMin || "160",
        thinkDelayMax: cp.thinkDelayMax || "320"
      };

      log("TWILIO_STREAM_START", { customParameters: cp });

      try {
        openaiWs = openaiRealtimeConnect({ borrowerName, borrowerGender, meta: borrowerMeta });

        openaiWs.on("open", () => {
          log("OPENAI_WS_OPEN", { model: REALTIME_MODEL });
          log("OPENAI_SESSION_CONFIGURED");
          startSendTimer();
          flushInboundAudio();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw.toString("utf8")); } catch { return; }

          // Barge-in via VAD
          if (evt.type === "input_audio_buffer.speech_started") return onUserBargeIn();
          if (evt.type === "input_audio_buffer.speech_stopped") return scheduleBorrowerResponse();

          // Handle OpenAI errors (including modalities)
          if (evt.type === "error") {
            log("OPENAI_EVT_ERROR", { detail: evt.error || evt });

            // FAILSAFE: if modalities error appears again, re-send session.update with ["audio","text"]
            const msg = String(evt?.error?.message || "");
            const param = String(evt?.error?.param || "");
            if (msg.includes("Invalid modalities") || param.includes("modalities")) {
              log("OPENAI_MODALITIES_RETRY");
              try {
                sendSessionUpdate(openaiWs, { borrowerName, borrowerGender, meta: borrowerMeta });
                sendBorrowerFirst(openaiWs, borrowerName);
              } catch {}
            }
            return;
          }

          // Audio deltas
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            null;

          if (delta) {
            // ignore late deltas after cancel/clear
            if (acceptEpoch !== outputEpoch) return;

            awaitingModelResponse = false;

            const buf = Buffer.from(delta, "base64");
            receivedAudioBytes += buf.length;

            outQueue.push(buf);
            outQueueBytes += buf.length;
            capOutQueue();
            return;
          }
        });

        openaiWs.on("close", () => {
          log("OPENAI_WS_CLOSE", { underflowTicks, sentFrames, receivedAudioBytes });
          closeBoth();
        });

        openaiWs.on("error", (err) => {
          log("OPENAI_WS_ERROR", { error: String(err?.message || err) });
          closeBoth();
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

      if (!openaiWs || openaiWs.readyState !== 1) {
        bufferInboundAudio(payload);
        return;
      }

      safeOpenAISend({ type: "input_audio_buffer.append", audio: payload });
      return;
    }

    if (data.event === "stop") {
      log("TWILIO_STREAM_STOP", { underflowTicks, sentFrames, receivedAudioBytes });
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

// ------------------------- Boot -------------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
