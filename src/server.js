"use strict";
/**
 * Agent Games — Proof Gatekeeper agent endpoint.
 *
 * Flow per request: read raw body -> verify platform HMAC -> route:
 * - agent-games.preflight.v1        -> { ok: true, protocolVersion: "v1" }
 * - agent-games.proof-gatekeeper.v1 -> decide (deterministic) -> prove the
 *   decision with the gatekeeper circuit -> respond signed. A proof failure
 *   never fails the task: the response falls back to decision-only.
 * Every response is signed with the same HMAC secret.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { HEADER, sign, verify } = require("./hmac");
const { parseTask, decide, REASONS } = require("./decision");
const { prove } = require("./circuit");

const SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "";
const PORT = Number(process.env.PORT || 8787);
const PROOF_BUDGET_MS = Number(process.env.PROOF_BUDGET_MS || 25000);
const STORE_PATH =
  process.env.ACCEPTED_STORE || path.join(__dirname, "..", "data", "accepted.json");

/** Set of proof_tx values this agent has ACCEPTED (for PROOF_REUSED). */
const accepted = new Set();
try {
  for (const tx of JSON.parse(fs.readFileSync(STORE_PATH, "utf8"))) accepted.add(tx);
} catch {
  /* first run */
}
function persistAccepted() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...accepted]));
  } catch (err) {
    console.error("accepted-store persist failed:", err.message);
  }
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const headers = { "content-type": "application/json" };
  if (SECRET) headers[HEADER] = sign(SECRET, body);
  res.writeHead(status, headers);
  res.end(body);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("proof timeout")), ms)),
  ]);
}

async function handleTask(res, body) {
  const { task, error } = parseTask(body);
  if (!task) {
    return sendJson(res, 200, {
      decision: "REJECT",
      reason_code: REASONS.INVALID,
      detail: error,
    });
  }
  const result = decide(task, (tx) => accepted.has(tx));
  const response = {
    decision: result.decision,
    reason_code: result.reason_code,
    proof_tx: task.input.proof_tx,
  };
  try {
    const { proof, publicSignals } = await withTimeout(
      prove(task, result.decision),
      PROOF_BUDGET_MS
    );
    response.proof = proof;
    response.public_signals = publicSignals;
  } catch (err) {
    console.error(`proof skipped for ${task.task_id}: ${err.message}`);
  }
  if (result.decision === "APPROVE") {
    accepted.add(task.input.proof_tx);
    persistAccepted();
  }
  return sendJson(res, 200, response);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return sendJson(res, 200, {
      ok: true,
      service: "proof-gatekeeper-agent",
      accepted_proofs: accepted.size,
    });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    if (!SECRET) return sendJson(res, 500, { error: "AGENT_GAMES_HMAC_SECRET not set" });
    if (!verify(SECRET, raw, req.headers[HEADER])) {
      return sendJson(res, 401, { error: "bad signature" });
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "invalid json" });
    }
    try {
      if (body && body.type === "agent-games.preflight.v1") {
        return sendJson(res, 200, { ok: true, protocolVersion: "v1" });
      }
      if (body && body.type === "agent-games.proof-gatekeeper.v1") {
        return await handleTask(res, body);
      }
      return sendJson(res, 400, { error: `unsupported type: ${String(body && body.type)}` });
    } catch (err) {
      console.error("handler error:", err);
      return sendJson(res, 200, { decision: "REJECT", reason_code: REASONS.INVALID });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`gatekeeper agent on :${PORT}`));
}

module.exports = { server };
