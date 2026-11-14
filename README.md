# Proof Gatekeeper Agent

An agent for **Proof Gatekeeper**, an event in the [zkVerify Agent Games](https://agentgames.zkverify.io).
The platform POSTs signed payment-verification tasks to this endpoint; the agent
answers **APPROVE** or **REJECT** within the response deadline and attaches a
Groth16 zero-knowledge proof of its decision, generated locally with the
event's official circuit (`gatekeeper.wasm` / `gatekeeper_final.zkey`,
vk_hash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`,
registered on zkVerify mainnet).

## How it decides

Deterministic code only — no language model in the decision path. APPROVE
requires **every** check to pass:

| Check | Reject reason |
| --- | --- |
| `proof_vk` equals the condition's registered VK | `VK_SUBSTITUTION` |
| `public_balance >= minimum` | `THRESHOLD_MISMATCH` |
| `recipient` equals `condition_recipient` | `RECIPIENT_MISMATCH` |
| `amount <= max_transfer` | `AMOUNT_OVERFLOW` |
| `current_block < expiry_block` | `EXPIRED_CONDITION` |
| `proof_tx` not previously accepted | `PROOF_REUSED` |
| envelope well-formed, timestamps sane, deadline open | `INVALID_TASK` |

Anything else returns `APPROVE` / `VALID_CONDITION`. Malformed or doubtful
tasks fail closed to REJECT.

## The proof

Each response carries a Groth16 proof (BN128, snarkjs) over the gatekeeper
circuit. The circuit independently asserts that the decision equals the correct
evaluation of the task's public fields, so the proof cannot be produced for a
wrong decision. Inputs are the task fields encoded as field elements
(vk hashes and `keccak256(task_id)` reduced mod the field prime), the decision
bit, and a constant salt; the proof is verified locally against the official
verification key before it is sent. If proving ever fails, the agent still
answers with the decision alone — a proof failure never fails the task.

## Protocol

- Requests arrive as `POST /agent` with an `x-agent-games-signature`
  (HMAC-SHA256 hex over the raw body). The signature is verified **before**
  the body is parsed; mismatches get `401`.
- Preflight envelopes (`agent-games.preflight.v1`) are answered with
  `{ "ok": true, "protocolVersion": "v1" }`.
- Every response is signed with the same HMAC secret.
- State: proof references this agent has accepted are persisted
  (`data/accepted.json`) so reuse detection survives restarts.

## Run

```bash
npm install
cp .env.example .env   # fill AGENT_GAMES_HMAC_SECRET from the dashboard
npm start              # node src/server.js, PORT=8787
npm test               # end-to-end tests: valid case + every trap type
```

Secrets come from the environment only. The circuit artifacts are the
platform's published files; fetch them with `scripts/fetch-circuits.sh`
(they are git-ignored — the deployed service keeps its own copies).

## Production deployment and Wildcard entry

The same decision engine also runs in production as a general-purpose pre-payout guard, and is entered in the Agent Games Wildcard track.

- Live endpoint: https://gatekeeper-agent.firmanyuansyach123.workers.dev/agent (health check: https://gatekeeper-agent.firmanyuansyach123.workers.dev/health)
- Production edition: Cloudflare Workers + D1. It applies the identical checks within the platform's 15-second task window and keeps idempotency answers and proof-reuse state in D1. The Node edition in this repo is the full local-proving version.
- Verified live: in Agent Games practice on 14 Nov 2026 the agent decided a real task correctly (REJECT / EXPIRED_CONDITION, an expired-condition trap) in 127 ms, and the platform marked the proof VERIFIED.
- zkVerify proof reference: a Groth16 decision attestation produced by this circuit was submitted to zkVerify mainnet (via Kurier) and finalized - transaction 0x325f1ace377b3ef182c8239f6c0a856df677fef7fec8388e96dfe16b01ef9d29. The verification-key hash registered on zkVerify for it is 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0, identical to this circuit's VK.

Who it helps: protocols, DAOs and bounty platforms that release funds when a ZK-proven condition holds, and want an independent checker between "a proof exists" and "money moves" - substituted verification keys, unmet thresholds, wrong recipients, oversized amounts, expired conditions and replayed proofs are each rejected with a specific reason code.
