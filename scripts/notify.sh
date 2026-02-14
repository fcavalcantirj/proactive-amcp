#!/bin/bash
# notify.sh - Send notifications via Telegram/email
# Usage: ./notify.sh "message" [--email "subject"]
#
# Config (in openclaw.json):
#   skills.entries.proactive-amcp.config.notifyTarget - Telegram user ID
#   skills.entries.proactive-amcp.config.emailTo - Email address
#   skills.entries.proactive-amcp.config.emailOnResurrect - Send email on resurrect

set -euo pipefail

MSG="${1:-}"
SEND_EMAIL=false
EMAIL_SUBJECT=""

# Parse args
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --email)
      SEND_EMAIL=true
      EMAIL_SUBJECT="${2:-AMCP Notification}"
      shift 2 || shift
      ;;
    *)
      shift
      ;;
  esac
done

# Read config
CONFIG_FILE="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
if [ -f "$CONFIG_FILE" ]; then
  NOTIFY_TARGET="${NOTIFY_TARGET:-$(jq -r '.skills.entries["proactive-amcp"].config.notifyTarget // empty' "$CONFIG_FILE" 2>/dev/null || echo "")}"
  EMAIL_TO="${EMAIL_TO:-$(jq -r '.skills.entries["proactive-amcp"].config.emailTo // empty' "$CONFIG_FILE" 2>/dev/null || echo "")}"
fi

# Fallback defaults
NOTIFY_TARGET="${NOTIFY_TARGET:-152099202}"
AGENT_NAME="${AGENT_NAME:-$(hostname)}"

# Telegram notification
telegram_notify() {
  local msg="$1"
  
  if [ -z "$NOTIFY_TARGET" ]; then
    echo "[SKIP] No Telegram target configured" >&2
    return 0
  fi
  
  # Try openclaw message tool first
  if command -v openclaw &>/dev/null; then
    openclaw message send --channel telegram --target "$NOTIFY_TARGET" --message "$msg" 2>/dev/null && return 0
  fi
  
  # Fallback to direct API if bot token available
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=$NOTIFY_TARGET" \
      -d "text=$msg" \
      -d "parse_mode=HTML" >/dev/null 2>&1 && return 0
  fi
  
  echo "[WARN] Telegram notification failed (no token or openclaw unavailable)" >&2
}

# Email notification
email_notify() {
  local subject="$1"
  local body="$2"
  local to="${EMAIL_TO:-}"

  # Skip if no email configured
  if [ -z "$to" ]; then
    echo "[SKIP] No email configured" >&2
    return 0
  fi

  # Try AgentMail if available
  if python3 -c "import agentmail" 2>/dev/null; then
    MAIL_TO="$to" MAIL_SUBJECT="$subject" MAIL_BODY="$body" \
    python3 << 'PYEOF' 2>/dev/null && return 0 || true
import os, json, html
from agentmail import AgentMail

config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path) as f:
    config = json.load(f)

api_key = config.get('skills', {}).get('entries', {}).get('agentmail', {}).get('apiKey', '')
inbox = config.get('skills', {}).get('entries', {}).get('agentmail', {}).get('inbox', '')

if not inbox:
    # Try to find inbox from agentmail config
    inbox_id = 'claudiusthepirateemperor@agentmail.to'  # Default
    for k, v in config.get('skills', {}).get('entries', {}).items():
        if 'agentmail' in k.lower() and isinstance(v, dict):
            if 'inbox' in v:
                inbox_id = v['inbox']
                break

if api_key:
    client = AgentMail(api_key=api_key)
    body_escaped = html.escape(os.environ["MAIL_BODY"]).replace('\n', '<br>')
    client.inboxes.messages.send(
        inbox_id=inbox or inbox_id,
        to=os.environ["MAIL_TO"],
        subject=os.environ["MAIL_SUBJECT"],
        html=f'<div style="font-family: monospace; white-space: pre-wrap;">{body_escaped}</div>'
    )
    print(f"[EMAIL] Sent to {os.environ['MAIL_TO']}")
else:
    print("[WARN] No AgentMail API key found")
PYEOF
  fi
  
  # Fallback to gog if available
  if command -v gog &>/dev/null; then
    echo "$body" | gog gmail send --to "$to" --subject "$subject" 2>/dev/null && {
      echo "[EMAIL] Sent via gog to $to"
      return 0
    } || true
  fi
  
  echo "[WARN] Email notification failed (no agentmail or gog)" >&2
}

# Main
if [ -z "$MSG" ]; then
  echo "Usage: $0 <message> [--email \"subject\"]"
  exit 1
fi

# Always send Telegram
telegram_notify "$MSG"

# Send email if requested
if [ "$SEND_EMAIL" = true ]; then
  email_notify "$EMAIL_SUBJECT" "$MSG"
fi
