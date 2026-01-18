const express = require("express");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// Optional health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Incoming call handler (Twilio hits this URL)
app.post("/voice", (req, res) => {
  // Build absolute base URL (required for Gather action)
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

// Handles DTMF selection
app.post("/menu", (req, res) => {
  const digit = (req.body && req.body.Digits) ? String(req.body.Digits) : "";

  let message;
  if (digit === "1") message = "You selected M1 scenario. Goodbye.";
  else if (digit === "2") message = "You selected MCD scenario. Goodbye.";
  else message = "Invalid selection. Goodbye.";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${message}</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
