/* SCC ISA Training Voice System (Governance-First)
 * v1.4 — SCC flow + AI Borrower (Twilio Stream + OpenAI Realtime)
 *
 * KEY POINTS:
 * - Narrator uses Twilio <Say> with Polly (no SSML to avoid Twilio app errors).
 * - SCC is spelled via punctuation: "S. C. C.", "I. S. A.", "M. 1.", "M. C. D."
 * - AI borrower is OpenAI Realtime over WebSocket bridged to Twilio Media Streams.
 * - Adds <Pause> after <Connect><Stream> to prevent immediate hangup if stream closes.
 *
 * REQUIRED ENV VARS (Render):
 * - OPENAI_API_KEY
 *
 * OPTIONAL ENV VARS:
 * - REALTIME_MODEL (default: gpt-realtime)
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

// ---------- Load scenarios.json (authoritative) ----------
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = null;

function loadScenarios() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  SCENARIOS = JSON.parse(raw);
  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));
}
loadScenarios();

// ---------- Anti-repeat per (mode+difficulty) ----------
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

// ---------- Helpers ----------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Twilio-supported narrator voice (NO SSML)
function twimlSay(text) {
  return `<Say voice="Polly.Joanna">${xmlEscape(text)}</Say>`;
}

function absUrl(req, p) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

function twimlResponse(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function safeTwimlFail(message) {
  return twimlResponse(`${twimlSay(message)}`);
}

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v1.4 AI borrower + keepalive pause + prod realtime model")
);

// =========================================================
//  SCC Call Flow (Menu -> Gate -> Difficulty -> Scenario -> Connect Stream)
// =========================================================

// Support both POST (Twilio) and GET (human test)
app.all("/voice", (req, res) => {
  try {
    const sid = req.body?.CallSid || req.query?.CallSid || null;
    console.log(JSON.stringify({ event: "CALL_START", sid }));

    const menuAction = absUrl(req, "/menu");

    const inner = `
      <Gather input="dtmf" numDigits="1" action="${menuAction}" method="POST" timeout="8">
        ${twimlSay("Welcome to S. C. C. I. S. A. training. Press 1 for M. 1. scenario. Press 2 for M. C. D. scenario.")}
      </Gather>
      ${twimlSay("Invalid choice. Press 1 for M. 1. Press 2 for M. C. D.")}
      <Redirect method="POST">${menuAction}</Redirect>
    `;

    res.type("text/xml").status(200).send(twimlResponse(inner));
  } catch (err) {
    console.log(JSON.stringify({ event: "VOICE_FATAL", error: String(err?.message || err) }));
    res.type("text/xml").status(200).send(safeTwimlFail("System error. Please hang up and try again."));
  }
});

app.post("/menu", (req, res) => {
  try {
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
      twimlResponse(`${twimlSay("Invalid selection. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`)
    );
  } catch (err) {
    console.log(JSON.stringify({ event: "MENU_FATAL", error: String(err?.message || err) }));
    return res.type("text/xml").status(200).send(safeTwimlFail("System error. Please hang up and try again."));
  }
});

// ---------- Gates ----------
app.post("/mcd-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const action = absUrl(req, "/mcd-gate");

  const inner = `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
      ${twimlSay("M. C. D. gate. Press 9 to confirm and proceed.")}
    </Gather>
    ${twimlSay("Gate not passed. Press 9 to proceed.")}
    <Redirect method="POST">${action}</Redirect>
  `;
  res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/mcd-gate", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const pass = digit === "9";
  console.log(JSON.stringify({ event: "MCD_GATE", sid, pass }));

  if (!pass) {
    const back = absUrl(req, "/mcd-gate-prompt");
    return res.type("text/xml").status(200).send(twimlResponse(`${twimlSay("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`));
  }

  const diffPrompt = absUrl(req, "/difficulty-prompt?mode=mcd");
  return res.type("text/xml").status(200).send(twimlResponse(`<Redirect method="POST">${diffPrompt}</Redirect>`));
});

app.post("/m1-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));

  const action = absUrl(req, "/m1-gate");

  const inner = `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
      ${twimlSay("M. 1. gate. Press 8 to confirm and proceed.")}
    </Gather>
    ${twimlSay("Gate not passed. Press 8 to proceed.")}
    <Redirect method="POST">${action}</Redirect>
  `;
  res.type("text/xml").status(200).send(twimlResponse(inner));
});

app.post("/m1-gate", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const pass = digit === "8";
  console.log(JSON.stringify({ event: "M1_GATE", sid, pass }));

  if (!pass) {
    const back = absUrl(req, "/m1-gate-prompt");
    return res.type("text/xml").status(200).send(twimlResponse(`${twimlSay("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`));
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

  const inner = `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
      ${twimlSay("Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.")}
    </Gather>
    ${twimlSay("Invalid selection. Press 1 for Standard, 2 for Moderate, or 3 for Edge.")}
    <Redirect method="POST">${action}</Redirect>
  `;

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
    return res.type("text/xml").status(200).send(twimlResponse(`${twimlSay("Invalid selection.")}<Redirect method="POST">${retry}</Redirect>`));
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").status(200).send(twimlResponse(`${twimlSay("No scenarios available. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`));
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

  // IMPORTANT: Keepalive pause after Connect so call doesn't instantly die if stream closes.
  const inner = `
    ${twimlSay(`Scenario. ${safeSummary}`)}
    ${twimlSay(`Primary objective. ${safeObjective}`)}
    ${twimlSay("You are now connected. The borrower will answer first.")}

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
    ${twimlSay("Session ended. Returning to main menu.")}
    <Redirect method="POST">${absUrl(req, "/voice")}</Redirect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
//  WebSocket Bridge: Twilio Media Streams <-> OpenAI Realtime
// =========================================================

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

function openaiRealtimeConnect({ borrowerName, mode, difficulty, scenarioId, objective }) {
  const apiKey = requireEnv("OPENAI_API_KEY");

  // Default to production realtime model (more stable than preview).
  // You can override via REALTIME_MODEL in Render.
  const model = process.env.REALTIME_MODEL || "gpt-realtime";

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const ws = new WSClient(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    const instructions =
      `You are a real mortgage borrower named ${borrowerName}. ` +
      `You do NOT volunteer your mortgage intent unless the ISA explicitly asks. ` +
      `You speak naturally, with mild hesitation. ` +
      `Do not coach. Do not mention scripts or governance. ` +
      `Context: mode=${mode}, difficulty=${difficulty}, scenarioId=${scenarioId}. ` +
      `Scenario objective: ${objective}`;

    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions
      }
    }));

    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Start the call with: "Hello, this is ${borrowerName}." Then wait silently.`
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
  let startedAt = Date.now();
  let openaiOpenLogged = false;

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
          openaiOpenLogged = true;
          log("OPENAI_WS_OPEN", { model: process.env.REALTIME_MODEL || "gpt-realtime" });
          log("OPENAI_SESSION_CONFIGURED");
        });

        openaiWs.on("error", (err) => {
          log("OPENAI_WS_ERROR", { error: String(err?.message || err) });
          closeBoth();
        });

        openaiWs.on("close", () => {
          log("OPENAI_WS_CLOSE", { msAlive: Date.now() - startedAt });
          closeBoth();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw.toString("utf8")); } catch { return; }

          // Forward audio deltas (handle a few common variants)
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "audio.delta" && evt.delta) ? evt.delta :
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

          // Log errors the model sends
          if (evt.type === "error") {
            log("OPENAI_EVT_ERROR", { detail: evt.error || evt });
            return;
          }

          // If we never get audio and we're dying fast, this helps diagnose.
          if (!openaiOpenLogged && evt.type) {
            log("OPENAI_EVT_BEFORE_OPEN", { type: evt.type });
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
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      } catch {}
      return;
    }

    if (data.event === "stop") {
      log("TWILIO_STREAM_STOP", { msAlive: Date.now() - startedAt });
      closeBoth();
      return;
    }
  });

  twilioWs.on("close", () => {
    log("TWILIO_WS_CLOSE", { msAlive: Date.now() - startedAt });
    try { openaiWs && openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (err) => {
    log("TWILIO_WS_ERROR", { error: String(err?.message || err) });
    try { openaiWs && openaiWs.close(); } catch {}
  });
});

// ---------- Boot ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
