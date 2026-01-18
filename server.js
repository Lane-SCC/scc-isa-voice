const express = require("express");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Version stamp
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v0.2 gates-only (MCD=9, M1=8)")
);

// Incoming call handler (Twilio hits this URL)
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;

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

// Handles DTMF selection and routes to the next step
app.post("/menu", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;
  const digit = req.body?.Digits ? String(req.body.Digits) : "";

  let nextPath;
  if (digit === "1") nextPath = "/m1";
  else if (digit === "2") nextPath = "/mcd";
  else nextPath = "/voice"; // replay menu if invalid

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Training will begin shortly.</Say>
  <Redirect method="POST">${baseUrl}${nextPath}</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

/**
 * Gate screens
 * - MCD gate code: 9
 * - M1 gate code: 8
 *
 * Until we add OpenAI realtime speech, DTMF is the reliable way to enforce
 * "say the gate phrase" without guessing.
 */

// MCD gate screen
app.post("/mcd", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/mcd/gate" method="POST">
    <Say voice="alice">
      M C D training gate.
      To begin, you must say: Provide me an M C D practice scenario.
      For now, confirm by pressing 9.
    </Say>
  </Gather>
  <Say voice="alice">Gate not confirmed. Returning to the main menu.</Say>
  <Redirect method="POST">${baseUrl}/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// MCD gate evaluator
app.post("/mcd/gate", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;
  const digit = req.body?.Digits ? String(req.body.Digits) : "";

  if (digit !== "9") {
    const twimlFail = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Gate failed. Training will not start.</Say>
  <Redirect method="POST">${baseUrl}/mcd</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlFail);
  }

  // "Training start" placeholder — keep call open
  const twimlPass = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Gate confirmed. M C D training is now active.</Say>
  <Say voice="alice">Borrower simulation will be added in the next phase.</Say>
  <Pause length="60"/>
  <Say voice="alice">Session ended.</Say>
</Response>`;

  res.type("text/xml").send(twimlPass);
});

// M1 gate screen
app.post("/m1", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/m1/gate" method="POST">
    <Say voice="alice">
      M 1 training gate.
      To begin, you must say: Provide me an M 1 practice scenario.
      For now, confirm by pressing 8.
    </Say>
  </Gather>
  <Say voice="alice">Gate not confirmed. Returning to the main menu.</Say>
  <Redirect method="POST">${baseUrl}/voice</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// M1 gate evaluator
app.post("/m1/gate", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;
  const digit = req.body?.Digits ? String(req.body.Digits) : "";

  if (digit !== "8") {
    const twimlFail = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Gate failed. Training will not start.</Say>
  <Redirect method="POST">${baseUrl}/m1</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlFail);
  }

  // "Training start" placeholder — keep call open
  const twimlPass = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Gate confirmed. M 1 training is now active.</Say>
  <Say voice="alice">Borrower simulation will be added in the next phase.</Say>
  <Pause length="60"/>
  <Say voice="alice">Session ended.</Say>
</Response>`;

  res.type("text/xml").send(twimlPass);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
