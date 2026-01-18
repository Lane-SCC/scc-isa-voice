const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// Twilio posts x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));

// ====================
// Config
// ====================
const TTS_VOICE = "Google.en-US-Chirp3-HD-Aoede";
const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");

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
// XML / SSML helpers
// ====================
function xmlEscape(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Force acronyms like ISA to be spoken as letters.
function injectAcronyms(escapedText) {
  return escapedText.replace(
    /\bISA\b/g,
    `<say-as interpret-as="characters">ISA</say-as>`
  );
}

function saySsml(text) {
  const escaped = xmlEscape(text);
  const withAcronyms = injectAcronyms(escaped);
  return `<Say voice="${TTS_VOICE}"><speak>${withAcronyms}</speak></Say>`;
}

// ====================
// Load scenarios.json (governed content store)
// ====================
function loadScenarios() {
  try {
    const raw = fs.readFileSync(SCENARIOS_PATH, "utf8");
    const data = JSON.parse(raw);

    // Minimal shape check (don’t over-engineer)
    if (!data?.mcd || !data?.m1) {
      throw new Error("scenarios.json missing required top-level keys: mcd, m1");
    }

    console.log(
      JSON.stringify({
        event: "SCENARIOS_LOADED",
        path: SCENARIOS_PATH,
      })
    );

    return data;
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "SCENARIOS_LOAD_FAILED",
        path: SCENARIOS_PATH,
        error: String(err?.message || err),
      })
    );

    // Fail-safe: empty buckets so app still runs and you see the error clearly
    return {
      mcd: { Standard: [], Moderate: [], Edge: [] },
      m1: { Standard: [], Moderate: [], Edge: [] },
    };
  }
}

let SCENARIOS = loadScenarios();

// No-immediate-repeat memory (per mode+difficulty). Resets on deploy/restart.
const lastScenarioByKey = {};

function pickScenarioNoRepeat(mode, difficulty) {
  const bucket = SCENARIOS?.[mode]?.[difficulty] || [];
  if (bucket.length === 0) return null;
  if (bucket.length === 1) return bucket[0];

  const key = `${mode}:${difficulty}`;
  const lastId = lastScenarioByKey[key];

  let choice = null;
  for (let i = 0; i < 6; i++) {
    const candidate = bucket[Math.floor(Math.random() * bucket.length)];
    if (candidate.id !== lastId) {
      choice = candidate;
      break;
    }
    choice = candidate; // fallback if we keep hitting the same
  }

  lastScenarioByKey[key] = choice.id;
  return choice;
}

// ====================
// Health + Version
// ====================
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/version", (req, res) =>
  res
    .status(200)
    .send("scc-isa-voice v0.9 scenarios.json + no-repeat + SSML ISA + borrower greeting")
);

// Optional: quick sanity check that scenarios are present
app.get("/scenarios/status", (req, res) => {
  const counts = {
    mcd: {
      Standard: SCENARIOS?.mcd?.Standard?.length || 0,
      Moderate: SCENARIOS?.mcd?.Moderate?.length || 0,
      Edge: SCENARIOS?.mcd?.Edge?.length || 0,
    },
    m1: {
      Standard: SCENARIOS?.m1?.Standard?.length || 0,
      Moderate: SCENARIOS?.m1?.Moderate?.length || 0,
      Edge: SCENARIOS?.m1?.Edge?.length || 0,
    },
  };
  res.status(200).json(counts);
});

// ====================
// Call Entry
// ====================
app.post("/voice", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("CALL_START", req);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${baseUrl}/menu" method="POST">
    ${saySsml("Welcome to SCC ISA training. Press 1 for M1. Press 2 for MCD.")}
  </Gather>
</Response>`);
});

app.post("/menu", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const digit = req.body?.Digits;
  logEvent("MENU", req, { digit });

  const next = digit === "1" ? "/m1" : digit === "2" ? "/mcd" : "/voice";

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
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

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/mcd/gate" method="POST">
    ${saySsml("To begin MCD training, press 9.")}
  </Gather>
</Response>`);
});

app.post("/mcd/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const pass = req.body?.Digits === "9";
  logEvent("MCD_GATE", req, { pass });

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${baseUrl}/${pass ? "difficulty?mode=mcd" : "mcd"}</Redirect>
</Response>`);
});

app.post("/m1", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  logEvent("M1_GATE_PROMPT", req);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/m1/gate" method="POST">
    ${saySsml("To begin M1 training, press 8.")}
  </Gather>
</Response>`);
});

app.post("/m1/gate", (req, res) => {
  const baseUrl = `https://${req.get("host")}`;
  const pass = req.body?.Digits === "8";
  logEvent("M1_GATE", req, { pass });

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
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

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${baseUrl}/scenario?mode=${mode}" method="POST">
    ${saySsml("Press 1 for Standard. Press 2 for Moderate. Press 3 for Edge.")}
  </Gather>
</Response>`);
});

app.post("/scenario", (req, res) => {
  const mode = req.query.mode; // "mcd" or "m1"
  const digit = req.body?.Digits;

  const difficulty =
    digit === "1"
      ? "Standard"
      : digit === "2"
      ? "Moderate"
      : digit === "3"
      ? "Edge"
      : null;

  if (!mode || (mode !== "mcd" && mode !== "m1")) {
    logEvent("SCENARIO_INVALID_MODE", req, { mode });
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Invalid mode. Goodbye.")}
  <Hangup/>
</Response>`);
  }

  if (!difficulty) {
    logEvent("SCENARIO_INVALID_DIFFICULTY", req, { mode, digit });
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("Invalid selection. Goodbye.")}
  <Hangup/>
</Response>`);
  }

  // (Optional) Reload on each scenario request if you want “hot edits” without redeploy.
  // Commented out to keep behavior stable.
  // SCENARIOS = loadScenarios();

  const scenario = pickScenarioNoRepeat(mode, difficulty);

  logEvent("SCENARIO_LOADED", req, {
    mode,
    difficulty,
    scenarioId: scenario?.id || null,
    borrowerName: scenario?.borrowerName || null,
    borrowerGender: scenario?.borrowerGender || null,
  });

  if (!scenario) {
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml("No scenarios found for this selection. Please contact the administrator.")}
  <Hangup/>
</Response>`);
  }

  const summary = scenario.summary || "Scenario unavailable.";
  const objective = scenario.objective || "Objective unavailable.";
  const borrowerName = scenario.borrowerName || "Borrower";

  // Narrator gives brief + objective, then borrower answers by name, then pause for training.
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${saySsml(`Scenario loaded. ${summary} Primary objective. ${objective}`)}
  ${saySsml("You are now connected.")}
  ${saySsml(`Hello, this is ${borrowerName}.`)}
  <Pause length="300"/>
  ${saySsml("Session ended.")}
</Response>`);
});

// ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
