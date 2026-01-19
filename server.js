/* SCC ISA Training Voice System (Governance-First)
 * v2.3 — Acronym Clarity Pass (Once-Per-Call)
 * Audio / OpenAI layer unchanged and frozen
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
// Scenarios
// =========================================================

const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8"));

const lastScenarioByKey = new Map();
function pickScenario(mode, difficulty) {
  const list = SCENARIOS?.[mode]?.[difficulty] || [];
  if (!list.length) return null;

  const key = `${mode}:${difficulty}`;
  const last = lastScenarioByKey.get(key);

  let pick = list[Math.floor(Math.random() * list.length)];
  if (list.length > 1 && pick.id === last) {
    pick = list.find(s => s.id !== last) || pick;
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
// Narrator (Twilio <Say>)
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
// Call Flow
// =========================================================

app.all("/voice", (req, res) => {
  const inner = gatherOneDigit({
    action: absUrl(req, "/menu"),
    promptText:
      "Sharpe Command Center. I. S. A. training system. " +
      "Choose your module. " +
      "Press 1 for M. 1. " +
      "Press 2 for M. C. D.",
    invalidText:
      "Invalid choice. Press 1 for M. 1. Press 2 for M. C. D."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/menu", (req, res) => {
  const digit = req.body.Digits;

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
    twiml(`${say("Invalid selection.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
  );
});

// -------------------- Gates (clarification ONCE) --------------------

app.post("/mcd-gate-prompt", (req, res) => {
  const inner = gatherOneDigit({
    action: absUrl(req, "/mcd-gate"),
    promptText:
      "M. C. D. — Mortgage Context Discovery. " +
      "Press 9 to continue.",
    invalidText:
      "Selection not confirmed. Press 9."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/mcd-gate", (req, res) => {
  if (req.body.Digits !== "9") {
    return res.type("text/xml").send(
      twiml(`${say("Gate not confirmed.")}<Redirect method="POST">${absUrl(req, "/mcd-gate-prompt")}</Redirect>`)
    );
  }

  res.type("text/xml").send(
    twiml(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=mcd")}</Redirect>`)
  );
});

app.post("/m1-gate-prompt", (req, res) => {
  const inner = gatherOneDigit({
    action: absUrl(req, "/m1-gate"),
    promptText:
      "M. 1. — Engagement and application. " +
      "Press 8 to continue.",
    invalidText:
      "Selection not confirmed. Press 8."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/m1-gate", (req, res) => {
  if (req.body.Digits !== "8") {
    return res.type("text/xml").send(
      twiml(`${say("Gate not confirmed.")}<Redirect method="POST">${absUrl(req, "/m1-gate-prompt")}</Redirect>`)
    );
  }

  res.type("text/xml").send(
    twiml(`<Redirect method="POST">${absUrl(req, "/difficulty-prompt?mode=m1")}</Redirect>`)
  );
});

// -------------------- Difficulty --------------------

app.post("/difficulty-prompt", (req, res) => {
  const mode = req.query.mode;

  const inner = gatherOneDigit({
    action: absUrl(req, `/difficulty?mode=${mode}`),
    promptText:
      "Choose difficulty. " +
      "Press 1 for standard. " +
      "Press 2 for moderate. " +
      "Press 3 for edge.",
    invalidText:
      "Invalid selection. Press 1, 2, or 3."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/difficulty", (req, res) => {
  const mode = req.query.mode;
  const digit = req.body.Digits;

  const difficulty =
    digit === "1" ? "Standard" :
    digit === "2" ? "Moderate" :
    digit === "3" ? "Edge" : null;

  if (!difficulty) {
    return res.type("text/xml").send(
      twiml(`${say("Invalid selection.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
    );
  }

  const scenario = pickScenario(mode, difficulty);
  if (!scenario) {
    return res.type("text/xml").send(
      twiml(`${say("No scenarios available.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
    );
  }

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
// (UNCHANGED — KEEP YOUR EXISTING WORKING CODE BELOW)
// =========================================================

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ⬇️ KEEP YOUR EXISTING WS + OPENAI REALTIME IMPLEMENTATION HERE ⬇️

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
