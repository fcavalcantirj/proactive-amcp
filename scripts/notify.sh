#!/bin/bash
# notify.sh - Send notifications via Telegram/email
# Usage: ./notify.sh "message" [email_subject]

set -euo pipefail

MSG="${1:-}"
EMAIL_SUBJECT="${2:-}"
NOTIFY_TARGET="${NOTIFY_TARGET:-152099202}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

# Telegram notification
telegram_notify() {
  local msg="$1"
  openclaw message send --channel telegram --target "$NOTIFY_TARGET" --message "$msg" 2>/dev/null || {
    echo "[WARN] Telegram notification failed" >&2
  }
}

# Email notification (optional - requires agentmail pip package)
# Uses env vars to pass data safely into Python (no shell interpolation)
email_notify() {
  local subject="$1"
  local body="$2"
  local to="${EMAIL_TO:-}"

  # Skip if no email configured
  [ -z "$to" ] && return 0

  # Try AgentMail if available
  if python3 -c "import agentmail" 2>/dev/null; then
    MAIL_TO="$to" MAIL_SUBJECT="$subject" MAIL_BODY="$body" \
    python3 << 'EOF' 2>/dev/null || true
import os, json, html
from agentmail import AgentMail

config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path) as f:
    config = json.load(f)

api_key = config.get('skills', {}).get('entries', {}).get('agentmail', {}).get('apiKey', '')
inbox = config.get('skills', {}).get('entries', {}).get('agentmail', {}).get('inbox', '')

if api_key and inbox:
    client = AgentMail(api_key=api_key)
    body_escaped = html.escape(os.environ["MAIL_BODY"])
    client.inboxes.messages.send(
        inbox_id=inbox,
        to=os.environ["MAIL_TO"],
        subject=os.environ["MAIL_SUBJECT"],
        html=f'<pre>{body_escaped}</pre>'
    )
    print("Email sent via AgentMail")
EOF
  fi
}

# Main
telegram_notify "$MSG"

if [ -n "$EMAIL_SUBJECT" ]; then
  email_notify "$EMAIL_SUBJECT" "$MSG"
fi
