"use strict";
/**
 * Proof Gatekeeper — deterministic decision logic (no model in the loop).
 *
 * APPROVE only when EVERY check passes; any doubt fails closed to REJECT.
 * Scoring: correct decision +12, wrong APPROVE -6, wrong REJECT -3,
 * timeout -2, invalid/missing proof -2, reliability bonus +0..+5.
 *
 * Check semantics (validated against the platform's trap taxonomy and the
 * gatekeeper circuit's own assertions):
 * - VK_SUBSTITUTION:    proof_vk != registered_vk
 * - THRESHOLD_MISMATCH: public_balance < minimum
 * - RECIPIENT_MISMATCH: recipient != condition_recipient (case-insensitive)
 * - AMOUNT_OVERFLOW:    amount > max_transfer
 * - EXPIRED_CONDITION:  current_block >= expiry_block (circuit requires <)
 * - PROOF_REUSED:       proof_tx already ACCEPTED by an earlier task
 * - INVALID_TASK:       malformed envelope, unparseable/future issued_at,
 *                       missing or passed deadline_at
 */

const REASONS = Object.freeze({
  VALID: "VALID_CONDITION",
  VK: "VK_SUBSTITUTION",
  THRESHOLD: "THRESHOLD_MISMATCH",
  REUSED: "PROOF_REUSED",
  EXPIRED: "EXPIRED_CONDITION",
  RECIPIENT: "RECIPIENT_MISMATCH",
  AMOUNT: "AMOUNT_OVERFLOW",
  INVALID: "INVALID_TASK",
});

function isHex(v) {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
}

function toBig(v) {
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

function toBlock(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() !== "") {
    if (/^\d+$/.test(v.trim())) {
      const n = Number(v);
      return n < 1e12 ? n * 1000 : n;
    }
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

/** Validate + normalize a raw task body. Returns {task} or {error}. */
function parseTask(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "body is not a JSON object" };
  }
  if (raw.type !== "agent-games.proof-gatekeeper.v1") {
    return { error: `unknown type: ${String(raw.type)}` };
  }
  if (typeof raw.task_id !== "string" || raw.task_id.trim() === "") {
    return { error: "missing task_id" };
  }
  const inp = raw.input;
  if (typeof inp !== "object" || inp === null || Array.isArray(inp)) {
    return { error: "missing input object" };
  }
  for (const f of ["registered_vk", "proof_vk", "recipient", "condition_recipient", "proof_tx"]) {
    if (!isHex(inp[f])) return { error: `input.${f} is not a 0x hex string` };
  }
  const minimum = toBig(inp.minimum);
  const balance = toBig(inp.public_balance);
  const amount = toBig(inp.amount);
  const maxTransfer = toBig(inp.max_transfer);
  if (minimum === null || balance === null || amount === null || maxTransfer === null) {
    return { error: "minimum/public_balance/amount/max_transfer not decimal integers" };
  }
  if (minimum < 0n || balance < 0n || amount < 0n || maxTransfer < 0n) {
    return { error: "negative numeric field" };
  }
  const expiry = toBlock(inp.expiry_block);
  const current = toBlock(inp.current_block);
  if (expiry === null || current === null) {
    return { error: "expiry_block/current_block not block numbers" };
  }
  return {
    task: {
      type: raw.type,
      task_id: raw.task_id.trim(),
      mode: typeof raw.mode === "string" ? raw.mode : undefined,
      issued_at: raw.issued_at,
      deadline_at: raw.deadline_at,
      input: {
        registered_vk: inp.registered_vk.toLowerCase(),
        proof_vk: inp.proof_vk.toLowerCase(),
        minimum: minimum.toString(),
        public_balance: balance.toString(),
        expiry_block: expiry,
        current_block: current,
        recipient: inp.recipient.toLowerCase(),
        condition_recipient: inp.condition_recipient.toLowerCase(),
        amount: amount.toString(),
        max_transfer: maxTransfer.toString(),
        proof_tx: inp.proof_tx.toLowerCase(),
      },
    },
  };
}

/**
 * Decide a parsed task. `wasAccepted(proofTx)` reports whether that proof
 * reference was already accepted (APPROVED) by an earlier task.
 */
function decide(task, wasAccepted, nowMs = Date.now()) {
  const inp = task.input;
  const reject = (reason_code, detail) => ({ decision: "REJECT", reason_code, detail });

  if (task.issued_at !== undefined) {
    const issued = toMs(task.issued_at);
    if (issued === null) return reject(REASONS.INVALID, "issued_at unparseable");
    if (issued > nowMs + 5 * 60 * 1000) return reject(REASONS.INVALID, "issued_at in the future");
  }
  if (task.deadline_at === undefined) {
    return reject(REASONS.INVALID, "deadline_at missing");
  }
  const deadline = toMs(task.deadline_at);
  if (deadline === null) return reject(REASONS.INVALID, "deadline_at unparseable");
  if (nowMs > deadline) return reject(REASONS.INVALID, "deadline passed");

  if (inp.proof_vk !== inp.registered_vk) {
    return reject(REASONS.VK, "proof_vk != registered_vk");
  }
  if (BigInt(inp.public_balance) < BigInt(inp.minimum)) {
    return reject(REASONS.THRESHOLD, "public_balance < minimum");
  }
  if (inp.recipient !== inp.condition_recipient) {
    return reject(REASONS.RECIPIENT, "recipient != condition_recipient");
  }
  if (BigInt(inp.amount) > BigInt(inp.max_transfer)) {
    return reject(REASONS.AMOUNT, "amount > max_transfer");
  }
  if (inp.current_block >= inp.expiry_block) {
    return reject(REASONS.EXPIRED, "current_block >= expiry_block");
  }
  if (wasAccepted(inp.proof_tx)) {
    return reject(REASONS.REUSED, "proof_tx already accepted");
  }
  return { decision: "APPROVE", reason_code: REASONS.VALID, detail: "all checks pass" };
}

module.exports = { REASONS, parseTask, decide };
