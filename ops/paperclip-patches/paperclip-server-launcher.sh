#!/usr/bin/env bash
set -euo pipefail
# Launcher that fails loud if durable patches are missing before starting Paperclip server.
# Use: /opt/paperclip/scripts/paperclip-server-launcher.sh run --instance default

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! "$SCRIPT_DIR/verify-paperclip-patches.sh"; then
  echo "Aborting server start: patch integrity failed. Run $SCRIPT_DIR/reapply-paperclip-patches.sh" >&2
  exit 1
fi

CURRENT_LINK="/opt/paperclip/cli/current"
INSTALL_ROOT="$(readlink -f "$CURRENT_LINK")"
exec node "$INSTALL_ROOT/node_modules/paperclipai/dist/index.js" "$@"
