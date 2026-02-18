#!/bin/bash
# pin-to-solvr.sh - Pin file to IPFS via Solvr CLI
# Usage: ./pin-to-solvr.sh <file_path> [name]
#
# Thin wrapper around Solvr CLI. Does NOT reimplement API calls.
# Reads SOLVR_API_KEY from config.json or environment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"

# ============================================================
# Parse arguments
# ============================================================
DRY_RUN=false
FILE_PATH=""
PIN_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      cat <<EOF
pin-to-solvr.sh — Pin file to IPFS via Solvr CLI

Usage: $(basename "$0") <file_path> [name] [--dry-run]

Arguments:
  file_path   Path to file to pin (required)
  name        Display name for the pin (optional, defaults to filename)

Options:
  --dry-run   Show what would be pinned without actually pinning
  -h, --help  Show this help

Environment:
  SOLVR_API_KEY   Solvr API key (or set via: proactive-amcp config set solvr.apiKey <key>)
EOF
      exit 0
      ;;
    *)
      if [ -z "$FILE_PATH" ]; then
        FILE_PATH="$1"
      elif [ -z "$PIN_NAME" ]; then
        PIN_NAME="$1"
      fi
      shift
      ;;
  esac
done

if [ -z "$FILE_PATH" ]; then
  echo "ERROR: file_path is required" >&2
  echo "Usage: $(basename "$0") <file_path> [name] [--dry-run]" >&2
  exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH" >&2
  exit 1
fi

# Default pin name to filename with timestamp
if [ -z "$PIN_NAME" ]; then
  PIN_NAME="$(basename "$FILE_PATH")"
fi

# ============================================================
# Resolve SOLVR_API_KEY from env or config.json
# ============================================================
if [ -z "${SOLVR_API_KEY:-}" ]; then
  if [ -f "$CONFIG_FILE" ]; then
    SOLVR_API_KEY=$(python3 -c "
import json, os
p = os.path.expanduser('$CONFIG_FILE')
d = json.load(open(p))
print(d.get('solvr',{}).get('apiKey') or d.get('pinning',{}).get('solvr',{}).get('apiKey') or '')
" 2>/dev/null || echo '')
  fi
fi

if [ -z "${SOLVR_API_KEY:-}" ]; then
  echo "ERROR: No Solvr API key found" >&2
  echo "Set via: proactive-amcp config set solvr.apiKey <key>" >&2
  echo "  or: export SOLVR_API_KEY=<key>" >&2
  exit 1
fi

export SOLVR_API_KEY

# ============================================================
# Check Solvr CLI is installed
# ============================================================
SOLVR_CLI="${SOLVR_CLI:-$(command -v solvr 2>/dev/null || echo '')}"

if [ -z "$SOLVR_CLI" ]; then
  echo "ERROR: Solvr CLI not found" >&2
  echo "Install: curl -sL https://solvr.dev/install.sh | bash" >&2
  exit 1
fi

# ============================================================
# Pin file
# ============================================================
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN: Would pin '$FILE_PATH' as '$PIN_NAME' via Solvr CLI"
  echo "  File size: $(du -sh "$FILE_PATH" | cut -f1)"
  echo "  API key: ${SOLVR_API_KEY:0:8}..."
  exit 0
fi

echo "Pinning to Solvr: $FILE_PATH (name: $PIN_NAME)..."

# Use Solvr CLI to pin the file
RESULT=$("$SOLVR_CLI" pin add-file "$FILE_PATH" --name "$PIN_NAME" 2>&1) || {
  echo "ERROR: Solvr CLI pin failed: $RESULT" >&2
  exit 1
}

# Extract CID from CLI output
# Solvr CLI outputs the CID on success — try common output formats
CID=$(echo "$RESULT" | grep -oE '(Qm[a-zA-Z0-9]{44}|bafy[a-zA-Z0-9]{55,})' | head -1)

if [ -z "$CID" ]; then
  # Try JSON output format
  CID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cid',''))" 2>/dev/null || echo '')
fi

if [ -n "$CID" ]; then
  echo "$CID"
  exit 0
else
  echo "ERROR: Could not extract CID from Solvr CLI output: $RESULT" >&2
  exit 1
fi
