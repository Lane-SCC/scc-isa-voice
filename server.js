import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check (Render requires this)
app.get("/", (req, res) => {
  res.send("SCC ISA voice relay running");
});

// Incoming call handler (Twilio hits this URL)
app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Gather numDigits="1" action="/menu" method="POST">
    <Say voice="alice">
      Welcome to SCC ISA training.
      Press 1 for M1 scenario.
      Press 2 for MCD scenario.
    </Say>
  </Gather>
  <Say voice="alice">No input received. Goodbye.</Say>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// Menu selection
app.post("/menu", (req, res) => {
  const digit = req.body.Digits;

  let message = "Invalid selection. Goodbye.";

  if (digit === "1") {
    message = "M1 scenario selected. Training will begin shortly.";
  } else if (digit === "2") {
    message = "MCD scenario selected. Training will begin shortly.";
  }

  const twiml = `
<Response>
  <Say voice="alice">${message}</Say>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
