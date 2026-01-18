/* SCC ISA Training Voice System (Governance-First)
 * v2.0 — "Holy shit" audio realism upgrade:
 * - True barge-in: OpenAI response.cancel + Twilio clear
 * - Micro-jitter buffer: batch µ-law bytes to reduce choppy/robot gaps
 * - Human response timing: VAD speech_stopped -> response.create after small style-based delay
 * - Deterministic borrower style profiles (per CallSid) + optional scenario metadata
 *
 * NARRATOR:
 * - Twilio <Say> uses Google Chirp3-HD-Aoede (high quality).
 * - No SSML (keeps TwiML robust); acronyms spelled with punctuation.
 *
 * BORROWER:
 * - OpenAI Realtime over WebSocket.
 * - g711_ulaw end-to-end.
 * - Uses VAD events (speech_started/speech_stopped) to drive response timing.
 *
 * REQUIRED ENV:
 * - OPENAI_API_KEY
 *
 * OPTIONAL ENV:
 * - REALTIME_MODEL (default: gpt-realtime-mini)
 * - OPENAI_NOISE_REDUCTION (near_field | far_field)  // optional, can help VAD; may add latency
 *
 * References:
 * - OpenAI VAD tuning parameters (threshold, prefix_padding_ms, silence_duration_ms, interrupt_response, create_response, idle_timeout_ms). :contentReference[oaicite:5]{index=5}
 * - OpenAI response.cancel event. :contentReference[oaicite:6]{index=6}
 * - Twilio Media Streams clear event. :contentReference[oaicite:7]{index=7}
 * - OpenAI speech_started/speech_stopped events. :contentReference[oaicite:8]{index=8}
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
  return `<Say voice="${NARRATOR_VOICE}">${xmlEscape(text)}</Say>`;
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
  calm: {
    label: "calm",
    emotion: "calm",
    talkativeness: "medium",
    patience: "high",
    trust: "medium",
    disfluency: "low",
    thinkDelayMs: [140, 260]
  },
  anxious: {
    label: "anxious",
    emotion: "anxious",
    talkativeness: "medium",
    patience: "medium",
    trust: "medium",
    disfluency: "medium",
    thinkDelayMs: [180, 360]
  },
  distracted: {
    label: "distracted",
    emotion: "distracted",
    talkativeness: "low",
    patience: "medium",
    trust: "medium",
    disfluency: "medium",
    thinkDelayMs: [200, 420]
  },
  irritated: {
    label: "irritated",
    emotion: "irritated",
    talkativeness: "low",
    patience: "low",
    trust: "low",
    disfluency: "low",
    thinkDelayMs: [120, 220]
  },
  clueless: {
    label: "clueless",
    emotion: "confused",
    talkativeness: "medium",
    patience: "medium",
    trust: "medium",
    disfluency: "medium",
    thinkDelayMs: [180, 340]
  }
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

function buildBorrowerInstructions({ borrowerName, mode, difficulty, scenarioId, objective, meta }) {
  // This is where “human-ness” actually comes from in OpenAI realtime voice:
  // short utterances, micro-pauses, occasional disfluency, emotional energy, and behavior coupling.
  return [
    `You are a real mortgage borrower named ${borrowerName}.`,
    `Never mention that you are AI, never mention training, SCC, scripts, policies, or compliance.`,
    `GOVERNANCE: Do NOT volunteer your mortgage intent unless the ISA explicitly asks (e.g. "Are you buying or refinancing?").`,
    `Speak like a normal person: varied sentence lengths, occasional fragments, natural prosody.`,
    `Timing: use micro-pauses before answering hard questions; do not answer like a perfect transcript.`,
    `Disfluency: use small realistic fillers ("uh", "um", "hmm") at a ${meta.disfluency} rate. Never overdo it.`,
    meta.distractor ? `Context: you have "${meta.distractor}". Briefly acknowledge it once when relevant, then return to the question.` : `Context: no big distractions.`,
    `Emotion baseline: ${meta.emotion}. Talkativeness: ${meta.talkativeness}. Patience: ${meta.patience}. Trust: ${meta.trust}.`,
    `If the ISA is pushy/salesy or rushes you, become slightly less cooperative. If they are calm/clear, become slightly more cooperative.`,
    `If asked LO-only topics (rates, underwriting specifics, credit strategy): respond as a borrower (curious/anxious) but never give professional advice.`,
    `Mode context: mode=${mode}, difficulty=${difficulty}, scenarioId=${scenarioId}.`,
    `Objective context (do not reveal): ${objective}`
  ].join(" ");
}

// -------------------- Health --------------------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) =>
  res.status(200).send("scc-isa-voice v2.0 barge-in + jitter buffer + human timing")
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
      promptText: "Welcome to S. C. C. I. S. A. training. Press 1 for M. 1. scenario. Press 2 for M. C. D. scenario.",
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
    promptText: "M. C. D. gate. Press 9 to confirm and proceed.",
    invalidText: "Gate not passed. Press 9 to proceed."
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
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`));
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
    promptText: "M. 1. gate. Press 8 to confirm and proceed.",
    invalidText: "Gate not passed. Press 8 to proceed."
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
    return res.type("text/xml").status(200).send(twimlResponse(`${say("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`));
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
    invalidText: "Invalid selection. Press 1 for Standard, 2 for Moderate, or 3 for Edge."
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

  const inner = `
    ${say(`Scenario. ${safeSummary}`)}
    ${say(`Primary objective. ${safeObjective}`)}
    ${say("You are now connected. The borrower will answer first.")}

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

    <Pause length="600"/>
    ${say("Session ended. Returning to main menu.")}
    <Redirect method="POST">${absUrl(req, "/voice")}</Redirect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
// WebSocket Bridge: Twilio Media Streams <-> OpenAI Realtime
// =========================================================

// --- µ-law batching to reduce choppy/robot gaps ---
// 8kHz mulaw: 20ms frame = 160 bytes; 40ms frame = 320 bytes.
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
    const instructions = buildBorrowerInstructions({
      borrowerName,
      mode,
      difficulty,
      scenarioId,
      objective,
      meta
    });

    const noiseReductionMode = normalizeMeta(process.env.OPENAI_NOISE_REDUCTION);
    const inputAudioNoiseReduction =
      noiseReductionMode === "near_field" || noiseReductionMode === "far_field"
        ? { type: noiseReductionMode }
        : null;

    // VAD is enabled. We DO NOT set create_response=true here.
    // We want human timing: we’ll trigger response.create ourselves after speech_stopped. :contentReference[oaicite:9]{index=9}
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // Noise reduction is supported and can help VAD accuracy, but can add latency depending on combos. :contentReference[oaicite:10]{index=10}
        input_audio_noise_reduction: inputAudioNoiseReduction,
        turn_detection: {
          type: "server_vad",
          threshold: 0.55,
          prefix_padding_ms: 240,
          silence_duration_ms: 360,
          // manual response timing:
          create_response: false,
          // still allow the server to interrupt its own output when it detects speech
          interrupt_response: true,
          idle_timeout_ms: 15000
        },
        instructions
      }
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Borrower speaks first immediately
    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Start the call with: "Hello, this is ${borrowerName}." Then wait.`
      }
    }));
  });

  return ws;
}

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
  let outQueue = []; // array<Buffer>
  let outQueueBytes = 0;
  let sendTimer = null;

  // Track whether model is currently speaking (rough approximation)
  let modelSpeaking = false;

  // Track a pending response.create timer (human think delay)
  let pendingResponseTimer = null;

  function log(event, obj = {}) {
    console.log(JSON.stringify({ event, sid: callSid, streamSid, ...obj }));
  }

  function twilioClear() {
    if (!streamSid) return;
    try {
      // Twilio Media Streams supports "clear" to empty buffered audio playback. :contentReference[oaicite:11]{index=11}
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    } catch {}
  }

  function openaiCancelResponse() {
    if (!openaiWs || openaiWs.readyState !== 1) return;
    try {
      // response.cancel exists to cancel in-progress response generation. :contentReference[oaicite:12]{index=12}
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

      // Build one frame
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
    // Cancel any existing scheduled response
    if (pendingResponseTimer) clearTimeout(pendingResponseTimer);
    pendingResponseTimer = null;

    const minMs = clampInt(parseInt(meta.thinkDelayMin || "160", 10), 60, 1200);
    const maxMs = clampInt(parseInt(meta.thinkDelayMax || "320", 10), minMs, 2000);

    // Deterministic-ish: use callSid hash + time
    const rng = mulberry32(hashStringToUint32(String(callSid || "no-sid") + ":" + Date.now()));
    const delay = Math.floor(minMs + rng() * (maxMs - minMs));

    pendingResponseTimer = setTimeout(() => {
      pendingResponseTimer = null;
      if (!openaiWs || openaiWs.readyState !== 1) return;

      try {
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            // Keep it short and human. The global instructions enforce realism.
            instructions: "Respond naturally and briefly. Do not monologue."
          }
        }));
        log("OPENAI_RESPONSE_CREATE_SENT", { delayMs: delay });
      } catch {}
    }, delay);
  }

  function onUserBargeIn() {
    // User started speaking while model might be speaking:
    // - cancel OpenAI generation
    // - clear Twilio playback buffer
    // - clear our local output queue
    if (pendingResponseTimer) {
      clearTimeout(pendingResponseTimer);
      pendingResponseTimer = null;
    }
    openaiCancelResponse();
    twilioClear();
    flushOutputQueue();
    modelSpeaking = false;
    log("BARGE_IN");
  }

  function closeBoth() {
    try { twilioWs.close(); } catch {}
    try { openaiWs && openaiWs.close(); } catch {}
    stopSendTimer();
  }

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); } catch { return; }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;
      const cp = data.start?.customParameters || {};

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
          borrowerName: cp.borrowerName || "Mike",
          mode: cp.mode || "mcd",
          difficulty: cp.difficulty || "Standard",
          scenarioId: cp.scenarioId || "UNKNOWN",
          objective: cp.objective || "",
          meta
        });

        openaiWs.on("open", () => {
          log("OPENAI_WS_OPEN", { model: process.env.REALTIME_MODEL || "gpt-realtime-mini", meta });
          log("OPENAI_SESSION_CONFIGURED");
          startSendTimer();
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

          // Turn events:
          // speech_started/speech_stopped are emitted when VAD detects user speech boundaries. :contentReference[oaicite:13]{index=13}
          if (evt.type === "input_audio_buffer.speech_started") {
            // Treat as barge-in on the model
            onUserBargeIn();
            return;
          }

          if (evt.type === "input_audio_buffer.speech_stopped") {
            // User finished a turn -> schedule a response with human think delay
            scheduleBorrowerResponse(meta);
            return;
          }

          // Audio deltas: forward but batch to reduce choppiness
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            null;

          if (delta) {
            modelSpeaking = true;
            const buf = Buffer.from(delta, "base64");
            outQueue.push(buf);
            outQueueBytes += buf.length;
            return;
          }

          // Response lifecycle - used only for logging
          if (evt.type === "response.done" || evt.type === "response.completed") {
            modelSpeaking = false;
            return;
          }

          // Errors (log them)
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
      // Twilio inbound audio -> OpenAI input audio buffer
      if (!openaiWs || openaiWs.readyState !== 1) return;

      const payload = data.media?.payload; // base64 g711_ulaw
      if (!payload) return;

      try {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload
        }));
      } catch {}
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

// -------------------- Boot --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
