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
#   prune            Prune ontology graph by typed retention policies
#   memory-prune     Groq-powered memory file pruning (archive/condense/keep)
#   validate-contract  Validate skill ontology contracts against graph.jsonl
#   detect-conflicts   Detect cross-skill ontology contract conflicts
#   groq               Groq intelligence: status, request-key (free tier via Solvr)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"

IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"
AMCP_CLI="${AMCP_CLI:-$(command -v amcp 2>/dev/null || echo "$HOME/bin/amcp")}"

usage() {
  cat <<EOF
proactive-amcp — Agent Memory Continuity Protocol

Usage: $(basename "$0") <command> [args...]

Commands:
  status           Check AMCP readiness (identity, pinning, config)
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
  prune            Prune ontology graph by typed retention policies
  memory-prune     Groq-powered memory file pruning (archive/condense/keep)
  validate-contract  Validate skill ontology contracts against graph.jsonl
  detect-conflicts   Detect cross-skill ontology contract conflicts
  groq               Groq intelligence: status, request-key (free tier via Solvr)

Run '$(basename "$0") <command> --help' for details.
EOF
  exit 1
}

do_status() {
  local status="READY"
  local messages=()

  # Check identity
  if [ ! -f "$IDENTITY_PATH" ]; then
    status="NO_IDENTITY"
    messages+=("Identity not found at $IDENTITY_PATH")
  elif ! "$AMCP_CLI" identity validate --identity "$IDENTITY_PATH" 2>/dev/null; then
    status="INVALID_IDENTITY"
    messages+=("Identity file exists but is invalid")
  fi

  # Check pinning config (only if identity OK)
  if [ "$status" = "READY" ]; then
    local provider=""
    local has_pinning=false

    if [ -f "$CONFIG_FILE" ]; then
      provider=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('ipfs',{}).get('provider',''))" 2>/dev/null || echo "")
      
      if [ "$provider" = "solvr" ]; then
        local solvr_key=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('solvr',{}).get('apiKey',''))" 2>/dev/null || echo "")
        [ -n "$solvr_key" ] && has_pinning=true
      elif [ "$provider" = "pinata" ] || [ -z "$provider" ]; then
        local pinata_jwt=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('pinata',{}).get('jwt',''))" 2>/dev/null || echo "")
        [ -n "$pinata_jwt" ] && has_pinning=true
      fi
    fi

    if ! $has_pinning; then
      status="NO_PINNING"
      messages+=("No IPFS pinning configured (set solvr.apiKey or pinata.jwt)")
    fi
  fi

  # Output
  echo "STATUS: $status"
  [ "$status" = "READY" ] && echo "  Identity: $IDENTITY_PATH"
  [ "$status" = "READY" ] && echo "  Config: $CONFIG_FILE"
  for msg in "${messages[@]:-}"; do
    [ -n "$msg" ] && echo "  → $msg"
  done

  [ "$status" = "READY" ] && exit 0 || exit 1
}

case "${1:-}" in
  status)
    shift
    do_status
    ;;
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
  prune)
    shift
    exec python3 "$SCRIPT_DIR/prune-ontology.py" "$@"
    ;;
  memory-prune)
    shift
    exec "$SCRIPT_DIR/memory-prune.sh" "$@"
    ;;
  validate-contract)
    shift
    exec "$SCRIPT_DIR/validate-skill-contract.sh" "$@"
    ;;
  detect-conflicts)
    shift
    exec "$SCRIPT_DIR/detect-contract-conflicts.sh" "$@"
    ;;
  groq)
    shift
    exec "$SCRIPT_DIR/groq-status.sh" "$@"
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
