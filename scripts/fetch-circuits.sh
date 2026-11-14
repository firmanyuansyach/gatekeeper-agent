#!/usr/bin/env bash
# Download the official Proof Gatekeeper circuit artifacts from the platform.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p circuits
curl -fsSL -o circuits/gatekeeper.wasm        https://agentgames.zkverify.io/circuits/gatekeeper.wasm
curl -fsSL -o circuits/gatekeeper_final.zkey  https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
echo "circuits ready: $(ls -la circuits/)"
