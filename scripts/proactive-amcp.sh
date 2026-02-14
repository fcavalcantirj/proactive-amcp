#!/bin/bash
# proactive-amcp.sh - Main CLI entry point
# Usage: proactive-amcp.sh <command> [args...]
#
# Commands:
#   init             Interactive setup: validate/create identity, start services
#   config           Manage ~/.amcp/config.json (set/get)
#   install          Non-interactive setup for fleet tools (e.g. openclaw-deploy)
#   diagnose         Claude-powered health diagnostics with Solvr integration
#   solvr-register   Auto-register child Solvr account on first boot

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<EOF
proactive-amcp — Agent Memory Continuity Protocol

Usage: $(basename "$0") <command> [args...]

Commands:
  init             Interactive setup: validate/create identity, start watchdog + checkpoint services
  install          Non-interactive setup for fleet tools (accepts --pinata-jwt, --notify-target, etc.)
  config           Manage ~/.amcp/config.json (set/get secrets and settings)
  diagnose         Claude-powered health diagnostics with Solvr integration
  solvr-register   Auto-register child Solvr account on first boot

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
  install)
    shift
    exec "$SCRIPT_DIR/install.sh" "$@"
    ;;
  diagnose)
    shift
    exec "$SCRIPT_DIR/claude-diagnose.sh" "$@"
    ;;
  solvr-register)
    shift
    exec "$SCRIPT_DIR/solvr-register.sh" "$@"
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
