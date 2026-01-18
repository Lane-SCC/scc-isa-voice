const express = require("express");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// -------- Logging helpers --------
function sid(req) {
  // Twilio sends CallSid in webhook POST body
  return req.body?.CallSid || "NO_CALL_SID";
}

function logEvent(event, req, extra = {}) {
  const payload = {
    event,
    sid: sid(req),
    from: req.body?.From,
    to: req.body?.To,
    ...extra,
  };
  console.log(JSON.stringify(payload));
}

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Version stamp
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v0.4 logging")
);

// ---------- ENTRY ----------

// Incoming call handler
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;

  logEvent("CALL_START", req);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${baseUrl}/menu" method="POST">
    <Say voice="alice">
      Welcome to SCC ISA training.
      Press 1 for M1 scenario.
      Press 2 for MCD scenario.
    </Say>
  </Gather>
  <Say voice="alice">No input received. Goodbye.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Menu selection
app.post("/menu", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = String(req.body?.Digits || "");

  logEvent("MENU", req, { digits: digit });

  const nextPath =
    digit === "1" ? "/m1" :
    digit === "2" ? "/mcd" :
    "/voice";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Training will begin shortly.</Say>
  <Redirect method="POST">${baseUrl}${nextPath}</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- GATES ----------

// MCD gate screen
app.post("/mcd", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;

  logEvent("MCD_GATE_PROMPT", req);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/mcd/gate" method="POST">
    <Say voice="alice">
      M C D training gate.
      To begin, say: Provide me an M C D practice scenario.
      For now, confirm by pressing 9.
    </Say>
  </Gather>
  <Redirect method="POST">${baseUrl}/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// MCD gate evaluator
app.post("/mcd/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = String(req.body?.Digits || "");
  const pass = digit === "9";

  logEvent("MCD_GATE", req, { digits: digit, pass });

  if (!pass) {
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="alice">Gate failed.</Say>
  <Redirect method="POST">${baseUrl}/mcd</Redirect>
</Response>`);
  }

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="alice">Gate confirmed.</Say>
  <Redirect method="POST">${baseUrl}/difficulty?mode=mcd</Redirect>
</Response>`);
});

// M1 gate screen
app.post("/m1", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;

  logEvent("M1_GATE_PROMPT", req);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/m1/gate" method="POST">
    <Say voice="alice">
      M 1 training gate.
      To begin, say: Provide me an M 1 practice scenario.
      For now, confirm by pressing 8.
    </Say>
  </Gather>
  <Redirect method="POST">${baseUrl}/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// M1 gate evaluator
app.post("/m1/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = String(req.body?.Digits || "");
  const pass = digit === "8";

  logEvent("M1_GATE", req, { digits: digit, pass });

  if (!pass) {
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="alice">Gate failed.</Say>
  <Redirect method="POST">${baseUrl}/m1</Redirect>
</Response>`);
  }

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="alice">Gate confirmed.</Say>
  <Redirect method="POST">${baseUrl}/difficulty?mode=m1</Redirect>
</Response>`);
});

// ---------- DIFFICULTY SELECTOR ----------

app.post("/difficulty", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const mode = req.query.mode || "mcd";

  logEvent("DIFFICULTY_PROMPT", req, { mode });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/scenario?mode=${mode}" method="POST">
    <Say voice="alice">
      Select difficulty.
      Press 1 for Standard.
      Press 2 for Moderate.
      Press 3 for Edge.
    </Say>
  </Gather>
  <Redirect method="POST">${baseUrl}/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- SCENARIO BRIEF ----------

app.post("/scenario", (req, res) => {
  const mode = req.query.mode || "mcd";
  const digit = String(req.body?.Digits || "");

  const difficulty =
    digit === "1" ? "Standard" :
    digit === "2" ? "Moderate" :
    digit === "3" ? "Edge" :
    null;

  logEvent("SCENARIO_SELECT", req, { mode, digits: digit, difficulty });

  if (!difficulty) {
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="alice">Invalid selection.</Say>
  <Hangup/>
</Response>`);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    ${mode.toUpperCase()} scenario loaded.
    Difficulty: ${difficulty}.
  </Say>

  <Say voice="alice">
    Reminder:
    Do not assume intent.
    Application before intent is an automatic failure.
    Loan officer handoff without application attempt is an automatic failure.
    Coaching occurs only after end call.
  </Say>

  <Pause length="30"/>

  <Say voice="alice">Session ended.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
