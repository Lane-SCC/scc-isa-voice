/* SCC ISA Training Voice System (Governance-First)
 * v1.2 — SCC flow + AI Borrower (Twilio Media Streams + OpenAI Realtime)
 *
 * HARD INTENT:
 * - Twilio <Say> = Narrator only (Polly + SSML spelling control)
 * - AI Borrower audio = OpenAI Realtime streamed through Twilio Media Streams
 * - Scenarios are loaded from scenarios.json (authoritative)
 *
 * ENV VARS REQUIRED:
 * - OPENAI_API_KEY (required)
 * OPTIONAL:
 * - REALTIME_MODEL (default: gpt-4o-realtime-preview)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const WSClient = require("ws");

const app = express();

// Twilio sends x-www-form-urlencoded
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

// ---------- In-memory anti-repeat per (mode+difficulty) ----------
const lastScenarioByKey = new Map(); // key: `${mode}:${difficulty}` => scenarioId

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

// Narrator says SSML you control (do NOT pass raw user content here)
function twimlSaySSML(ssml) {
  return `<Say voice="Polly.Joanna"><speak>${ssml}</speak></Say>`;
}

// Narrator says plain text safely (escape + wrap in SSML)
function twimlSayText(text) {
  return `<Say voice="Polly.Joanna"><speak>${xmlEscape(text)}</speak></Say>`;
}

function absUrl(req, p) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

function gatherOneDigit({ action, promptSSML, invalidSSML }) {
  // action MUST be absolute URL to avoid Twilio dropping
  return `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
      ${twimlSaySSML(promptSSML)}
    </Gather>
    ${twimlSaySSML(invalidSSML)}
    <Redirect method="POST">${action}</Redirect>
  `;
}

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v1.2 SCC flow + AI borrower (Twilio Stream + OpenAI Realtime)")
);

// =========================================================
//  Twilio Voice: SCC Flow (Menu -> Gate -> Difficulty -> Scenario -> Connect Stream)
// =========================================================

app.post("/voice", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "CALL_START", sid }));

  const menuAction = absUrl(req, "/menu");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${gatherOneDigit({
    action: menuAction,
    promptSSML:
      'Welcome to <say-as interpret-as="characters">SCC</say-as> ' +
      '<say-as interpret-as="characters">ISA</say-as> training. ' +
      'Press 1 for <say-as interpret-as="characters">M1</say-as> scenario. ' +
      'Press 2 for <say-as interpret-as="characters">MCD</say-as> scenario.',
    invalidSSML:
      'Invalid choice. Press 1 for <say-as interpret-as="characters">M1</say-as>. ' +
      'Press 2 for <say-as interpret-as="characters">MCD</say-as>.'
  })}
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  if (digit === "1") {
    const gatePrompt = absUrl(req, "/m1-gate-prompt");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response><Redirect method="POST">${gatePrompt}</Redirect></Response>`);
  }

  if (digit === "2") {
    const gatePrompt = absUrl(req, "/mcd-gate-prompt");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response><Redirect method="POST">${gatePrompt}</Redirect></Response>`);
  }

  const back = absUrl(req, "/voice");
  return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  ${twimlSaySSML('Invalid selection. Returning to main menu.')}
  <Redirect method="POST">${back}</Redirect>
</Response>`);
});

// ---------- Gate Prompts + Gate Handlers ----------
app.post("/mcd-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const action = absUrl(req, "/mcd-gate");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${gatherOneDigit({
    action,
    promptSSML: '<say-as interpret-as="characters">MCD</say-as> gate. Press 9 to confirm and proceed.',
    invalidSSML: 'Gate not passed. Press 9 to proceed.'
  })}
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/mcd-gate", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const pass = digit === "9";
  console.log(JSON.stringify({ event: "MCD_GATE", sid, pass }));

  if (!pass) {
    const back = absUrl(req, "/mcd-gate-prompt");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  ${twimlSaySSML('Gate not passed.')}
  <Redirect method="POST">${back}</Redirect>
</Response>`);
  }

  const diffPrompt = absUrl(req, "/difficulty-prompt?mode=mcd");
  return res.type("text/xml").send(`<?xml version="1.0"?>
<Response><Redirect method="POST">${diffPrompt}</Redirect></Response>`);
});

app.post("/m1-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));

  const action = absUrl(req, "/m1-gate");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${gatherOneDigit({
    action,
    promptSSML: '<say-as interpret-as="characters">M1</say-as> gate. Press 8 to confirm and proceed.',
    invalidSSML: 'Gate not passed. Press 8 to proceed.'
  })}
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/m1-gate", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  const pass = digit === "8";
  console.log(JSON.stringify({ event: "M1_GATE", sid, pass }));

  if (!pass) {
    const back = absUrl(req, "/m1-gate-prompt");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  ${twimlSaySSML('Gate not passed.')}
  <Redirect method="POST">${back}</Redirect>
</Response>`);
  }

  const diffPrompt = absUrl(req, "/difficulty-prompt?mode=m1");
  return res.type("text/xml").send(`<?xml version="1.0"?>
<Response><Redirect method="POST">${diffPrompt}</Redirect></Response>`);
});

// ---------- Difficulty ----------
app.post("/difficulty-prompt", (req, res) => {
  const sid = req.body.CallSid;
  const mode = (req.query.mode || "").trim();
  console.log(JSON.stringify({ event: "DIFFICULTY_PROMPT", sid, mode }));

  const action = absUrl(req, `/difficulty?mode=${encodeURIComponent(mode)}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${gatherOneDigit({
    action,
    promptSSML:
      'Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.',
    invalidSSML:
      'Invalid selection. Press 1 for Standard, 2 for Moderate, or 3 for Edge.'
  })}
</Response>`;

  res.type("text/xml").send(twiml);
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
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  ${twimlSaySSML('Invalid selection.')}
  <Redirect method="POST">${retry}</Redirect>
</Response>`);
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  ${twimlSaySSML('No scenarios available for this mode and difficulty. Returning to main menu.')}
  <Redirect method="POST">${back}</Redirect>
</Response>`);
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

  // Stream URL must be wss://
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio`;

  const safeSummary = String(scenario.summary || "");
  const safeObjective = String(scenario.objective || "");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSayText(`Scenario. ${safeSummary}`)}
  ${twimlSayText(`Primary objective. ${safeObjective}`)}
  ${twimlSaySSML('You are now connected. The borrower will answer first.')}

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
</Response>`;

  res.type("text/xml").send(twiml);
});

// =========================================================
//  WebSocket Bridge: Twilio Media Streams <-> OpenAI Realtime
// =========================================================

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

function openaiRealtimeConnect({ borrowerName, borrowerGender, mode, difficulty, scenarioId, objective }) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const model = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";

  // Realtime WS endpoint
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const ws = new WSClient(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    // Voice choice: keep stable. (You can change later.)
    const voice = "alloy";

    // Borrower behavioral instructions (governance-first)
    const instructions =
      `You are a real mortgage borrower named ${borrowerName}. ` +
      `You are in a training simulation. ` +
      `Rules: You do NOT volunteer your mortgage intent unless the ISA explicitly asks. ` +
      `You answer naturally, with minor hesitation. ` +
      `You may ask basic questions, but do not become a coach. ` +
      `Do not mention governance rules or scripts. ` +
      `If asked about rates, underwriting, or LO-only topics, you respond as a borrower (curious/anxious) but you do not provide professional advice. ` +
      `Context: mode=${mode}, difficulty=${difficulty}, scenarioId=${scenarioId}. ` +
      `Scenario objective: ${objective}`;

    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions
      }
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Borrower speaks first
    const create = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Start the call with: "Hello, this is ${borrowerName}." Then wait silently.`
      }
    };
    ws.send(JSON.stringify(create));
  });

  return ws;
}

// Create HTTP server + attach WS upgrade handling
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/twilio")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (twilioWs) => {
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;

  let cp = {}; // custom parameters from Twilio start event

  function closeBoth() {
    try { twilioWs.close(); } catch {}
    try { openaiWs && openaiWs.close(); } catch {}
  }

  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString("utf8"));
    } catch {
      return;
    }

    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;
      cp = data.start?.customParameters || {};

      console.log(JSON.stringify({
        event: "TWILIO_STREAM_START",
        sid: callSid,
        streamSid,
        customParameters: cp
      }));

      const borrowerName = cp.borrowerName || "Mike";
      const borrowerGender = cp.borrowerGender || "male";
      const mode = cp.mode || "mcd";
      const difficulty = cp.difficulty || "Standard";
      const scenarioId = cp.scenarioId || "UNKNOWN";
      const objective = cp.objective || "";

      try {
        openaiWs = openaiRealtimeConnect({
          borrowerName,
          borrowerGender,
          mode,
          difficulty,
          scenarioId,
          objective
        });

        openaiWs.on("open", () => {
          console.log(JSON.stringify({ event: "OPENAI_WS_OPEN", sid: callSid, model: process.env.REALTIME_MODEL || "gpt-4o-realtime-preview" }));
          console.log(JSON.stringify({ event: "OPENAI_SESSION_CONFIGURED", sid: callSid }));
        });

        openaiWs.on("error", (err) => {
          console.log(JSON.stringify({ event: "OPENAI_WS_ERROR", sid: callSid, error: String(err?.message || err) }));
          closeBoth();
        });

        openaiWs.on("close", () => {
          console.log(JSON.stringify({ event: "OPENAI_WS_CLOSE", sid: callSid }));
          closeBoth();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try {
            evt = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }

          // Most common audio delta event
          if (evt.type === "response.audio.delta" && evt.delta) {
            const payload = {
              event: "media",
              streamSid,
              media: { payload: evt.delta } // base64 g711_ulaw
            };
            try {
              twilioWs.send(JSON.stringify(payload));
            } catch {}
          }

          // Optional: log critical errors returned by OpenAI
          if (evt.type === "error") {
            console.log(JSON.stringify({ event: "OPENAI_EVT_ERROR", sid: callSid, detail: evt.error || evt }));
          }
        });
      } catch (err) {
        console.log(JSON.stringify({ event: "OPENAI_INIT_FAILED", sid: callSid, error: String(err?.message || err) }));
        closeBoth();
      }

      return;
    }

    if (data.event === "media") {
      if (!openaiWs || openaiWs.readyState !== 1) return;

      const payload = data.media?.payload; // base64 g711_ulaw
      if (!payload) return;

      const input = {
        type: "input_audio_buffer.append",
        audio: payload
      };

      try {
        openaiWs.send(JSON.stringify(input));
      } catch {}
      return;
    }

    if (data.event === "stop") {
      console.log(JSON.stringify({ event: "TWILIO_STREAM_STOP", sid: callSid, streamSid }));
      closeBoth();
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log(JSON.stringify({ event: "TWILIO_WS_CLOSE", sid: callSid, streamSid }));
    try { openaiWs && openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (err) => {
    console.log(JSON.stringify({ event: "TWILIO_WS_ERROR", sid: callSid, streamSid, error: String(err?.message || err) }));
    try { openaiWs && openaiWs.close(); } catch {}
  });
});

// ---------- Boot ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
