#!/usr/bin/env bash
# Starts the AgentHub local bridge in the foreground.
#
# Deliberately NOT a daemon and NOT a launch agent: it does not change any
# macOS startup setting, and it stores no token. Stop it with Ctrl-C.
#
# The token must already be in your environment:
#
#   export AGENTHUB_BRIDGE_TOKEN="<your token>"
#   ./bridge/start-bridge.sh
#
# Generate a token once with:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"

set -euo pipefail

if [ -z "${AGENTHUB_BRIDGE_TOKEN:-}" ]; then
  echo "AGENTHUB_BRIDGE_TOKEN is not set in this shell." >&2
  echo "Run:  export AGENTHUB_BRIDGE_TOKEN=\"<your token>\"" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
echo "Starting bridge (Ctrl-C to stop). Token is read from the environment and never printed."
exec node bridge/server.mjs
