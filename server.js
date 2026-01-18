const express = require("express");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Optional health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Incoming call handler (Twilio hits this URL)
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const baseUrl = `https://${host}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/menu" method="POST">
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

// Placeholder endpoints so the call doesn't drop
app.post("/mcd", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">MCD scenario placeholder. Borrower simulation will begin here.</Say>
  <Pause length="60"/>
  <Say voice="alice">Session ended.</Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/m1", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">M1 scenario placeholder. Borrower simulation will begin here.</Say>
  <Pause length="60"/>
  <Say voice="alice">Session ended.</Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
