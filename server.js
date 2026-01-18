/* SCC ISA Training Voice System (Governance-First)
 * Twilio Voice (DTMF) -> Render Node/Express -> Twilio Media Streams WS -> OpenAI Realtime WS
 * Borrower speaks first. Scenarios externalized in scenarios.json.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- Load scenarios.json (authoritative content store) ----------
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = null;

function loadScenarios() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  SCENARIOS = JSON.parse(raw);
  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));
}
loadScenarios();

// ---------- Simple in-memory anti-repeat per (mode + difficulty) ----------
const lastScenarioByKey = new Map(); // key = `${mode}:${difficulty}` -> scenarioId

function pickScenario(mode, difficulty) {
  const list = (SCENARIOS?.[mode]?.[difficulty]) || [];
  if (!list.length) return null;

  const key = `${mode}:${difficulty}`;
  const last = lastScenarioByKey.get(key);

  // try to pick a different one if possible
  let pick = list[Math.floor(Math.random() * list.length)];
  if (list.length > 1 && pick.id === last) {
    for (let i = 0; i < 5; i++) {
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
function twimlSay(text) {
  // Twilio will escape automatically; keep it simple.
  return `<Say voice="Google.en-US-Chirp3-HD">${text}</Say>`;
}

function twimlGather({ action, numDigits = 1, prompt, invalidPrompt }) {
  // IMPORTANT: Use absolute URL in action to prevent call drop
  return `
    <Gather input="dtmf" numDigits="${numDigits}" action="${action}" method="POST" timeout="8">
      ${twimlSay(prompt)}
    </Gather>
    ${twimlSay(invalidPrompt || "Sorry, I did not get that.")}
    <Redirect method="POST">${action}</Redirect>
  `;
}

function absUrl(req, p) {
  // Render + Twilio are HTTPS; use host header to build absolute URLs for TwiML actions
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v1.0 AI bridge (Twilio Stream + OpenAI Realtime)")
);

// ---------- Core Call Flow ----------
app.post("/voice", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "CALL_START", sid }));

  const menuAction = absUrl(req, "/menu");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlGather({
    action: menuAction,
    prompt: "Welcome to S C C I S A training. Press 1 for M 1 scenario. Press 2 for M C D scenario.",
    invalidPrompt: "Invalid choice. Press 1 for M 1. Press 2 for M C D."
  })}
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  if (digit === "1") {
    // M1
    const gatePrompt = absUrl(req, "/m1-gate-prompt");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${gatePrompt}</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (digit === "2") {
    // MCD
    const gatePrompt = absUrl(req, "/mcd-gate-prompt");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${gatePrompt}</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // invalid -> restart voice
  const voice = absUrl(req, "/voice");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay("Invalid selection. Returning to main menu.")}
  <Redirect method="POST">${voice}</Redirect>
</Response>`;
  return res.type("text/xml").send(twiml);
});

// ---------- Gates ----------
app.post("/mcd-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const action = absUrl(req, "/mcd-gate");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlGather({
    action,
    prompt: "M C D gate. Press 9 to confirm and proceed.",
    invalidPrompt: "Gate not passed. Press 9 to proceed."
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
    const gatePrompt = absUrl(req, "/mcd-gate-prompt");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay("Gate not passed.")}
  <Redirect method="POST">${gatePrompt}</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  const difficultyPrompt = absUrl(req, "/difficulty-prompt?mode=mcd");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${difficultyPrompt}</Redirect>
</Response>`;
  return res.type("text/xml").send(twiml);
});

app.post("/m1-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));

  const action = absUrl(req, "/m1-gate");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlGather({
    action,
    prompt: "M 1 gate. Press 8 to confirm and proceed.",
    invalidPrompt: "Gate not passed. Press 8 to proceed."
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
    const gatePrompt = absUrl(req, "/m1-gate-prompt");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay("Gate not passed.")}
  <Redirect method="POST">${gatePrompt}</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  const difficultyPrompt = absUrl(req, "/difficulty-prompt?mode=m1");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${difficultyPrompt}</Redirect>
</Response>`;
  return res.type("text/xml").send(twiml);
});

// ---------- Difficulty selection ----------
app.post("/difficulty-prompt", (req, res) => {
  const sid = req.body.CallSid;
  const mode = (req.query.mode || "").trim();
  console.log(JSON.stringify({ event: "DIFFICULTY_PROMPT", sid, mode }));

  const action = absUrl(req, `/difficulty?mode=${encodeURIComponent(mode)}`);
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlGather({
    action,
    prompt: "Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.",
    invalidPrompt: "Invalid selection. Press 1 for Standard, 2 for Moderate, or 3 for Edge."
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
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay("Invalid selection.")}
  <Redirect method="POST">${retry}</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    const voice = absUrl(req, "/voice");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay("No scenarios available for this mode and difficulty. Returning to main menu.")}
  <Redirect method="POST">${voice}</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
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

  // Narrator reads scenario and objective, then connects stream
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio`;

  // Pass critical scenario context as customParameters to Twilio stream
  // (Twilio will include these in the start event)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay(`Scenario. ${scenario.summary}`)}
  ${twimlSay(`Primary objective. ${scenario.objective}`)}
  ${twimlSay("You are now connected. The borrower will answer first.")}

  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="borrowerGender" value="${scenario.borrowerGender}" />
      <Parameter name="mode" value="${mode}" />
      <Parameter name="scenarioId" value="${scenario.id}" />
      <Parameter name="objective" value="${scenario.objective}" />
      <Parameter name="difficulty" value="${difficulty}" />
      <Parameter name="borrowerName" value="${scenario.borrowerName}" />
    </Stream>
  </Connect>

</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- WebSocket bridge: Twilio <-> OpenAI Realtime ----------
function openaiRealtimeConnect({ borrowerName }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("Missing OPENAI_API_KEY env var");
    err.code = "MISSING_OPENAI_API_KEY";
    throw err;
  }

  // IMPORTANT: Realtime websocket endpoint (server-to-server)
  // If your account/model changes, update here.
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

  const ws = new (require("ws"))(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    // Configure session: audio I/O, voice, turn-taking
    // NOTE: We keep it minimal and robust for transport validation.
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions:
          `You are the borrower named ${borrowerName}. ` +
          `You do not volunteer intent unless explicitly asked. ` +
          `You speak naturally with minor hesitations. ` +
          `You answer first with a greeting.`
      }
    };
    ws.send(JSON.stringify(sessionUpdate));

    // Force borrower to speak first immediately
    const create = {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Start the call: say "Hello, this is ${borrowerName}." Then wait.`
      }
    };
    ws.send(JSON.stringify(create));
  });

  return ws;
}

// Create HTTP server + attach WS upgrade routing
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  // Only accept upgrades on /twilio
  const { url } = req;
  if (!url || !url.startsWith("/twilio")) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (twilioWs, req) => {
  let callSid = null;
  let streamSid = null;
  let openaiWs = null;
  let borrowerName = "Mike"; // default fallback

  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString("utf8"));
    } catch (e) {
      return;
    }

    // Twilio Media Streams events: start, media, mark, stop
    if (data.event === "start") {
      callSid = data.start?.callSid || null;
      streamSid = data.start?.streamSid || null;

      const cp = data.start?.customParameters || {};
      borrowerName = cp.borrowerName || borrowerName;

      console.log(JSON.stringify({
        event: "TWILIO_STREAM_START",
        sid: callSid,
        streamSid,
        customParameters: cp
      }));

      try {
        openaiWs = openaiRealtimeConnect({ borrowerName });

        openaiWs.on("open", () => {
          console.log(JSON.stringify({ event: "OPENAI_WS_OPEN", sid: callSid }));
        });

        openaiWs.on("error", (err) => {
          console.log(JSON.stringify({ event: "OPENAI_WS_ERROR", sid: callSid, error: String(err?.message || err) }));
          try { twilioWs.close(); } catch {}
        });

        openaiWs.on("close", () => {
          console.log(JSON.stringify({ event: "OPENAI_WS_CLOSE", sid: callSid }));
          try { twilioWs.close(); } catch {}
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try {
            evt = JSON.parse(raw.toString("utf8"));
          } catch {
            return;
          }

          // Stream audio deltas back to Twilio
          // OpenAI Realtime emits audio chunks as base64 under different event types depending on model version.
          // We handle the common "response.audio.delta" shape.
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
        });

        console.log(JSON.stringify({ event: "OPENAI_SESSION_CONFIGURED", sid: callSid }));
      } catch (err) {
        console.log(JSON.stringify({ event: "OPENAI_INIT_FAILED", sid: callSid, error: String(err?.message || err) }));
        try { twilioWs.close(); } catch {}
      }

      return;
    }

    if (data.event === "media") {
      // Twilio -> OpenAI input audio
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
      // Twilio stopped stream
      try { openaiWs && openaiWs.close(); } catch {}
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
