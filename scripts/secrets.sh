#!/bin/bash
# secrets.sh — Consolidated secret management hub
#
# Subcommands:
#   scan         Scan directory for cleartext secrets before checkpoint
#   inject       Inject secrets from JSON to file/env/systemd targets
#   pre-commit   Git pre-commit hook to block secret commits
#
# Usage:
#   secrets.sh scan <directory> [--force]
#   secrets.sh inject <secrets.json>
#   secrets.sh pre-commit
#
# The scan subcommand is also sourceable as a library for scan_for_secrets().
# Implementation files prefixed with _ are internal — use this dispatcher.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"

usage() {
  cat <<EOF
proactive-amcp secrets — Secret management hub

Usage: $(basename "$0") <subcommand> [args...]

Subcommands:
  scan         Scan directory for cleartext secrets (--force to bypass)
  inject       Inject secrets from JSON to targets (file/env/systemd)
  pre-commit   Run git pre-commit hook to block secret commits

Scan options:
  <directory>    Directory to scan (required)
  --force        Continue even if secrets found

Inject arguments:
  <secrets.json> Path to secrets JSON file (required)

Examples:
  $(basename "$0") scan ~/.openclaw/workspace
  $(basename "$0") scan ~/.openclaw/workspace --force
  $(basename "$0") inject /tmp/secrets.json
  $(basename "$0") pre-commit

Run '$(basename "$0") <subcommand> --help' for details.
EOF
  exit 1
}

case "${1:-}" in
  scan)
    shift
    exec "$SCRIPT_DIR/_secrets-scan.sh" "$@"
    ;;
  inject)
    shift
    exec "$SCRIPT_DIR/_secrets-inject.sh" "$@"
    ;;
  pre-commit)
    shift
    exec "$SCRIPT_DIR/_secrets-precommit.sh" "$@"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    echo "ERROR: Unknown secrets subcommand '${1}'" >&2
    echo "" >&2
    usage
    ;;
esac
