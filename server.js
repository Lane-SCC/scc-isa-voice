const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.urlencoded({ extended: false }));

// ====================
// Config
// ====================
const TTS_VOICE = "Google.en-US-Chirp3-HD-Aoede"; // system/narrator voice (Twilio <Say>)
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");

// OpenAI Realtime WebSocket URL (server-to-server)
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"; // :contentReference[oaicite:4]{index=4}

// Map borrower gender -> OpenAI voice (pick what sounds right to you)
const OPENAI_VOICE_BY_GENDER = {
  male: "marin",
  female: "cedar",
  unknown: "marin",
};

// ====================
// Logging helpers
// ====================
function sid(req) {
  return req.body?.CallSid || "NO_CALL_SID";
}

function logEvent(event, reqOrSid, extra = {}) {
  // reqOrSid can be req (HTTP) or string sid (WS)
  const callSid =
    typeof reqOrSid === "string" ? reqOrSid : sid(reqOrSid) || "NO_CALL_SID";

  const payload = { event, sid: callSid, ...extra };
  console.log(JSON.stringify(payload));
}

// ====================
// XML / SSML helpers (Twilio <Say>)
// ====================
function xmlEscape(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function injectAcronyms(escapedText) {
  // ISA -> I-S-A
  return escapedText.replace(
    /\bISA\b/g,
    `<say-as interpret-as="characters">ISA</say-as>`
  );
}

function saySsml(text) {
  const escaped = xmlEscape(text);
  const withAcronyms = injectAcronyms(escaped);
  return `<Say voice="${TTS_VOICE}"><speak>${withAcronyms}</speak></Say>`;
}

// ====================
// Load scenarios.json
// ====================
function loadScenarios() {
  try {
    const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data?.mcd || !data?.m1) {
      throw new Error("scenarios.json missing required keys: mcd, m1");
    }
    console.log(
      JSON.stringify({
        event: "SCENARIOS_LOADED",
        path: SCENARIOS_PATH,
      })
    );
    return data;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "SCENARIOS_LOAD_FAILED",
        path: SCENARIOS_PATH,
        error: String(err?.message || err),
      })
    );
    return {
      mcd: { Standard: [], Moderate: [], Edge: [] },
      m1: { Standard: [], Moderate: [], Edge: [] },
    };
  }
}

let SCENARIOS = loadScenarios();

// No-immediate-repeat memory (per mode+difficulty). Resets on deploy/restart.
const lastScenarioByKey = {};

function pickScenarioNoRepeat(mode, difficulty) {
  const bucket = SCENARIOS?.[mode]?.[difficulty] || [];
  if (bucket.length === 0) return null;
  if (bucket.length === 1) return bucket[0];

  const key = `${mode}:${difficulty}`;
  const lastId = lastScenarioByKey[key];

  let choice = null;
  for (let i = 0; i < 6; i++) {
    const candidate = bucket[Math.floor(Math.random() * bucket.length)];
    if (candidate.id !== lastId) {
      choice = candidate;
      break;
    }
    choice = candidate;
  }

  lastScenarioByKey[key] = choice.id;
  return choice;
}

// ====================
// Health + Version
// ====================
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/version", (req, res) =>
  res
    .status(200)
    .send("scc-isa-voice v1.0 AI bridge (Twilio Stream + OpenAI Realtime)")
);

app.get("/scenarios/status", (req, res) => {
  res.status(200).json({
    mcd: {
      Standard: SCENARIOS?.mcd?.Standard?.length || 0,
      Moderate: SCENARIOS?.mcd?.Moderate?.length || 0,
      Edge: SCENARIOS?.mcd?.Edge?.length || 0,
    },
    m1: {
      Standard: SCENARIOS?.m1?.Standard?.length || 0,
      Moderate: SCENARIOS?.m1?.Moderate?.length || 0,
      Edge: SCENARIOS?.m1?.Edge?.length || 0,
    },
  });
});

// ====================
// Call Entry
// ====================
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("CALL_START", req);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${baseUrl}/menu" method="POST">
    ${saySsml("Welcome to SCC ISA training. Press 1 for M1. Press 2 for MCD.")}
  </Gather>
</Response>`);
});

app.post("/menu", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = req.body?.Digits;
  logEvent("MENU", req, { digit });

  const next = digit === "1" ? "/m1" : digit === "2" ? "/mcd" : "/voice";

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}${next}</Redirect>
</Response>`);
});

// ====================
// Gates
// ====================
app.post("/mcd", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("MCD_GATE_PROMPT", req);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/mcd/gate" method="POST">
    ${saySsml("To begin MCD training, press 9.")}
  </Gather>
</Response>`);
});

app.post("/mcd/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const pass = req.body?.Digits === "9";
  logEvent("MCD_GATE", req, { pass });

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}/${pass ? "difficulty?mode=mcd" : "mcd"}</Redirect>
</Response>`);
});

app.post("/m1", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("M1_GATE_PROMPT", req);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/m1/gate" method="POST">
    ${saySsml("To begin M1 training, press 8.")}
  </Gather>
</Response>`);
});

app.post("/m1/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const pass = req.body?.Digits === "8";
  logEvent("M1_GATE", req, { pass });

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}/${pass ? "difficulty?mode=m1" : "m1"}</Redirect>
</Response>`);
});

// ====================
// Difficulty + Scenario -> AI bridge
// ====================
app.post("/difficulty", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const mode = req.query.mode;
  logEvent("DIFFICULTY_PROMPT", req, { mode });

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/scenario?mode=${mode}" method="POST">
    ${saySsml("Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.")}
  </Gather>
</Response>`);
});

app.post("/scenario", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;
  const wsUrl = `wss://${host}/twilio`;

  const mode = req.query.mode; // "mcd" or "m1"
  const digit = req.body?.Digits;

  const difficulty =
    digit === "1"
      ? "Standard"
      : digit === "2"
      ? "Moderate"
      : digit === "3"
      ? "Edge"
      : null;

  if (!mode || (mode !== "mcd" && mode !== "m1")) {
    logEvent("SCENARIO_INVALID_MODE", req, { mode });
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Invalid mode. Goodbye.")}
  <Hangup/>
</Response>`);
  }

  if (!difficulty) {
    logEvent("SCENARIO_INVALID_DIFFICULTY", req, { mode, digit });
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Invalid selection. Goodbye.")}
  <Hangup/>
</Response>`);
  }

  const scenario = pickScenarioNoRepeat(mode, difficulty);

  if (!scenario) {
    logEvent("SCENARIO_NOT_FOUND", req, { mode, difficulty });
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("No scenarios found for this selection. Goodbye.")}
  <Hangup/>
</Response>`);
  }

  const scenarioId = scenario.id || "UNKNOWN";
  const borrowerName = scenario.borrowerName || "Borrower";
  const borrowerGender = scenario.borrowerGender || "unknown";
  const summary = scenario.summary || "";
  const objective = scenario.objective || "";

  logEvent("SCENARIO_LOADED", req, {
    mode,
    difficulty,
    scenarioId,
    borrowerName,
    borrowerGender,
  });

  // Pass scenario context to WS via <Parameter> customParameters (shows up in Twilio "start" message) :contentReference[oaicite:5]{index=5}
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml(`Scenario loaded. ${summary} Primary objective. ${objective}`)}
  ${saySsml("Connecting you now. The borrower will answer first.")}
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="scenarioId" value="${xmlEscape(scenarioId)}"/>
      <Parameter name="mode" value="${xmlEscape(mode)}"/>
      <Parameter name="difficulty" value="${xmlEscape(difficulty)}"/>
      <Parameter name="borrowerName" value="${xmlEscape(borrowerName)}"/>
      <Parameter name="borrowerGender" value="${xmlEscape(borrowerGender)}"/>
      <Parameter name="objective" value="${xmlEscape(objective)}"/>
    </Stream>
  </Connect>
</Response>`);
});

// ====================
// WebSocket: Twilio Media Streams (/twilio)
// - Receives: connected/start/media/stop messages :contentReference[oaicite:6]{index=6}
// - start.mediaFormat.encoding is audio/x-mulaw (G.711 μ-law) :contentReference[oaicite:7]{index=7}
// ====================

function openAiRealtimeSocket({ callSid, borrowerName, borrowerGender, scenarioId, mode, difficulty, objective }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY env var");

  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: "Bearer " + apiKey },
  }); // :contentReference[oaicite:8]{index=8}

  const selectedVoice =
    OPENAI_VOICE_BY_GENDER[borrowerGender] || OPENAI_VOICE_BY_GENDER.unknown;

  ws.on("open", () => {
    logEvent("OPENAI_WS_OPEN", callSid, { selectedVoice });
  });

  ws.on("close", () => {
    logEvent("OPENAI_WS_CLOSE", callSid);
  });

  ws.on("error", (err) => {
    logEvent("OPENAI_WS_ERROR", callSid, { error: String(err?.message || err) });
  });

  // We’ll send session.update after session.created arrives, per docs :contentReference[oaicite:9]{index=9}
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }

    if (msg.type === "session.created") {
      // Configure: audio in/out = PCMU (mulaw) to match Twilio stream
      // session.update schema supports audio/pcmu :contentReference[oaicite:10]{index=10}
      const instructions = [
        "You are the borrower in a mortgage lead call training simulation.",
        `Your name is ${borrowerName}.`,
        `Scenario ID: ${scenarioId}. Mode: ${mode}. Difficulty: ${difficulty}.`,
        `Primary objective for the ISA: ${objective}.`,
        "",
        "Hard borrower rules:",
        "- You speak first with: 'Hello, this is <name>.'",
        "- You do NOT volunteer intent unless explicitly asked.",
        "- If asked LO-only questions (rates, quotes, underwriting), you push for an answer but accept a proper deferral.",
        "- You should sound like a real person: short phrases, occasional hesitation, mild emotion consistent with difficulty.",
        "- Do not coach the ISA. Do not mention training systems.",
      ].join("\n");

      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: "gpt-realtime",
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcmu" },
                turn_detection: {
                  type: "server_vad",
                  create_response: true,
                  interrupt_response: true,
                  silence_duration_ms: 500
                }
              },
              output: {
                format: { type: "audio/pcmu" },
                voice: selectedVoice
              }
            },
            instructions
          }
        })
      );

      // Force the borrower to speak first (greeting) using response.create :contentReference[oaicite:11]{index=11}
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: `Start immediately by saying: "Hello, this is ${borrowerName}." Then wait for the ISA to speak.`
          }
        })
      );

      logEvent("OPENAI_SESSION_CONFIGURED", callSid, {
        scenarioId,
        mode,
        difficulty,
        borrowerName,
        borrowerGender,
        voice: selectedVoice
      });
    }
  });

  return ws;
}

// Create HTTP server so WS can share the same port (Render-friendly)
const server = http.createServer(app);

// Twilio WS server on /twilio
const wss = new WebSocket.Server({ server, path: "/twilio" });

// Active stream state per connection
wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let openaiWs = null;

  // Twilio -> our server messages are JSON: connected/start/media/stop :contentReference[oaicite:12]{index=12}
  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg.event === "connected") {
      // noop
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      const cp = msg.start?.customParameters || {};

      logEvent("TWILIO_STREAM_START", callSid || "NO_CALL_SID", {
        streamSid,
        customParameters: cp
      });

      // Establish OpenAI Realtime WS now that we have scenario context
      const borrowerName = cp.borrowerName || "Borrower";
      const borrowerGender = cp.borrowerGender || "unknown";
      const scenarioId = cp.scenarioId || "UNKNOWN";
      const mode = cp.mode || "mcd";
      const difficulty = cp.difficulty || "Standard";
      const objective = cp.objective || "";

      try {
        openaiWs = openAiRealtimeSocket({
          callSid: callSid || "NO_CALL_SID",
          borrowerName,
          borrowerGender,
          scenarioId,
          mode,
          difficulty,
          objective
        });
      } catch (err) {
        logEvent("OPENAI_INIT_FAILED", callSid || "NO_CALL_SID", {
          error: String(err?.message || err)
        });
        // End the Twilio stream by closing WS
        twilioWs.close();
        return;
      }

      // OpenAI -> Twilio audio
      openaiWs.on("message", (buf) => {
        let om;
        try {
          om = JSON.parse(buf.toString("utf8"));
        } catch {
          return;
        }

        // Stream audio deltas back to Twilio :contentReference[oaicite:13]{index=13}
        if (om.type === "response.output_audio.delta" && om.delta) {
          if (!streamSid) return;

          const outMsg = {
            event: "media",
            streamSid,
            media: {
              payload: om.delta
            }
          };

          try {
            twilioWs.send(JSON.stringify(outMsg));
          } catch {
            // ignore
          }
        }

        // Useful to log session updates / errors
        if (om.type === "error") {
          logEvent("OPENAI_ERROR_EVENT", callSid || "NO_CALL_SID", { error: om });
        }
      });

      return;
    }

    if (msg.event === "media") {
      // Incoming caller audio chunk is base64 μ-law (mulaw). Twilio encodes audio/x-mulaw. :contentReference[oaicite:14]{index=14}
      const payload = msg.media?.payload;
      if (!payload || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

      // Send audio to OpenAI input buffer :contentReference[oaicite:15]{index=15}
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: payload
        })
      );

      return;
    }

    if (msg.event === "stop") {
      logEvent("TWILIO_STREAM_STOP", callSid || "NO_CALL_SID", { streamSid });
      try {
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      } catch {}
      try {
        twilioWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    logEvent("TWILIO_WS_CLOSE", callSid || "NO_CALL_SID", { streamSid });
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    logEvent("TWILIO_WS_ERROR", callSid || "NO_CALL_SID", {
      streamSid,
      error: String(err?.message || err)
    });
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
