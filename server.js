/* SCC ISA Training Voice System (Governance-First)
 * v1.5 — Best narrator voice + correct acronym pronunciation + reliable AI audio forwarding
 *
 * NARRATOR:
 * - Twilio <Say> uses Google Chirp3-HD (best available in Twilio TTS):
 *   voice="Google.en-US-Chirp3-HD-Aoede" (Twilio documented example)
 *
 * PRONUNCIATION:
 * - Uses SSML <say-as> inside <Say> (Twilio supports SSML tags like <say-as> in <Say>).
 *
 * BORROWER (AI):
 * - Twilio Media Streams WS (/twilio) <-> OpenAI Realtime WS
 * - Uses g711_ulaw end-to-end (Twilio Media Streams = PCMU; OpenAI Realtime Beta supports g711_ulaw).
 * - Forces borrower to speak first via response.create.
 * - Handles multiple possible audio delta event shapes to avoid “dead air”.
 *
 * REQUIRED ENV VARS (Render):
 * - OPENAI_API_KEY
 *
 * OPTIONAL ENV VARS:
 * - REALTIME_MODEL (default: gpt-realtime)
 *
 * Notes:
 * - Twilio supports Google Chirp3-HD voices in <Say> like Google.en-US-Chirp3-HD-Aoede. :contentReference[oaicite:2]{index=2}
 * - OpenAI Realtime “gpt-realtime” is GA and recommended as most advanced realtime model. :contentReference[oaicite:3]{index=3}
 * - OpenAI Realtime voices: marin / cedar recommended for best quality. :contentReference[oaicite:4]{index=4}
 * - OpenAI Realtime beta supports g711_ulaw input/output formats. :contentReference[oaicite:5]{index=5}
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

// -------------------- Scenario store (authoritative) --------------------
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

// Best narrator voice in Twilio TTS
const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

// Narrator: plain text
function sayText(text) {
  return `<Say voice="${NARRATOR_VOICE}">${xmlEscape(text)}</Say>`;
}

// Narrator: controlled SSML snippets we author (do NOT pass untrusted text here)
function saySSML(ssmlInner) {
  // Twilio supports SSML tags like <say-as> within <Say>. :contentReference[oaicite:6]{index=6}
  return `<Say voice="${NARRATOR_VOICE}">${ssmlInner}</Say>`;
}

function gatherOneDigit({ action, promptInner, invalidInner }) {
  return `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
      ${promptInner}
    </Gather>
    ${invalidInner}
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
  res.status(200).send("scc-isa-voice v1.5 Chirp3-HD narrator + SSML acronyms + OpenAI borrower (g711_ulaw)")
);

// =========================================================
//  SCC Call Flow (Menu -> Gate -> Difficulty -> Scenario -> Connect Stream)
// =========================================================

// Allow GET for quick sanity; Twilio uses POST.
app.all("/voice", (req, res) => {
  try {
    const sid = req.body?.CallSid || req.query?.CallSid || null;
    console.log(JSON.stringify({ event: "CALL_START", sid }));

    const menuAction = absUrl(req, "/menu");

    // Force spelling via SSML. Use spell-out for acronyms/shortcodes.
    const prompt = saySSML(
      `Welcome to <say-as interpret-as="spell-out">SCC</say-as> ` +
      `<say-as interpret-as="spell-out">ISA</say-as> training. ` +
      `Press 1 for <say-as interpret-as="spell-out">M1</say-as> scenario. ` +
      `Press 2 for <say-as interpret-as="spell-out">MCD</say-as> scenario.`
    );

    const invalid = saySSML(
      `Invalid choice. Press 1 for <say-as interpret-as="spell-out">M1</say-as>. ` +
      `Press 2 for <say-as interpret-as="spell-out">MCD</say-as>.`
    );

    const inner = gatherOneDigit({
      action: menuAction,
      promptInner: prompt,
      invalidInner: invalid
    });

    res.type("text/xml").status(200).send(twimlResponse(inner));
  } catch (err) {
    console.log(JSON.stringify({ event: "VOICE_FATAL", error: String(err?.message || err) }));
    res.type("text/xml").status(200).send(twimlResponse(sayText("System error. Please hang up and try again.")));
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
      twimlResponse(`${sayText("Invalid selection. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`)
    );
  } catch (err) {
    console.log(JSON.stringify({ event: "MENU_FATAL", error: String(err?.message || err) }));
    res.type("text/xml").status(200).send(twimlResponse(sayText("System error. Please hang up and try again.")));
  }
});

// ---------- Gates ----------
app.post("/mcd-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const action = absUrl(req, "/mcd-gate");
  const inner = gatherOneDigit({
    action,
    promptInner: saySSML(`<say-as interpret-as="spell-out">MCD</say-as> gate. Press 9 to confirm and proceed.`),
    invalidInner: sayText("Gate not passed. Press 9 to proceed.")
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
      twimlResponse(`${sayText("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`)
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
    promptInner: saySSML(`<say-as interpret-as="spell-out">M1</say-as> gate. Press 8 to confirm and proceed.`),
    invalidInner: sayText("Gate not passed. Press 8 to proceed.")
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
      twimlResponse(`${sayText("Gate not passed.")}<Redirect method="POST">${back}</Redirect>`)
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
    promptInner: sayText("Select difficulty. Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge."),
    invalidInner: sayText("Invalid selection. Press 1 for Standard, 2 for Moderate, or 3 for Edge.")
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
      twimlResponse(`${sayText("Invalid selection.")}<Redirect method="POST">${retry}</Redirect>`)
    );
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").status(200).send(
      twimlResponse(`${sayText("No scenarios available. Returning to main menu.")}<Redirect method="POST">${back}</Redirect>`)
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

  // Keep the call alive even if the stream fails to produce audio
  const inner = `
    ${sayText(`Scenario. ${safeSummary}`)}
    ${sayText(`Primary objective. ${safeObjective}`)}
    ${sayText("You are now connected. The borrower will answer first.")}

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
    ${sayText("Session ended. Returning to main menu.")}
    <Redirect method="POST">${absUrl(req, "/voice")}</Redirect>
  `;

  res.type("text/xml").status(200).send(twimlResponse(inner));
});

// =========================================================
//  WebSocket Bridge: Twilio Media Streams <-> OpenAI Realtime
// =========================================================

function openaiRealtimeConnect({ borrowerName, mode, difficulty, scenarioId, objective }) {
  const apiKey = requireEnv("OPENAI_API_KEY");

  // Use gpt-realtime by default (recommended advanced realtime model). :contentReference[oaicite:7]{index=7}
  const model = process.env.REALTIME_MODEL || "gpt-realtime";
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  // We intentionally include the beta header so the session fields we send are accepted consistently.
  // (OpenAI docs note GA vs beta differences; this keeps behavior stable for this build stage.)
  const ws = new WSClient(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", () => {
    // Configure session for g711_ulaw (matches Twilio PCMU) and best voice.
    // OpenAI Realtime Beta supports g711_ulaw for input/output audio formats. :contentReference[oaicite:8]{index=8}
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Enable audio output (and keep text optional)
        modalities: ["audio", "text"],
        voice: "marin", // best quality recommended by OpenAI docs. :contentReference[oaicite:9]{index=9}
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions:
          `You are a real mortgage borrower named ${borrowerName}. ` +
          `You do NOT volunteer your mortgage intent unless the ISA explicitly asks. ` +
          `You answer naturally, briefly, and realistically. ` +
          `Do not coach. Do not mention scripts or governance. ` +
          `Context: mode=${mode}, difficulty=${difficulty}, scenarioId=${scenarioId}. ` +
          `Scenario objective: ${objective}`
      }
    };

    ws.send(JSON.stringify(sessionUpdate));

    // Force borrower to speak first, immediately.
    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        voice: "marin",
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
  let lastAudioOutAt = 0;

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
          log("OPENAI_WS_OPEN", { model: process.env.REALTIME_MODEL || "gpt-realtime" });
          log("OPENAI_SESSION_CONFIGURED");
        });

        openaiWs.on("error", (err) => {
          log("OPENAI_WS_ERROR", { error: String(err?.message || err) });
          closeBoth();
        });

        openaiWs.on("close", () => {
          log("OPENAI_WS_CLOSE", { msAlive: Date.now() - startedAt, msSinceLastAudioOut: lastAudioOutAt ? (Date.now() - lastAudioOutAt) : null });
          closeBoth();
        });

        openaiWs.on("message", (raw) => {
          let evt;
          try { evt = JSON.parse(raw.toString("utf8")); } catch { return; }

          // Handle multiple potential audio delta shapes.
          // OpenAI Realtime Beta uses response.audio.delta; docs also show output_audio.delta variants. :contentReference[oaicite:10]{index=10}
          const delta =
            (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
            (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
            null;

          if (delta) {
            lastAudioOutAt = Date.now();
            try {
              twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: delta }
              }));
            } catch {}
            return;
          }

          if (evt.type === "error") {
            log("OPENAI_EVT_ERROR", { detail: evt.error || evt });
            return;
          }

          // Useful when you get “dead air”: you’ll still see what the model is doing.
          if (evt.type === "session.created") log("OPENAI_SESSION_CREATED");
          if (evt.type === "response.created") log("OPENAI_RESPONSE_CREATED");
          if (evt.type === "response.done") log("OPENAI_RESPONSE_DONE");
        });

        // Watchdog: if no audio output within 4 seconds, log it (call stays alive due to <Pause>).
        setTimeout(() => {
          if (!lastAudioOutAt) {
            log("OPENAI_NO_AUDIO_AFTER_4S");
          }
        }, 4000);

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

// -------------------- Boot --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
