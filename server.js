/* SCC ISA Training Voice System (Governance-First)
 * v2.1 — Narrator v2 (Operator-Grade) + Holy-Shit Audio Realism (UNCHANGED)
 *
 * Audio / AI layer is FROZEN.
 * This revision ONLY fixes narrator clarity, phonetics, and call-flow cognition.
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

// =========================================================
// Scenarios (authoritative)
// =========================================================

const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = null;

function loadScenarios() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  SCENARIOS = JSON.parse(raw);
  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));
}
loadScenarios();

// Anti-repeat per (mode+difficulty)
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

// =========================================================
// Helpers
// =========================================================

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

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

// =========================================================
// Narrator (Twilio <Say>) — OPERATOR GRADE
// =========================================================

const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

function say(text) {
  return `<Say voice="${NARRATOR_VOICE}">${xmlEscape(text)}</Say>`;
}

function gatherOneDigit({ action, promptText, invalidText }) {
  return `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="7">
      ${say(promptText)}
    </Gather>
    ${say(invalidText)}
    <Redirect method="POST">${action}</Redirect>
  `;
}

// =========================================================
// HEALTH
// =========================================================

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) =>
  res.status(200).send("scc-isa-voice v2.1 narrator-operator-grade")
);

// =========================================================
// SCC CALL FLOW (NARRATOR v2)
// =========================================================

app.all("/voice", (req, res) => {
  const sid = req.body?.CallSid || null;
  console.log(JSON.stringify({ event: "CALL_START", sid }));

  const inner = gatherOneDigit({
    action: absUrl(req, "/menu"),
    promptText:
      "Sharpe Command Center. ISA training system. " +
      "Choose your call type. " +
      "Press 1 for engagement and application. " +
      "Press 2 for context discovery.",
    invalidText:
      "Invalid choice. Press 1 for engagement and application. Press 2 for context discovery."
  });

  res.type("text/xml").status(200).send(twiml(inner));
});

app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  if (digit === "1") {
    return res.type("text/xml").send(
      twiml(`<Redirect method="POST">${absUrl(req, "/m1-gate-prompt")}</Redirect>`)
    );
  }

  if (digit === "2") {
    return res.type("text/xml").send(
      twiml(`<Redirect method="POST">${absUrl(req, "/mcd-gate-prompt")}</Redirect>`)
    );
  }

  res.type("text/xml").send(
    twiml(
      `${say("Invalid selection. Returning to main menu.")}` +
      `<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`
    )
  );
});

// -------------------- Gates --------------------

app.post("/mcd-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const inner = gatherOneDigit({
    action: absUrl(req, "/mcd-gate"),
    promptText:
      "Context discovery selected. " +
      "This call tests whether you correctly identify intent. " +
      "Press 9 to continue.",
    invalidText:
      "Selection not confirmed. Press 9 to continue."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/mcd-gate", (req, res) => {
  const sid = req.body.CallSid;
  const pass = (req.body.Digits || "") === "9";
  console.log(JSON.stringify({ event: "MCD_GATE", sid, pass }));

  if (!pass) {
    return res.type("text/xml").send(
      twiml(
        `${say("Selection not confirmed.")}` +
        `<Redirect method="POST">${absUrl(req, "/mcd-gate-prompt")}</Redirect>`
      )
    );
  }

  res.type("text/xml").send(
    twiml(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=mcd")}</Redirect>`)
  );
});

app.post("/m1-gate-prompt", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));

  const inner = gatherOneDigit({
    action: absUrl(req, "/m1-gate"),
    promptText:
      "Engagement and application selected. " +
      "This call tests proper application attempt and handoff rules. " +
      "Press 8 to continue.",
    invalidText:
      "Selection not confirmed. Press 8 to continue."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/m1-gate", (req, res) => {
  const sid = req.body.CallSid;
  const pass = (req.body.Digits || "") === "8";
  console.log(JSON.stringify({ event: "M1_GATE", sid, pass }));

  if (!pass) {
    return res.type("text/xml").send(
      twiml(
        `${say("Selection not confirmed.")}` +
        `<Redirect method="POST">${absUrl(req, "/m1-gate-prompt")}</Redirect>`
      )
    );
  }

  res.type("text/xml").send(
    twiml(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=m1")}</Redirect>`)
  );
});

// -------------------- Difficulty --------------------

app.post("/difficulty-prompt", (req, res) => {
  const sid = req.body.CallSid;
  const mode = req.query.mode;
  console.log(JSON.stringify({ event: "DIFFICULTY_PROMPT", sid, mode }));

  const inner = gatherOneDigit({
    action: absUrl(req, `/difficulty?mode=${mode}`),
    promptText:
      "Choose difficulty. " +
      "Press 1 for standard. " +
      "Press 2 for moderate. " +
      "Press 3 for edge.",
    invalidText:
      "Invalid choice. Press 1, 2, or 3."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/difficulty", (req, res) => {
  const sid = req.body.CallSid;
  const mode = req.query.mode;
  const digit = (req.body.Digits || "").trim();

  const difficulty =
    digit === "1" ? "Standard" :
    digit === "2" ? "Moderate" :
    digit === "3" ? "Edge" : null;

  if (!difficulty || (mode !== "mcd" && mode !== "m1")) {
    return res.type("text/xml").send(
      twiml(
        `${say("Invalid selection.")}` +
        `<Redirect method="POST">${absUrl(req, `/difficulty-prompt?mode=${mode}`)}</Redirect>`
      )
    );
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    return res.type("text/xml").send(
      twiml(
        `${say("No scenarios available. Returning to main menu.")}` +
        `<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`
      )
    );
  }

  console.log(JSON.stringify({
    event: "SCENARIO_LOADED",
    sid,
    mode,
    difficulty,
    scenarioId: scenario.id
  }));

  const streamUrl = `wss://${req.headers["x-forwarded-host"] || req.headers.host}/twilio`;

  const inner = `
    ${say(`Scenario loaded. ${scenario.summary}`)}
    ${say(`Primary objective. ${scenario.objective}`)}
    ${say("You are now connected. The borrower will speak first.")}

    <Connect>
      <Stream url="${streamUrl}">
        <Parameter name="mode" value="${xmlEscape(mode)}"/>
        <Parameter name="difficulty" value="${xmlEscape(difficulty)}"/>
        <Parameter name="scenarioId" value="${xmlEscape(scenario.id)}"/>
        <Parameter name="borrowerName" value="${xmlEscape(scenario.borrowerName)}"/>
        <Parameter name="borrowerGender" value="${xmlEscape(scenario.borrowerGender)}"/>
      </Stream>
    </Connect>
  `;

  res.type("text/xml").send(twiml(inner));
});

// =========================================================
// WebSocket bridge + OpenAI Realtime
// (UNCHANGED FROM YOUR v2.0 — INTENTIONALLY OMITTED HERE)
// =========================================================
//
// ⛔ DO NOT MODIFY THIS SECTION
// ⛔ KEEP YOUR EXISTING AUDIO / REALTIME CODE EXACTLY AS IS
//
// =========================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ⬇️ KEEP YOUR EXISTING WS UPGRADE + AUDIO LOGIC HERE ⬇️

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
