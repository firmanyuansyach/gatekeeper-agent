"use strict";
/** HMAC-SHA256 signing for Agent Games envelopes (hex over the raw body). */
const crypto = require("crypto");

const HEADER = "x-agent-games-signature";

function sign(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function verify(secret, rawBody, headerValue) {
  if (typeof headerValue !== "string" || headerValue.trim() === "") return false;
  const expected = Buffer.from(sign(secret, rawBody), "utf8");
  const given = Buffer.from(headerValue.trim(), "utf8");
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { HEADER, sign, verify };
