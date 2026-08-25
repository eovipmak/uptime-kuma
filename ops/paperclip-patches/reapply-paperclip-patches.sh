#!/usr/bin/env bash
set -euo pipefail

# Re-applies KUM-174/KUM-176 durable patches to the currently installed @paperclipai/server.
# Survives CLI upgrades because patch storage is outside versioned install dir.
# Idempotent: skips already-applied patches (patch -N).

PATCH_DIR="/opt/paperclip/patches"
CURRENT_LINK="/opt/paperclip/cli/current"

if [ ! -L "$CURRENT_LINK" ]; then
  echo "FAIL: $CURRENT_LINK symlink missing" >&2
  exit 1
fi

INSTALL_ROOT="$(readlink -f "$CURRENT_LINK")"
SERVER_ROOT="$INSTALL_ROOT/node_modules/@paperclipai/server"

if [ ! -d "$SERVER_ROOT/dist" ]; then
  echo "FAIL: $SERVER_ROOT/dist not found" >&2
  exit 1
fi

echo "Reapplying Paperclip server patches to $SERVER_ROOT"
echo "Patch dir: $PATCH_DIR"

# Patches are stored with git-style a/b prefixes; apply with -p1 from SERVER_ROOT
for patch in \
  "write-guard-timer-exemption.patch" \
  "agent-self-cancel.patch" \
  "heartbeat-self-cancel-sibling.patch" \
  "recovery-service-self-cancel-sibling.patch"
do
  path="$PATCH_DIR/$patch"
  if [ ! -f "$path" ]; then
    echo "SKIP: $patch not found" >&2
    continue
  fi
  echo "--- Applying $patch ---"
  # Idempotent: if reverse applies cleanly, patch is already applied
  if patch -p1 -R --dry-run -d "$SERVER_ROOT" < "$path" >/dev/null 2>&1; then
    echo "OK: $patch already applied (skip)"
    continue
  fi
  if patch -p1 -d "$SERVER_ROOT" < "$path" 2>&1; then
    echo "OK: $patch applied"
  else
    rc=$?
    echo "WARN: $patch apply returned $rc" >&2
    exit $rc
  fi
done

echo "Verifying..."
exec "$(dirname "$0")/verify-paperclip-patches.sh"
