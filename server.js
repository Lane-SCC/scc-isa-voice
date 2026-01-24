// =========================================================
// BOOT-SAFETY HELPERS (must exist before boot() runs)
// =========================================================

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`${name} is not defined`);
  return v;
}

// If you already have real scenario/operator loaders elsewhere,
// KEEP those and delete these stubs. These stubs are only to stop boot crashes.
function loadScenariosOrThrow() {
  return true;
}

function loadOperators() {
  return true;
}

// Global call-state store used by shutdown flush + scoring
const CALL_STATE = new Map();

// Twilio env var config (use process.env)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// Server bind defaults
const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "3000", 10);

// OpenAI realtime config defaults
const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL || "wss://api.openai.com/v1/realtime";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

// Paths / logging defaults
const SCENARIOS_PATH = process.env.SCENARIOS_PATH || "./scenarios.json";
const LOG_DIR = process.env.LOG_DIR || "./logs";
// ---------------- Stub: finalizeAuditRecord ----------------
// TODO: Replace with actual implementation or import
function finalizeAuditRecord(state, extra) {
  // Placeholder: should be replaced with real logic
  return true;
}
// ---------------- Helper: clampInt ----------------
function clampInt(val, def, min, max) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
// ---------------- Express app initialization ----------------
const express = require("express");
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.get("/version", (req, res) => {
  res.status(200).json({
    name: "scc-isa-voice",
    status: "ok",
    uptimeSec: Math.floor(process.uptime()),
    realtimeModel: REALTIME_MODEL,
    transcribeModel: TRANSCRIBE_MODEL,
  });
});
function streamUrlForReq(req) {
  const httpUrl = absUrl(req, "/twilio");
  return httpUrl.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

function voiceParamsFromReq(req) {
  const qp = (key, def = "") => (req.body && req.body[key]) || (req.query && req.query[key]) || def;
  return {
    callSid: qp("CallSid", ""),
    from: qp("From", ""),
    operatorPin: qp("operatorPin", qp("pin", "")),
    mode: qp("mode", "mcd"),
    difficulty: qp("difficulty", "Standard"),
    scenarioId: qp("scenarioId", ""),
    borrowerName: qp("borrowerName", ""),
    borrowerGender: qp("borrowerGender", ""),
    examMode: qp("examMode", "false"),
  };
}

function streamTwiml(req) {
  const params = voiceParamsFromReq(req);
  const streamUrl = streamUrlForReq(req);
  const p = (name, value) => `<Parameter name="${xmlEscape(name)}" value="${xmlEscape(String(value || ""))}"/>`;
  const inner = [
    `<Connect>`,
    `<Stream url="${xmlEscape(streamUrl)}">`,
    p("callSid", params.callSid),
    p("from", params.from),
    p("operatorPin", params.operatorPin),
    p("mode", params.mode),
    p("difficulty", params.difficulty),
    p("scenarioId", params.scenarioId),
    p("borrowerName", params.borrowerName),
    p("borrowerGender", params.borrowerGender),
    p("examMode", params.examMode),
    `</Stream>`,
    `</Connect>`,
  ].join("");
  return twimlResponse(inner);
}

app.post("/voice", (req, res) => {
  return res.type("text/xml").status(200).send(streamTwiml(req));
});

app.post("/connect-prompt", (req, res) => {
  return res.type("text/xml").status(200).send(streamTwiml(req));
});
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
    `IMPORTANT: When referring to the ISA, always say each letter: "I. S. A." (not "ISA" as a word).`,
    `If you see 'ISA' in any prompt or instruction, you must say "I. S. A." as three separate letters.`,
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

    console.log(JSON.stringify({ event: "OPENAI_WS_OPEN", sid: state.callSid, voiceSelected: voice, model: REALTIME_MODEL }));

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

    console.log(JSON.stringify({ event: "OPENAI_SESSION_UPDATE_SENT", sid: state.callSid }));
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

// Ensure WebSocketServer and server are defined before wss is used
const http = require("http");
const { WebSocketServer } = require("ws");
app.use(express.static("public"));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio" });

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

// ---------------- finalizeAuditRecord: wrap safely ----------------
const _finalizeAuditRecord = finalizeAuditRecord; // capture current implementation (stub or real)

function finalizeAuditRecordWrapped(state, extra = {}) {
  if (!state) return false;

  try {
    if (!state.operator?.lastScore) computeScorecard(state);
  } catch {}

  const tv = technicalValidity(state);

  // If exam evidence is technically invalid, do not allow a PASS
  try {
    if (state.examMode && tv.valid === false && state.operator?.lastScore?.pass) {
      state.operator.lastScore.pass = false;
      state.operator.lastScore.failReasons = Array.isArray(state.operator.lastScore.failReasons)
        ? state.operator.lastScore.failReasons
        : [];
      state.operator.lastScore.failReasons.unshift("Technical invalidation: evidence insufficient");
      state.operator.lastScoreSpoken = spokenScorecard(state.operator.lastScore);
    }
  } catch {}

  // Optional: alert admins on exam fail (guarded)
  try {
    if (state.examMode && state.operator?.lastScore && state.operator.lastScore.pass === false) {
      setImmediate(() =>
        alertAdmins("EXAM_FAIL", {
          short: `Exam failed: ${state.callSid || state.scenarioId || ""}`,
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
  } catch {}

  // Call original implementation (stub or real)
  try {
    return _finalizeAuditRecord(state, { ...extra, technicalValidity: tv });
  } catch (e) {
    console.log(JSON.stringify({ event: "FINALIZE_AUDIT_ERROR", error: String(e?.message || e) }));
    return false;
  }
}

// IMPORTANT: do NOT reassign function declarations in strict/module contexts.
// Instead, route all callers to the wrapped function:
finalizeAuditRecord = finalizeAuditRecordWrapped;

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
