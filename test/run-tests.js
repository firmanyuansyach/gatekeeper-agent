"use strict";
/** End-to-end tests: synthetic envelopes for the valid case + every trap. */
process.env.AGENT_GAMES_HMAC_SECRET = "test-secret-for-local-tests";
process.env.ACCEPTED_STORE = require("path").join(__dirname, "accepted-test.json");
process.env.PORT = "0";
require("fs").rmSync(process.env.ACCEPTED_STORE, { force: true });

const crypto = require("crypto");
const { server } = require("../src/server");
const { taskIdToFieldProbe } = require("./probe");

const SECRET = process.env.AGENT_GAMES_HMAC_SECRET;
const VK = "0x7d3a" + "11".repeat(28) + "f291";
const VK_OTHER = "0xa4c1" + "22".repeat(28) + "b8ff";
const RECIP = "0xDe42" + "00".repeat(16) + "9f01";
const RECIP_OTHER = "0xBeef" + "00".repeat(16) + "1234";
let proofCounter = 0;
const freshProofTx = () =>
  "0x" + (++proofCounter).toString(16).padStart(2, "0") + "ab".repeat(31);

function envelope(mutate) {
  const now = Date.now();
  const task = {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_test_" + Math.random().toString(36).slice(2, 10),
    mode: "practice",
    issued_at: new Date(now - 1000).toISOString(),
    deadline_at: new Date(now + 5 * 60 * 1000).toISOString(),
    input: {
      registered_vk: VK,
      proof_vk: VK,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 19842201,
      current_block: 19832000,
      recipient: RECIP,
      condition_recipient: RECIP,
      amount: "500",
      max_transfer: "1000",
      proof_tx: freshProofTx(),
    },
  };
  if (mutate) mutate(task);
  return task;
}

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

async function post(base, obj, { badSig = false } = {}) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const res = await fetch(base + "/agent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": badSig ? "00".repeat(32) : sign(body),
    },
    body,
  });
  const text = await res.text();
  const sigOk =
    res.headers.get("x-agent-games-signature") === sign(Buffer.from(text, "utf8"));
  return { status: res.status, json: JSON.parse(text), sigOk };
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const pf = await post(base, {
    type: "agent-games.preflight.v1",
    agent_id: "agt_test",
    issued_at: new Date().toISOString(),
    nonce: "abc123",
  });
  check("preflight ok + signed", pf.json.ok === true && pf.json.protocolVersion === "v1" && pf.sigOk);

  const bad = await post(base, envelope(), { badSig: true });
  check("bad HMAC rejected 401", bad.status === 401);

  const valid = envelope();
  const v = await post(base, valid);
  check("valid -> APPROVE", v.json.decision === "APPROVE" && v.json.reason_code === "VALID_CONDITION");
  check("valid -> proof present", !!v.json.proof && Array.isArray(v.json.public_signals));
  check(
    "valid -> signals layout",
    v.json.public_signals?.length === 13 &&
      v.json.public_signals[11] === "1" &&
      v.json.public_signals[12] === taskIdToFieldProbe(valid.task_id),
    v.json.public_signals ? `decision=${v.json.public_signals[11]}` : "no signals"
  );
  check("valid -> response signed", v.sigOk);

  const reuse = await post(base, valid);
  check(
    "same task again -> PROOF_REUSED",
    reuse.json.decision === "REJECT" && reuse.json.reason_code === "PROOF_REUSED"
  );

  const traps = [
    ["VK_SUBSTITUTION", (t) => (t.input.proof_vk = VK_OTHER)],
    ["THRESHOLD_MISMATCH", (t) => (t.input.public_balance = "999")],
    ["RECIPIENT_MISMATCH", (t) => (t.input.recipient = RECIP_OTHER)],
    ["AMOUNT_OVERFLOW", (t) => (t.input.amount = "1001")],
    ["EXPIRED_CONDITION", (t) => (t.input.current_block = t.input.expiry_block)],
  ];
  for (const [reason, mutate] of traps) {
    const r = await post(base, envelope(mutate));
    check(
      `trap ${reason}`,
      r.json.decision === "REJECT" && r.json.reason_code === reason && !!r.json.proof,
      `proof=${!!r.json.proof}`
    );
  }

  server.close();
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
