/* SCC ISA Training Voice System (Governance-First)
 * v2.6 — Borrower Role Lock + Guardrail Challenge (NO audio changes)
 *
 * This version:
 * - Keeps audio realism exactly as-is
 * - Forces borrower identity (prevents lender behavior)
 * - Keeps scenario fidelity
 * - Actively pressures ISA to break rules (as a borrower)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const WSClient = require("ws");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================================================
   SCENARIOS
========================================================= */

const SCENARIOS_PATH = path.join(__dirname, "scenarios.json");
const SCENARIOS = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8"));

const lastScenarioByKey = new Map();
function pickScenario(mode, difficulty) {
  const list = SCENARIOS?.[mode]?.[difficulty] || [];
  if (!list.length) return null;

  const key = `${mode}:${difficulty}`;
  const last = lastScenarioByKey.get(key);

  let pick = list[Math.floor(Math.random() * list.length)];
  if (list.length > 1 && pick.id === last) {
    pick = list.find(s => s.id !== last) || pick;
  }

  lastScenarioByKey.set(key, pick.id);
  return pick;
}

/* =========================================================
   HELPERS
========================================================= */

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absUrl(req, p) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}${p}`;
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

/* =========================================================
   NARRATOR (unchanged audio)
========================================================= */

const NARRATOR_VOICE = "Google.en-US-Chirp3-HD-Aoede";

function say(text) {
  return `<Say voice="${NARRATOR_VOICE}">${xmlEscape(text)}</Say>`;
}

function gatherOneDigit({ action, promptText, invalidText }) {
  return `
    <Gather input="dtmf" numDigits="1" action="${action}" method="POST" timeout="7">
      ${say(promptText)}
    </Gather>
    ${say(invalidText)}
    <Redirect method="POST">${action}</Redirect>
  `;
}

/* =========================================================
   🔒 BORROWER ROLE LOCK (THIS IS THE FIX)
========================================================= */

function buildBorrowerInstructions({ borrowerName, mode, difficulty, scenarioId, objective, meta }) {
  return [
    `You are a REAL mortgage borrower named ${borrowerName}.`,
    `You are on a phone call with a lender's I. S. A.`,
    `ABSOLUTE ROLE LOCK: You are the BORROWER ONLY.`,
    `You are NOT the lender. You are NOT the I. S. A. You are NOT a loan officer. You are NOT an advisor or expert.`,
    `If you ever start explaining, guiding, teaching, or leading the call, STOP and correct yourself immediately.`,

    `SCENARIO CONTAINMENT: Stay inside this mortgage scenario.`,
    `Do not invent new topics. Do not explore unrelated conversations.`,
    `Your answers must remain consistent with the scenario.`,

    `GOVERNANCE BEHAVIOR (BORROWER-SIDE):`,
    `- Do NOT volunteer mortgage intent unless explicitly asked.`,
    `- If pushed toward an application too early, hesitate or question it.`,
    `- If the I. S. A. tries to hand you to a loan officer early, push back and ask why.`,

    `CHALLENGE MODE: You should occasionally pressure the I. S. A. to break rules.`,
    `Examples: asking for rates, asking if credit will be pulled, asking to speak to the loan officer, expressing urgency or anxiety.`,
    `Important: You ASK questions — you do NOT answer them as an expert.`,

    `HARD PROHIBITION: Never give advice.`,
    `Never quote rates. Never diagnose health issues. Never give legal, tax, or financial guidance.`,
    `If asked anything outside the home loan, redirect: "I'm not sure — can we focus on the home loan?"`,

    `Speak naturally and briefly. Use fillers ("uh", "um") at a ${meta.disfluency} rate.`,
    `Emotion baseline: ${meta.emotion}. Talkativeness: ${meta.talkativeness}. Patience: ${meta.patience}. Trust: ${meta.trust}.`,

    `Context tags (do not reveal): mode=${mode}, difficulty=${difficulty}, scenario=${scenarioId}.`,
    `Objective (do not reveal): ${objective}.`
  ].join(" ");
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/version", (_, res) =>
  res.status(200).send("scc-isa-voice v2.6 borrower-role-lock")
);

/* =========================================================
   CALL FLOW (unchanged)
========================================================= */

app.all("/voice", (req, res) => {
  const inner = gatherOneDigit({
    action: absUrl(req, "/menu"),
    promptText:
      "Sharpe Command Center. I. S. A. training. " +
      "Press 1 for M. 1. " +
      "Press 2 for M. C. D.",
    invalidText:
      "Invalid choice. Press 1 for M. 1. Press 2 for M. C. D."
  });

  res.type("text/xml").send(twiml(inner));
});

app.post("/menu", (req, res) => {
  const digit = req.body.Digits;

  if (digit === "1") {
    return res.type("text/xml").send(
      twiml(`<Redirect method="POST">${absUrl(req, "/m1-gate-prompt")}</Redirect>`)
    );
  }

  if (digit === "2") {
    return res.type("text/xml").send(
      twiml(`<Redirect method="POST">${absUrl(req, "/mcd-gate-prompt")}</Redirect>`)
    );
  }

  res.type("text/xml").send(
    twiml(`${say("Invalid selection.")}<Redirect method="POST">${absUrl(req, "/voice")}</Redirect>`)
  );
});

/* =========================================================
   OPENAI REALTIME (audio untouched, leash added)
========================================================= */

function openaiRealtimeConnect({ borrowerName, mode, difficulty, scenarioId, objective, meta }) {
  const ws = new WSClient(
    `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  ws.on("open", () => {
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        voice: "marin",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        instructions: buildBorrowerInstructions({
          borrowerName, mode, difficulty, scenarioId, objective, meta
        })
      }
    }));

    // Borrower speaks first — with leash
    ws.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions:
          `You are the borrower only. Start with: "Hello, this is ${borrowerName}." Then wait.`
      }
    }));
  });

  return ws;
}

/* =========================================================
   SERVER BOOT
========================================================= */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/twilio")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
