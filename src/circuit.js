"use strict";
/**
 * Gatekeeper circuit (GatekeeperEvaluation) — input mapping + Groth16 proving.
 *
 * The circuit has 13 inputs; `salt` is the only private one. Public signals:
 * [0] evaluationCommitment (binds inputs + salt; the platform skips index 0
 * because it cannot recompute it without the salt), then the 11 task fields
 * and the decision in circuit order:
 * [1] registeredVkHash [2] proofVkHash [3] minimum [4] publicBalance
 * [5] expiryBlock [6] currentBlock [7] recipient [8] conditionRecipient
 * [9] amount [10] maxTransfer [11] decision [12] taskId
 *
 * Encodings (field = bn128 prime P):
 * - vk hashes:  BigInt(hex) mod P
 * - taskId:     keccak256(utf8(task_id)) mod P
 * - addresses / amounts / blocks: raw BigInt (all < P)
 * - decision:   1 = APPROVE, 0 = REJECT   - salt: 0 (constant)
 *
 * The circuit itself asserts the decision is the correct evaluation of the
 * checks, so a proof can only be produced for the right decision; if our
 * decision disagrees with the circuit, proving throws and the caller falls
 * back to a proof-less response (a proof failure never fails the task).
 */
const path = require("path");
const { keccak_256 } = require("js-sha3");
const snarkjs = require("snarkjs");

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const WASM_PATH =
  process.env.GATEKEEPER_WASM ||
  path.join(__dirname, "..", "circuits", "gatekeeper.wasm");
const ZKEY_PATH =
  process.env.GATEKEEPER_ZKEY ||
  path.join(__dirname, "..", "circuits", "gatekeeper_final.zkey");

function vkToField(vkHex) {
  const hex = vkHex.startsWith("0x") ? vkHex.slice(2) : vkHex;
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error("vk is not <=32-byte hex");
  return (BigInt("0x" + hex) % FIELD_P).toString();
}

function taskIdToField(taskId) {
  const hash = keccak_256(new TextEncoder().encode(taskId));
  return (BigInt("0x" + hash) % FIELD_P).toString();
}

function buildCircuitInputs(task, decision) {
  const inp = task.input;
  return {
    registeredVkHash: vkToField(inp.registered_vk),
    proofVkHash: vkToField(inp.proof_vk),
    minimum: BigInt(inp.minimum).toString(),
    publicBalance: BigInt(inp.public_balance).toString(),
    expiryBlock: BigInt(inp.expiry_block).toString(),
    currentBlock: BigInt(inp.current_block).toString(),
    recipient: BigInt(inp.recipient).toString(),
    conditionRecipient: BigInt(inp.condition_recipient).toString(),
    amount: BigInt(inp.amount).toString(),
    maxTransfer: BigInt(inp.max_transfer).toString(),
    taskId: taskIdToField(task.task_id),
    decision: decision === "APPROVE" ? "1" : "0",
    salt: "0",
  };
}

let vkCache = null;
async function verificationKey() {
  if (!vkCache) vkCache = await snarkjs.zKey.exportVerificationKey(ZKEY_PATH);
  return vkCache;
}

/** Generate a proof for (task, decision) and self-verify it against the VK. */
async function prove(task, decision) {
  const inputs = buildCircuitInputs(task, decision);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputs,
    WASM_PATH,
    ZKEY_PATH
  );
  const vk = await verificationKey();
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error("local groth16 verification failed");
  return { proof, publicSignals };
}

module.exports = { buildCircuitInputs, prove, verificationKey, WASM_PATH, ZKEY_PATH };
