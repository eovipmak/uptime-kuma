#!/usr/bin/env bash
set -euo pipefail

# Startup integrity check that fails loud if KUM-174/KUM-176 fixes are missing.
# Used as pre-flight before Paperclip server start; exit 1 triggers operator alert.

CURRENT_LINK="/opt/paperclip/cli/current"
INSTALL_ROOT="$(readlink -f "$CURRENT_LINK")"
SERVER_ROOT="$INSTALL_ROOT/node_modules/@paperclipai/server"

FAIL=0

check_file_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo "OK: $label present in $(basename "$file")"
  else
    echo "FAIL: $label MISSING in $(basename "$file")" >&2
    FAIL=1
  fi
}

echo "Verifying Paperclip server patches in $SERVER_ROOT"

# Risk1a: timer-run write-guard exemption
check_file_contains "$SERVER_ROOT/dist/services/cross-issue-influence-limit.js" "isTimerRun" "Risk1a write-guard timer exemption"
check_file_contains "$SERVER_ROOT/dist/services/cross-issue-influence-limit.js" "heartbeat_timer" "Risk1a heartbeat_timer marker"

# Risk1b: agent self-cancel
check_file_contains "$SERVER_ROOT/dist/routes/agents.js" "isAgentSelfCancel" "Risk1b agent self-cancel"
check_file_contains "$SERVER_ROOT/dist/routes/agents.js" "selfCancel" "Risk1b selfCancel marker"

# Risk2: heartbeat immediate recovery sibling guard
check_file_contains "$SERVER_ROOT/dist/services/heartbeat.js" "isSelfCancelledRun" "Risk2 heartbeat isSelfCancelledRun"
check_file_contains "$SERVER_ROOT/dist/services/heartbeat.js" "siblingLiveRun" "Risk2 siblingLiveRun guard"

# Risk2: recovery service lock-aware sibling + selfCancel exempt
check_file_contains "$SERVER_ROOT/dist/services/recovery/service.js" "isSelfCancelledRun" "Risk2 service isSelfCancelledRun"
check_file_contains "$SERVER_ROOT/dist/services/recovery/service.js" "issueLock" "Risk2 issueLock sibling check"

if [ $FAIL -ne 0 ]; then
  echo "" >&2
  echo "ERROR: One or more Paperclip patches are missing. Run /opt/paperclip/scripts/reapply-paperclip-patches.sh" >&2
  echo "This failure is intentional (fail-loud) to prevent silent upgrade revert per KUM-176." >&2
  exit 1
fi

echo "All patch integrity checks PASSED"
