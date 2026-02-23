#!/bin/bash
# solvr.sh — Consolidated Solvr operations hub
#
# Subcommands:
#   register     Auto-register child Solvr account (--name, --dry-run)
#   heartbeat    Send heartbeat + display agent status briefing (--json, --quiet)
#   pin          Pin file to IPFS via Solvr API (FILE [NAME] [--dry-run])
#   checkpoint   Register checkpoint via unified API (--cid, --checkpoint-path, --name)
#   resurrect    Resurrect from Solvr resurrection bundle (--agent-id, --json, --dry-run)
#
# Usage:
#   solvr.sh register [--name NAME] [--dry-run]
#   solvr.sh heartbeat [--json] [--quiet]
#   solvr.sh pin <file> [name] [--dry-run]
#   solvr.sh checkpoint --cid CID [--checkpoint-path PATH] [--name NAME]
#   solvr.sh resurrect [--agent-id ID] [--json] [--dry-run]
#
# Keeps solvr-integration.sh as a shared library (sourced by resuscitate.sh).
# Implementation files prefixed with _ are internal — use this dispatcher.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"

usage() {
  cat <<EOF
proactive-amcp solvr — Solvr operations hub

Usage: $(basename "$0") <subcommand> [args...]

Subcommands:
  register     Auto-register child Solvr account (--name, --dry-run)
  heartbeat    Send heartbeat + display agent status briefing (--json, --quiet)
  pin          Pin file to IPFS via Solvr API (FILE [NAME] [--dry-run])
  checkpoint   Register checkpoint via Solvr unified API (--cid, --name)
  resurrect    Resurrect from Solvr resurrection bundle (--agent-id, --json, --dry-run)

Options:
  -h, --help   Show this help

Register options:
  --name <name>      Agent name for registration (default: hostname)
  --instance-name    Alias for --name
  --dry-run          Show what would happen without registering

Heartbeat options:
  --json             Output raw JSON (machine-readable)
  --quiet            Only output warnings and errors

Pin arguments:
  <file_path>        Path to file to pin (required)
  [name]             Display name for the pin (optional)
  --dry-run          Show what would be pinned without pinning

Checkpoint options:
  --cid <CID>              IPFS content identifier (required)
  --checkpoint-path <PATH> Path to checkpoint file (for memory_hash)
  --name <NAME>            Checkpoint name

Resurrect options:
  --agent-id <ID>    Solvr agent ID (default: me)
  --json             Output bundle as JSON without applying
  --dry-run          Fetch and display bundle only

Examples:
  $(basename "$0") register --name my_agent --dry-run
  $(basename "$0") heartbeat --json
  $(basename "$0") pin checkpoint.amcp "amcp-full-agent-20260223"
  $(basename "$0") checkpoint --cid bafk... --name amcp-full-agent
  $(basename "$0") resurrect --dry-run

Run '$(basename "$0") <subcommand> --help' for details.
EOF
  exit 1
}

case "${1:-}" in
  register)
    shift
    exec "$SCRIPT_DIR/_solvr-register.sh" "$@"
    ;;
  heartbeat)
    shift
    exec "$SCRIPT_DIR/_solvr-heartbeat.sh" "$@"
    ;;
  pin)
    shift
    exec "$SCRIPT_DIR/_solvr-pin.sh" "$@"
    ;;
  checkpoint)
    shift
    exec "$SCRIPT_DIR/_solvr-checkpoint.sh" "$@"
    ;;
  resurrect)
    shift
    exec "$SCRIPT_DIR/_solvr-resurrect.sh" "$@"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    echo "ERROR: Unknown solvr subcommand '${1}'" >&2
    echo "" >&2
    usage
    ;;
esac
