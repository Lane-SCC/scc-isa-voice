// Incoming call handler (Twilio hits this URL)
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;

  const twiml = `
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

  res.type("text/xml");
  res.send(twiml);
});
