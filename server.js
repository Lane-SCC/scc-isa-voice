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

// ---------- Load scenarios.json ----------
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
let SCENARIOS = null;

function loadScenarios() {
  const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
  SCENARIOS = JSON.parse(raw);
  console.log(JSON.stringify({ event: "SCENARIOS_LOADED", path: SCENARIOS_PATH }));
}
loadScenarios();

// ---------- Helpers ----------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// IMPORTANT: Twilio-supported voice ONLY
function twimlSay(text) {
  return `<Say voice="Polly.Joanna">${xmlEscape(text)}</Say>`;
}

function absUrl(req, p) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v1.0 AI bridge (Twilio Stream + OpenAI Realtime)")
);

// ---------- /voice ----------
app.post("/voice", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "CALL_START", sid }));

  const action = absUrl(req, "/menu");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="8">
    ${twimlSay("Welcome to S C C I S A training. Press 1 for M 1 scenario. Press 2 for M C D scenario.")}
  </Gather>
  ${twimlSay("Invalid choice. Press 1 for M 1. Press 2 for M C D.")}
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

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${next}</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Gates ----------
app.post("/mcd-gate", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "MCD_GATE_PROMPT", sid }));

  const action = absUrl(req, "/difficulty?mode=mcd");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="${action}" method="POST">
    ${twimlSay("M C D gate. Press 9 to proceed.")}
  </Gather>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/m1-gate", (req, res) => {
  const sid = req.body.CallSid;
  console.log(JSON.stringify({ event: "M1_GATE_PROMPT", sid }));

  const action = absUrl(req, "/difficulty?mode=m1");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="${action}" method="POST">
    ${twimlSay("M 1 gate. Press 8 to proceed.")}
  </Gather>
</Response>`;

  res.type("text/xml").send(twiml);
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

  if (!difficulty) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response><Redirect method="POST">${back}</Redirect></Response>`);
  }

  const scenario = SCENARIOS?.[mode]?.[difficulty]?.[0];
  if (!scenario) {
    const back = absUrl(req, "/voice");
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response><Redirect method="POST">${back}</Redirect></Response>`);
  }

  console.log(JSON.stringify({
    event: "SCENARIO_LOADED",
    sid,
    mode,
    difficulty,
    scenarioId: scenario.id
  }));

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const streamUrl = `wss://${host}/twilio`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${twimlSay(`Scenario. ${scenario.summary}`)}
  ${twimlSay(`Primary objective. ${scenario.objective}`)}
  ${twimlSay("You are now connected. The borrower will answer first.")}

  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="borrowerName" value="${scenario.borrowerName}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- WebSocket bridge ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/twilio")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (twilioWs) => {
  twilioWs.on("message", () => {});
  twilioWs.on("close", () => console.log("TWILIO_WS_CLOSE"));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
