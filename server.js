const express = require("express");
const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// ====================
// Logging helpers
// ====================
function sid(req) {
  return req.body?.CallSid || "NO_CALL_SID";
}

function logEvent(event, req, extra = {}) {
  console.log(
    JSON.stringify({
      event,
      sid: sid(req),
      from: req.body?.From,
      to: req.body?.To,
      ...extra,
    })
  );
}

// ====================
// Scenario Definitions (Expanded)
// ====================
const SCENARIOS = {
  mcd: {
    Standard: [
      {
        id: "MCD-S-01",
        summary:
          "Borrower clicked an ad and is curious. They are friendly but vague and have not stated whether this is a purchase or refinance.",
        objective:
          "ISA must explicitly establish intent before any application request.",
      },
      {
        id: "MCD-S-02",
        summary:
          "Borrower says they are just looking and comparing options without committing.",
        objective:
          "ISA must avoid assuming intent and ask direct clarification questions.",
      },
      {
        id: "MCD-S-03",
        summary:
          "Borrower is researching online and unsure what they want yet.",
        objective:
          "ISA must classify intent correctly or leave it unclassified without pressure.",
      },
    ],
    Moderate: [
      {
        id: "MCD-M-01",
        summary:
          "Borrower is distracted and rushed, giving short answers.",
        objective:
          "ISA must slow the call and obtain explicit intent.",
      },
      {
        id: "MCD-M-02",
        summary:
          "Borrower mentions moving but gives unclear timing.",
        objective:
          "ISA must clarify whether real purchase intent exists.",
      },
      {
        id: "MCD-M-03",
        summary:
          "Borrower talks about payments without stating loan purpose.",
        objective:
          "ISA must separate curiosity from intent and avoid LO-only answers.",
      },
    ],
    Edge: [
      {
        id: "MCD-E-01",
        summary:
          "Borrower is anxious about credit and already spoke to another lender.",
        objective:
          "ISA must validate concern and still establish intent.",
      },
      {
        id: "MCD-E-02",
        summary:
          "Borrower challenges why questions are necessary.",
        objective:
          "ISA must maintain control and not bypass intent discovery.",
      },
      {
        id: "MCD-E-03",
        summary:
          "Borrower gives conflicting purchase vs refinance information.",
        objective:
          "ISA must resolve ambiguity or hold state correctly.",
      },
    ],
  },

  m1: {
    Standard: [
      {
        id: "M1-S-01",
        summary:
          "Borrower clearly wants to move forward and get pre-approved.",
        objective:
          "ISA must obtain explicit agreement to application or LO conversation.",
      },
      {
        id: "M1-S-02",
        summary:
          "Borrower agrees to proceed but asks what happens next.",
        objective:
          "ISA must explain next steps and confirm M1.",
      },
      {
        id: "M1-S-03",
        summary:
          "Borrower is cooperative and ready to start.",
        objective:
          "ISA must complete M1 cleanly without pressure.",
      },
    ],
    Moderate: [
      {
        id: "M1-M-01",
        summary:
          "Borrower hesitates due to credit concerns.",
        objective:
          "ISA must handle credit fear correctly and seek M1.",
      },
      {
        id: "M1-M-02",
        summary:
          "Borrower wants rates before committing.",
        objective:
          "ISA must defer LO-only questions and avoid handoff.",
      },
      {
        id: "M1-M-03",
        summary:
          "Borrower says yes but sounds uncertain.",
        objective:
          "ISA must confirm real agreement, not tone.",
      },
    ],
    Edge: [
      {
        id: "M1-E-01",
        summary:
          "Borrower demands numbers before agreeing.",
        objective:
          "ISA must defer LO-only questions and protect LO.",
      },
      {
        id: "M1-E-02",
        summary:
          "Borrower insists on speaking with LO immediately.",
        objective:
          "ISA must avoid unauthorized LO handoff.",
      },
      {
        id: "M1-E-03",
        summary:
          "Borrower verbally agrees but refuses application.",
        objective:
          "ISA must record non-consent and avoid false M1.",
      },
    ],
  },
};

function pickScenario(mode, difficulty) {
  const bucket = SCENARIOS?.[mode]?.[difficulty] || [];
  return bucket[Math.floor(Math.random() * bucket.length)];
}

// ====================
// Health + Version
// ====================
app.get("/", (req, res) => res.send("OK"));

app.get("/version", (req, res) =>
  res.send("scc-isa-voice v0.6 expanded-scenarios + google-voice")
);

// ====================
// Call Entry
// ====================
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("CALL_START", req);

  res.type("text/xml").send(`
<Response>
  <Gather numDigits="1" action="${baseUrl}/menu" method="POST">
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      Welcome to SCC ISA training.
      Press 1 for M1.
      Press 2 for MCD.
    </Say>
  </Gather>
</Response>`);
});

app.post("/menu", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = req.body?.Digits;
  logEvent("MENU", req, { digit });

  const next = digit === "1" ? "/m1" : digit === "2" ? "/mcd" : "/voice";

  res.type("text/xml").send(`
<Response>
  <Redirect method="POST">${baseUrl}${next}</Redirect>
</Response>`);
});

// ====================
// Gates
// ====================
app.post("/mcd", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("MCD_GATE_PROMPT", req);

  res.type("text/xml").send(`
<Response>
  <Gather numDigits="1" action="${baseUrl}/mcd/gate" method="POST">
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      To begin MCD training, press 9.
    </Say>
  </Gather>
</Response>`);
});

app.post("/mcd/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const pass = req.body?.Digits === "9";
  logEvent("MCD_GATE", req, { pass });

  res.type("text/xml").send(`
<Response>
  <Redirect method="POST">${baseUrl}/${pass ? "difficulty?mode=mcd" : "mcd"}</Redirect>
</Response>`);
});

app.post("/m1", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("M1_GATE_PROMPT", req);

  res.type("text/xml").send(`
<Response>
  <Gather numDigits="1" action="${baseUrl}/m1/gate" method="POST">
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      To begin M1 training, press 8.
    </Say>
  </Gather>
</Response>`);
});

app.post("/m1/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const pass = req.body?.Digits === "8";
  logEvent("M1_GATE", req, { pass });

  res.type("text/xml").send(`
<Response>
  <Redirect method="POST">${baseUrl}/${pass ? "difficulty?mode=m1" : "m1"}</Redirect>
</Response>`);
});

// ====================
// Difficulty + Scenario
// ====================
app.post("/difficulty", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const mode = req.query.mode;
  logEvent("DIFFICULTY_PROMPT", req, { mode });

  res.type("text/xml").send(`
<Response>
  <Gather numDigits="1" action="${baseUrl}/scenario?mode=${mode}" method="POST">
    <Say voice="Google.en-US-Chirp3-HD-Aoede">
      Press 1 for Standard.
      Press 2 for Moderate.
      Press 3 for Edge.
    </Say>
  </Gather>
</Response>`);
});

app.post("/scenario", (req, res) => {
  const mode = req.query.mode;
  const digit = req.body?.Digits;
  const difficulty = digit === "1" ? "Standard" : digit === "2" ? "Moderate" : "Edge";
  const scenario = pickScenario(mode, difficulty);

  logEvent("SCENARIO_LOADED", req, {
    mode,
    difficulty,
    scenarioId: scenario.id,
  });

  res.type("text/xml").send(`
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Scenario loaded.
    ${scenario.summary}
    Objective.
    ${scenario.objective}
  </Say>
</Response>`);
});

// ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
