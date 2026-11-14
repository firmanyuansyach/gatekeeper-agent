"use strict";
/** Test helper: recompute the circuit's taskId field element independently. */
const { keccak_256 } = require("js-sha3");
const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function taskIdToFieldProbe(taskId) {
  const hash = keccak_256(new TextEncoder().encode(taskId));
  return (BigInt("0x" + hash) % FIELD_P).toString();
}
module.exports = { taskIdToFieldProbe };
