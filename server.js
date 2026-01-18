const express = require("express");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Version stamp
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v0.3 gates+dtmf-scenarios")
);

// ---------- ENTRY ----------

// Incoming call handler
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;

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

  if (digit !== "9") {
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

  if (digit !== "8") {
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

  <Pause length="90"/>

  <Say voice="alice">Session ended.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- START ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
