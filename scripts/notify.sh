#!/bin/bash
# notify.sh - Send notifications via Telegram/email
# Usage: ./notify.sh "message" [email_subject]

set -e

MSG="$1"
EMAIL_SUBJECT="$2"
NOTIFY_TARGET="${NOTIFY_TARGET:-152099202}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

# Telegram notification
telegram_notify() {
  local msg="$1"
  openclaw message send --channel telegram --target "$NOTIFY_TARGET" --message "$msg" 2>/dev/null || {
    echo "[WARN] Telegram notification failed" >&2
  }
}

# Email notification (via AgentMail or gog)
email_notify() {
  local subject="$1"
  local body="$2"
  local to="${EMAIL_TO:-felipe.cavalcanti.rj@gmail.com}"
  
  # Try AgentMail first
  if command -v python3 &>/dev/null && [ -f ~/clawd/skills/agentmail/.venv/bin/python3 ]; then
    ~/clawd/skills/agentmail/.venv/bin/python3 << EOF 2>/dev/null || true
from agentmail import AgentMail
client = AgentMail(api_key='$(grep -o '"am_[^"]*"' ~/.openclaw/openclaw.json | head -1 | tr -d '"')')
client.inboxes.messages.send(
    inbox_id='claudiusthepirateemperor@agentmail.to',
    to='$to',
    subject='$subject',
    html='<pre>$body</pre>'
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
