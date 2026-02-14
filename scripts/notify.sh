#!/bin/bash
# notify.sh - Send notifications via Telegram and/or email
# Usage: notify.sh "message" [--email "subject"]

set -euo pipefail

MESSAGE="${1:-}"
EMAIL_SUBJECT=""
SEND_EMAIL=false

# Parse args
shift || true
while [[ $# -gt 0 ]]; do
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

if [[ -z "$MESSAGE" ]]; then
  echo "Usage: notify.sh \"message\" [--email \"subject\"]"
  exit 1
fi

# Load config from ~/.amcp/config.json (AMCP's own config)
AMCP_CONFIG="${AMCP_CONFIG:-${HOME}/.amcp/config.json}"
OC_CONFIG="${HOME}/.openclaw/openclaw.json"

if [[ ! -f "$AMCP_CONFIG" ]] && [[ ! -f "$OC_CONFIG" ]]; then
  echo "[NOTIFY] No config file, logging only: $MESSAGE"
  exit 0
fi

# Get notify target (Telegram user ID) — prefer AMCP config, fall back to OpenClaw
NOTIFY_TARGET=""
if [[ -f "$AMCP_CONFIG" ]]; then
  NOTIFY_TARGET=$(python3 -c "import json; d=json.load(open('$AMCP_CONFIG')); print(d.get('notify',{}).get('target',''))" 2>/dev/null || echo "")
fi
if [[ -z "$NOTIFY_TARGET" ]] && [[ -f "$OC_CONFIG" ]]; then
  NOTIFY_TARGET=$(jq -r '.skills.entries["proactive-amcp"].config.notifyTarget // empty' "$OC_CONFIG" 2>/dev/null || true)
fi

# Get email config — prefer AMCP config, fall back to OpenClaw
EMAIL_ENABLED="false"
EMAIL_TO=""
if [[ -f "$AMCP_CONFIG" ]]; then
  EMAIL_ENABLED=$(python3 -c "import json; d=json.load(open('$AMCP_CONFIG')); print(str(d.get('notify',{}).get('emailOnResurrect',False)).lower())" 2>/dev/null || echo "false")
  EMAIL_TO=$(python3 -c "import json; d=json.load(open('$AMCP_CONFIG')); print(d.get('notify',{}).get('emailTo',''))" 2>/dev/null || echo "")
fi
if [[ "$EMAIL_ENABLED" == "false" ]] && [[ -z "$EMAIL_TO" ]] && [[ -f "$OC_CONFIG" ]]; then
  EMAIL_ENABLED=$(jq -r '.skills.entries["proactive-amcp"].config.emailOnResurrect // false' "$OC_CONFIG" 2>/dev/null || echo "false")
  EMAIL_TO=$(jq -r '.skills.entries["proactive-amcp"].config.emailTo // empty' "$OC_CONFIG" 2>/dev/null || true)
fi

# Log
LOG_DIR="${HOME}/.amcp/logs"
mkdir -p "$LOG_DIR"
echo "[$(date -Iseconds)] $MESSAGE" >> "$LOG_DIR/notifications.log"

# Telegram notification (if target configured and gateway running)
if [[ -n "$NOTIFY_TARGET" ]]; then
  # Try to send via OpenClaw message tool (if gateway is running)
  if command -v openclaw &>/dev/null; then
    # Use curl to gateway API if available
    GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://localhost:5578}"
    
    # Check if gateway is up
    if curl -s --max-time 2 "$GATEWAY_URL/health" &>/dev/null; then
      echo "[NOTIFY] Gateway up, but direct messaging requires agent context"
      # For now, just log - agent should use message tool directly
    fi
  fi
  echo "[NOTIFY] Telegram target: $NOTIFY_TARGET (use message tool from agent context)"
fi

# Email notification
if [[ "$SEND_EMAIL" == "true" ]] && [[ "$EMAIL_ENABLED" == "true" ]] && [[ -n "$EMAIL_TO" ]]; then
  # Try AgentMail if available
  AGENTMAIL_VENV="${HOME}/clawd/skills/agentmail/.venv/bin/python3"
  # Prefer AMCP config for agentmail key and inbox, fall back to OpenClaw
  AGENTMAIL_KEY=""
  INBOX=""
  if [[ -f "$AMCP_CONFIG" ]]; then
    AGENTMAIL_KEY=$(python3 -c "import json; d=json.load(open('$AMCP_CONFIG')); print(d.get('notify',{}).get('agentmailApiKey',''))" 2>/dev/null || echo "")
    INBOX=$(python3 -c "import json; d=json.load(open('$AMCP_CONFIG')); print(d.get('notify',{}).get('agentmailInbox',''))" 2>/dev/null || echo "")
  fi
  if [[ -z "$AGENTMAIL_KEY" ]] && [[ -f "$OC_CONFIG" ]]; then
    AGENTMAIL_KEY=$(jq -r '.skills.entries.agentmail.apiKey // empty' "$OC_CONFIG" 2>/dev/null || true)
  fi
  if [[ -z "$INBOX" ]] && [[ -f "$OC_CONFIG" ]]; then
    INBOX=$(jq -r '.skills.entries["proactive-amcp"].config.agentmailInbox // "claudiusthepirateemperor@agentmail.to"' "$OC_CONFIG" 2>/dev/null || echo "claudiusthepirateemperor@agentmail.to")
  fi
  INBOX="${INBOX:-claudiusthepirateemperor@agentmail.to}"
  
  if [[ -x "$AGENTMAIL_VENV" ]] && [[ -n "$AGENTMAIL_KEY" ]]; then
    echo "[NOTIFY] Sending email via AgentMail to $EMAIL_TO"
    
    # Escape message for Python
    ESCAPED_MSG=$(echo "$MESSAGE" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/<br>/g')
    
    "$AGENTMAIL_VENV" << EOF
from agentmail import AgentMail
try:
    client = AgentMail(api_key='$AGENTMAIL_KEY')
    client.inboxes.messages.send(
        inbox_id='$INBOX',
        to='$EMAIL_TO',
        subject='$EMAIL_SUBJECT',
        html='<pre style="font-family: monospace;">$ESCAPED_MSG</pre>'
    )
    print("[NOTIFY] Email sent successfully")
except Exception as e:
    print(f"[NOTIFY] Email failed: {e}")
EOF
  else
    echo "[NOTIFY] AgentMail not configured, skipping email"
  fi
fi

echo "[NOTIFY] Done: $MESSAGE"
