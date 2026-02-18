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
#   migrate-pins     Transfer historical checkpoints from Pinata to Solvr
#   problem          Problem CRUD: create, update, get, list, close
#   learning         Learning CRUD: create, verify, get, list
#   temporal-query   Cross-checkpoint entity history queries
#   detect-failure   Scan text for failure patterns, auto-create Problems

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"

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
  migrate-pins     Transfer historical checkpoints from Pinata to Solvr
  problem          Problem CRUD: create, update, get, list, close
  learning         Learning CRUD: create, verify, get, list
  temporal-query   Cross-checkpoint entity history queries
  detect-failure   Scan text for failure patterns, auto-create Problems

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
  migrate-pins)
    shift
    exec "$SCRIPT_DIR/migrate-pins.sh" "$@"
    ;;
  problem)
    shift
    exec python3 "$SCRIPT_DIR/learning.py" problem "$@"
    ;;
  learning)
    shift
    if [ "${1:-}" = "report" ]; then
      shift
      exec python3 "$SCRIPT_DIR/learning-report.py" "$@"
    fi
    exec python3 "$SCRIPT_DIR/learning.py" learning "$@"
    ;;
  temporal-query)
    shift
    exec python3 "$SCRIPT_DIR/temporal-queries.py" "$@"
    ;;
  detect-failure)
    shift
    exec python3 "$SCRIPT_DIR/detect-failure.py" "$@"
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
