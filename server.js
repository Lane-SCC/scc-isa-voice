/* SCC ISA Training Voice System (Governance-First)
 * Phase: SCC + ISA call flow stabilization
 * Twilio Voice (DTMF) only — no AI bridge yet
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- Load scenarios ----------
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
const SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8"));
console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));

// ---------- Helpers ----------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// SSML-enabled Twilio Say (forces spelling)
function twimlSay(ssml) {
  return `<Say voice="Polly.Joanna"><speak>${ssml}</speak></Say>`;
}

function absUrl(req, p) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

// ---------- Health ----------
app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) =>
  res.send("scc-isa-voice v1.1 SSML stabilized")
);

// ---------- /voice ----------
app.post("/voice", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "CALL_START", sid }));

  const action = absUrl(req, "/menu");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
    ${twimlSay(
      'Welcome to <say-as interpret-as="characters">SCC</say-as> ' +
      '<say-as interpret-as="characters">ISA</say-as> training. ' +
      'Press 1 for <say-as interpret-as="characters">M1</say-as> scenario. ' +
      'Press 2 for <say-as interpret-as="characters">MCD</say-as> scenario.'
    )}
  </Gather>

  ${twimlSay(
    'Invalid choice. Press 1 for <say-as interpret-as="characters">M1</say-as>. ' +
    'Press 2 for <say-as interpret-as="characters">MCD</say-as>.'
  )}

  <Redirect method="POST">${action}</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- /menu ----------
app.post("/menu", (req, res) => {
  const sid = req.body.CallSid;
  const digit = (req.body.Digits || "").trim();
  console.log(JSON.stringify({ event: "MENU", sid, digit }));

  let next;
  if (digit === "1") next = absUrl(req, "/m1-gate");
  else if (digit === "2") next = absUrl(req, "/mcd-gate");
  else next = absUrl(req, "/voice");

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Redirect method="POST">${next}</Redirect>
</Response>`);
});

// ---------- MCD Gate ----------
app.post("/mcd-gate", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const action = absUrl(req, "/difficulty?mode=mcd");

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="${action}" method="POST">
    ${twimlSay(
      '<say-as interpret-as="characters">MCD</say-as> gate. Press 9 to proceed.'
    )}
  </Gather>
</Response>`);
});

// ---------- M1 Gate ----------
app.post("/m1-gate", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));

  const action = absUrl(req, "/difficulty?mode=m1");

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="${action}" method="POST">
    ${twimlSay(
      '<say-as interpret-as="characters">M1</say-as> gate. Press 8 to proceed.'
    )}
  </Gather>
</Response>`);
});

// ---------- Difficulty ----------
app.post("/difficulty", (req, res) => {
  const sid = req.body.CallSid;
  const mode = req.query.mode;
  const digit = (req.body.Digits || "").trim();

  const difficulty =
    digit === "1" ? "Standard" :
    digit === "2" ? "Moderate" :
    digit === "3" ? "Edge" : null;

  if (!difficulty || !SCENARIOS[mode]?.[difficulty]?.length) {
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Redirect method="POST">${absUrl(req, "/voice")}</Redirect>
</Response>`);
  }

  const scenario = SCENARIOS[mode][difficulty][0];

  console.log(JSON.stringify({
    event: "SCENARIO_LOADED",
    sid,
    mode,
    difficulty,
    scenarioId: scenario.id
  }));

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  ${twimlSay(`Scenario. ${xmlEscape(scenario.summary)}`)}
  ${twimlSay(`Primary objective. ${xmlEscape(scenario.objective)}`)}
  ${twimlSay("You are now connected. The borrower will answer first.")}
</Response>`);
});

// ---------- Boot ----------
const PORT = process.env.PORT || 10000;
http.createServer(app).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
