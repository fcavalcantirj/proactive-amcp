#!/bin/bash
# session-fix.sh — Repair corrupted OpenClaw session transcripts
#
# Wraps fix-openclaw-session.py with auto-detection, structured output.
# Dry-run by default. Use --fix to apply.
#
# Usage:
#   ./session-fix.sh [--fix] [--session-dir DIR] [--session-id ID]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_DIR="${SESSION_DIR:-$HOME/.openclaw/agents/main/sessions}"
FIX_MODE=false
SESSION_ID=""
VERBOSE=false

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --fix) FIX_MODE=true; shift ;;
    --session-dir) SESSION_DIR="$2"; shift 2 ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) shift ;;
  esac
done

REPAIR_SCRIPT="$SCRIPT_DIR/fix-openclaw-session.py"

if [ ! -f "$REPAIR_SCRIPT" ]; then
  echo "ERROR: fix-openclaw-session.py not found at $REPAIR_SCRIPT"
  exit 1
fi

if [ ! -d "$SESSION_DIR" ]; then
  echo "ERROR: Session directory not found: $SESSION_DIR"
  exit 1
fi

# Build command
CMD=(python3 "$REPAIR_SCRIPT" "$SESSION_DIR")

if [ "$FIX_MODE" = true ]; then
  CMD+=(--fix)
fi

if [ "$VERBOSE" = true ]; then
  CMD+=(--verbose)
fi

if [ -n "$SESSION_ID" ]; then
  CMD+=(--session-id "$SESSION_ID")
fi

# Run
exec "${CMD[@]}"
