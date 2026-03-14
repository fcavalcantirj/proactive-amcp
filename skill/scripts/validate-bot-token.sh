#!/bin/bash
# validate-bot-token.sh — Self-healing bot token validator
#
# CRITICAL: Expected values are HARDCODED here (immutable truth).
# Do NOT read expected values from the config being validated!
#
# Usage:
#   ./validate-bot-token.sh [--fix] [--notify]
#
# Exit codes:
#   0 = Token valid
#   1 = Token invalid (and fixed if --fix)
#   2 = Token invalid (fix failed or --fix not provided)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ============================================================
# IMMUTABLE TRUTH — Hardcoded expected values
# ============================================================
# This bot is ClawdBruvBot (local dev instance)
EXPECTED_BOT_ID="8239728684"
EXPECTED_BOT_USERNAME="clawdbruvbot"  # Telegram usernames are lowercase (no underscores)

# The correct token (fallback for self-healing)
# WARNING: This is the ultimate fallback. Protect this script!
CORRECT_TOKEN="8239728684:AAHT4M3e9WrszrUVVtw64xkj7US_VTSG19Q"

# ============================================================
# Config paths
# ============================================================
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.amcp/config-backups}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

# Parse args
FIX_MODE=false
NOTIFY_MODE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --fix) FIX_MODE=true; shift ;;
    --notify) NOTIFY_MODE=true; shift ;;
    *) shift ;;
  esac
done

# ============================================================
# Validation
# ============================================================
validate_token() {
  local token="$1"
  
  # Extract bot ID from token (format: BOT_ID:SECRET)
  local token_bot_id
  token_bot_id=$(echo "$token" | cut -d: -f1)
  
  # Quick check: does token start with expected bot ID?
  if [ "$token_bot_id" != "$EXPECTED_BOT_ID" ]; then
    echo "❌ Token prefix mismatch: got $token_bot_id, expected $EXPECTED_BOT_ID"
    return 1
  fi
  
  # Call Telegram getMe to verify token is valid
  local response
  response=$(curl -s --max-time 10 "https://api.telegram.org/bot${token}/getMe" 2>/dev/null || echo '{"ok":false}')
  
  local ok
  ok=$(echo "$response" | jq -r '.ok // false')
  
  if [ "$ok" != "true" ]; then
    echo "❌ Telegram API rejected token (getMe failed)"
    return 1
  fi
  
  # Extract bot info
  local actual_id
  local actual_username
  actual_id=$(echo "$response" | jq -r '.result.id')
  actual_username=$(echo "$response" | jq -r '.result.username | ascii_downcase')
  
  # Verify it's the right bot
  if [ "$actual_id" != "$EXPECTED_BOT_ID" ]; then
    echo "❌ Bot ID mismatch: got $actual_id, expected $EXPECTED_BOT_ID"
    echo "   This token belongs to a DIFFERENT bot!"
    return 1
  fi
  
  if [ "$actual_username" != "$EXPECTED_BOT_USERNAME" ]; then
    echo "❌ Bot username mismatch: got $actual_username, expected $EXPECTED_BOT_USERNAME"
    return 1
  fi
  
  echo "✅ Token valid: @$actual_username (ID: $actual_id)"
  return 0
}

# ============================================================
# Fix (restore correct token)
# ============================================================
fix_token() {
  echo "🔧 Restoring correct bot token..."
  
  # Backup current config
  mkdir -p "$BACKUP_DIR"
  local backup_file="$BACKUP_DIR/openclaw-$(date +%Y%m%d-%H%M%S).json"
  cp "$OPENCLAW_CONFIG" "$backup_file"
  echo "📦 Backup: $backup_file"
  
  # Update token in config
  local tmp_file="${OPENCLAW_CONFIG}.tmp"
  jq --arg token "$CORRECT_TOKEN" '.channels.telegram.botToken = $token' "$OPENCLAW_CONFIG" > "$tmp_file"
  
  if [ -s "$tmp_file" ]; then
    mv "$tmp_file" "$OPENCLAW_CONFIG"
    echo "✅ Token restored in config"
    
    # Restart gateway to pick up new token
    if systemctl --user restart openclaw-gateway 2>/dev/null; then
      echo "✅ Gateway restarted"
      return 0
    else
      echo "⚠️ Gateway restart failed (manual restart may be needed)"
      return 0  # Config is fixed, restart is separate concern
    fi
  else
    echo "❌ Failed to update config (jq error)"
    rm -f "$tmp_file"
    return 1
  fi
}

# ============================================================
# Notify
# ============================================================
notify() {
  local message="$1"
  if [ -x "$SCRIPT_DIR/notify.sh" ]; then
    "$SCRIPT_DIR/notify.sh" "$message"
  fi
}

# ============================================================
# Main
# ============================================================
echo "=== Bot Token Validator ==="
echo "Expected: @$EXPECTED_BOT_USERNAME (ID: $EXPECTED_BOT_ID)"
echo "Config: $OPENCLAW_CONFIG"

# Read current token from config
if [ ! -f "$OPENCLAW_CONFIG" ]; then
  echo "❌ Config file not found: $OPENCLAW_CONFIG"
  exit 2
fi

CURRENT_TOKEN=$(jq -r '.channels.telegram.botToken // empty' "$OPENCLAW_CONFIG")

if [ -z "$CURRENT_TOKEN" ]; then
  echo "❌ No telegram bot token found in config"
  
  if $FIX_MODE; then
    fix_token
    exit $?
  fi
  exit 2
fi

# Validate
if validate_token "$CURRENT_TOKEN"; then
  exit 0
fi

# Token is invalid
echo ""
echo "🚨 BOT TOKEN MISMATCH DETECTED"

if $FIX_MODE; then
  if fix_token; then
    # Verify fix worked
    sleep 2
    CURRENT_TOKEN=$(jq -r '.channels.telegram.botToken // empty' "$OPENCLAW_CONFIG")
    if validate_token "$CURRENT_TOKEN"; then
      echo "✅ Token mismatch FIXED automatically"
      if $NOTIFY_MODE; then
        notify "🔧 [$AGENT_NAME] Bot token mismatch detected and AUTO-FIXED. Was using wrong bot, restored to @$EXPECTED_BOT_USERNAME."
      fi
      exit 0
    fi
  fi
  echo "❌ Fix attempt failed"
  if $NOTIFY_MODE; then
    notify "🚨 [$AGENT_NAME] Bot token mismatch detected! Auto-fix FAILED. Manual intervention needed!"
  fi
  exit 1
else
  echo "Run with --fix to automatically restore the correct token"
  if $NOTIFY_MODE; then
    notify "🚨 [$AGENT_NAME] Bot token mismatch detected! Run validate-bot-token.sh --fix to restore."
  fi
  exit 2
fi
