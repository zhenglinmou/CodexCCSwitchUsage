#!/bin/sh
set -eu

BUNDLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_ROOT="$BUNDLE_ROOT/Resources/app"
NODE="$BUNDLE_ROOT/Resources/runtime-bin/node"
STATE_ROOT="${CODEXCCSWITCH_STATE_ROOT:-$HOME/Library/Application Support/CodexCCSwitchUsage}"
RUNTIME_DIR="$STATE_ROOT/runtime"

exec "$NODE" --no-warnings --experimental-sqlite \
  "$APP_ROOT/scripts/stop-host.mjs" \
  --install-root "$APP_ROOT" \
  --runtime-dir "$RUNTIME_DIR" \
  --all-instances
