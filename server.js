/* SCC ISA Training Voice System (Governance-First)
 * v1.6 — Smoother realtime conversation (VAD create_response + interrupt_response)
 *
 * WHAT THIS FIXES:
 * - “Klunky” turn-taking: long pauses, talking over each other, delayed responses
 * - Enables Realtime VAD auto-response + barge-in:
 *   turn_detection.create_response = true
 *   turn_detection.interrupt_response = true
 *   and tightens silence_duration_ms to reduce dead air.
 *
 * NARRATOR:
 * - Best Twilio <Say> voice: Google Chirp3-HD-Aoede
 * - No SSML (Twilio TTS can be picky); we spell with punctuation: "I. S. A."
 *
 * REQUIRED ENV VARS:
 * - OPENAI_API_KEY
 * OPTIONAL:
 * - REALTIME_MODEL (default: gpt-realtime-mini)
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

// Best narrator voice
const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

// Narrator <Say>
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

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

// -------------------- Health --------------------
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) =>
  res.status(200).send("scc-isa-voice v1.6 smoother VAD auto-response + barge-in")
);

// =========================================================
// SCC Call Flow (Menu -> Gate -> Difficulty -> Scenario -> Connect Stream)
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
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`)
    );
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
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`)
    );
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
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("Invalid selection.")}<Redirect method="POST">${retry}</Redirect>`)
    );
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").status(200).send(
      twimlResponse(`${say("No scenarios available. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`)
    );
  }

  console.log(JSON.stringify({
    event: "SCENARIO_LOADED",
    sid,
    mode,
    difficulty,
    scenarioId: scenario.id,
    borrowerName: scenario.borrowerName,
    borrowerGender: scenario.borrowerGender
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

function openaiRealtimeConnect({ borrowerName, mode, difficulty, scenarioId, objective }) {
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
    // VAD tuning: faster turn detection + auto responses + barge-in.
    // OpenAI docs show create_response + interrupt_response for conversation smoothness. :contentReference[oaicite:2]{index=2}
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.55,
          prefix_padding_ms: 200,
          silence_duration_ms: 350,
          create_response: true,
          interrupt_response: true
        },
        instructions:
          `You are a real mortgage borrower named ${borrowerName}. ` +
          `You do NOT volunteer your mortgage intent unless the ISA explicitly asks. ` +
          `You speak naturally and concisely. ` +
          `Do not coach. Do not mention scripts or governance. ` +
          `Context: mode=${mode}, difficulty=${difficulty}, scenarioId=${scenarioId}. ` +
          `Scenario objective: ${objective}`
      }
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Force borrower to speak first once.
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

// HTTP server + WS upgrade
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

  function log(event, obj = {}) {
    console.log(JSON.stringify({ event, sid: callSid, streamSid, ...obj }));
  }

  function closeBoth() {
    try { twilioWs.close(); } catch {}
    try { openaiWs && openaiWs.close(); } catch {}
  }

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString("utf8")); } catch { return; }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;
      const cp = data.start?.customParameters || {};

      log("TWILIO_STREAM_START", { customParameters: cp });

      try {
        openaiWs = openaiRealtimeConnect({
          borrowerName: cp.borrowerName || "Mike",
          mode: cp.mode || "mcd",
          difficulty: cp.difficulty || "Standard",
          scenarioId: cp.scenarioId || "UNKNOWN",
          objective: cp.objective || ""
        });

        openaiWs.on("open", () => {
          log("OPENAI_WS_OPEN", { model: process.env.REALTIME_MODEL || "gpt-realtime-mini" });
          log("OPENAI_SESSION_CONFIGURED");
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

          // Forward audio deltas (cover common variants)
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            null;

          if (delta) {
            try {
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: delta }
              }));
            } catch {}
            return;
          }

          // Log server errors (helps diagnose rare glitches)
          if (evt.type === "error") {
            log("OPENAI_EVT_ERROR", { detail: evt.error || evt });
          }
        });

      } catch (err) {
        log("OPENAI_INIT_FAILED", { error: String(err?.message || err) });
        closeBoth();
      }

      return;
    }

    if (data.event === "media") {
      if (!openaiWs || openaiWs.readyState !== 1) return;
      const payload = data.media?.payload;
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
  });

  twilioWs.on("error", (err) => {
    log("TWILIO_WS_ERROR", { error: String(err?.message || err) });
    try { openaiWs && openaiWs.close(); } catch {}
  });
});

// -------------------- Boot --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
