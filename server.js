const express = require("express");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// -------- Logging helpers --------
function sid(req) {
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

// -------- Scenario Definitions (v5) --------
// These are "case files" (not scripts). They define borrower context + objective.
// Keep them short and deterministic. We can expand later.
const SCENARIOS = {
  mcd: {
    Standard: [
      {
        id: "MCD-S-01",
        summary:
          "Borrower clicked an ad and is curious. They are friendly but vague. They haven't clearly stated whether this is a purchase or refinance.",
        objective:
          "ISA must explicitly establish intent (purchase/refi/heloc) before any application request.",
      },
    ],
    Moderate: [
      {
        id: "MCD-M-01",
        summary:
          "Borrower is busy and distracted. They give short answers and try to rush off the phone. They may be moving soon but haven't confirmed anything.",
        objective:
          "ISA must slow down, ask direct intent questions, and avoid guessing or pushing application early.",
      },
    ],
    Edge: [
      {
        id: "MCD-E-01",
        summary:
          "Borrower is anxious about credit and says they already talked to another lender. They are defensive and avoid committing to intent.",
        objective:
          "ISA must avoid LO-only answers, validate concern, and still obtain explicit intent before attempting application.",
      },
    ],
  },

  m1: {
    Standard: [
      {
        id: "M1-S-01",
        summary:
          "Borrower clearly said they want to move forward and get pre-approved. They are cooperative and ready to take next steps.",
        objective:
          "ISA must obtain explicit M1 agreement: borrower clearly agrees to application or to speak with LO (per rules).",
      },
    ],
    Moderate: [
      {
        id: "M1-M-01",
        summary:
          "Borrower says they want to move forward but hesitates on the application. They ask if it will hurt credit and want reassurance.",
        objective:
          "ISA must handle credit-pull fear correctly (no advice, no rates), and still seek explicit M1 agreement.",
      },
    ],
    Edge: [
      {
        id: "M1-E-01",
        summary:
          "Borrower is suspicious and wants rates/payment quotes before doing anything. They press for details and resist committing.",
        objective:
          "ISA must defer LO-only questions properly and avoid unauthorized LO handoff without an application attempt.",
      },
    ],
  },
};

function pickScenario(mode, difficulty) {
  const bucket = SCENARIOS?.[mode]?.[difficulty] || [];
  if (bucket.length === 0) return null;
  const i = Math.floor(Math.random() * bucket.length);
  return bucket[i];
}

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Version stamp
app.get("/version", (req, res) =>
  res.status(200).send("scc-isa-voice v0.5 scenario-definitions")
);

// ---------- ENTRY ----------

// Incoming call handler
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;

  logEvent("CALL_START", req);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${baseUrl}/menu" method="POST">
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      Welcome to SCC ISA training.
      Press 1 for M1 scenario.
      Press 2 for MCD scenario.
    </Say>
  </Gather>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">No input received. Goodbye.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Menu selection
app.post("/menu", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = String(req.body?.Digits || "");

  logEvent("MENU", req, { digits: digit });

  const nextPath = digit === "1" ? "/m1" : digit === "2" ? "/mcd" : "/voice";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Training will begin shortly.</Say>
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
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
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
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Gate failed.</Say>
  <Redirect method="POST">${baseUrl}/mcd</Redirect>
</Response>`);
  }

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Gate confirmed.</Say>
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
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
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
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Gate failed.</Say>
  <Redirect method="POST">${baseUrl}/m1</Redirect>
</Response>`);
  }

  res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Gate confirmed.</Say>
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
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
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

// ---------- SCENARIO BRIEF (now scenario-defined) ----------

app.post("/scenario", (req, res) => {
  const mode = req.query.mode || "mcd";
  const digit = String(req.body?.Digits || "");

  const difficulty =
    digit === "1"
      ? "Standard"
      : digit === "2"
      ? "Moderate"
      : digit === "3"
      ? "Edge"
      : null;

  if (!difficulty) {
    logEvent("SCENARIO_SELECT", req, { mode, digits: digit, difficulty: null });
    return res.type("text/xml").send(`<?xml version="1.0"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">Invalid selection.</Say>
  <Hangup/>
</Response>`);
  }

  const scenario = pickScenario(mode, difficulty);

  logEvent("SCENARIO_LOADED", req, {
    mode,
    digits: digit,
    difficulty,
    scenarioId: scenario?.id || null,
  });

  const summary = scenario?.summary || "Scenario unavailable.";
  const objective = scenario?.objective || "Objective unavailable.";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    ${mode.toUpperCase()} scenario loaded.
    Difficulty: ${difficulty}.
    Scenario I D: ${scenario?.id || "unknown"}.
  </Say>

  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Scenario brief:
    ${summary}
  </Say>

  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Primary objective:
    ${objective}
  </Say>

  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Reminder:
    Do not assume intent.
    Application before intent is an automatic failure.
    Loan officer handoff without application attempt is an automatic failure.
    Coaching occurs only after end call.
  </Say>

  <Pause length="30"/>

  <Say voice="Google.en-US-Chirp3-HD-Aoede">Session ended.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
