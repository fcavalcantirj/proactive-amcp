#!/bin/bash
# proactive-amcp.sh - Main CLI entry point
# Usage: proactive-amcp.sh <command> [args...]
#
# Commands:
#   init      Interactive setup: validate/create identity, start services
#   config    Manage ~/.amcp/config.json (set/get)
#   install   Non-interactive setup for fleet tools (future)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<EOF
proactive-amcp — Agent Memory Continuity Protocol

Usage: $(basename "$0") <command> [args...]

Commands:
  init      Interactive setup: validate/create identity, start watchdog + checkpoint services
  config    Manage ~/.amcp/config.json (set/get secrets and settings)

Run '$(basename "$0") <command> --help' for details.
EOF
  exit 1
}

case "${1:-}" in
  init)
    shift
    exec "$SCRIPT_DIR/init.sh" "$@"
    ;;
  config)
    shift
    exec "$SCRIPT_DIR/config.sh" "$@"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    echo "ERROR: Unknown command '${1}'" >&2
    echo "" >&2
    usage
    ;;
esac
