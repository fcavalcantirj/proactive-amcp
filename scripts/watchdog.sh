#!/bin/bash
# watchdog.sh - Health check and death detection
# Usage: ./watchdog.sh [--continuous]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$HOME/.amcp/watchdog-state.json"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"
CONTINUOUS="${1:-}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"  # seconds
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"   # consecutive failures before DEAD

mkdir -p "$(dirname "$STATE_FILE")"

# Initialize state if not exists
if [ ! -f "$STATE_FILE" ]; then
  cat > "$STATE_FILE" << 'EOJSON'
{
  "state": "HEALTHY",
  "consecutiveFailures": 0,
  "lastCheck": null,
  "lastHealthy": null
}
EOJSON
fi

# Health check function
health_check() {
  local errors=()
  
  # Check 1: Gateway process running
  if ! pgrep -f "openclaw-gateway" > /dev/null 2>&1; then
    # Also check for openclaw in gateway mode
    if ! pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
      errors+=("gateway_not_running")
    fi
  fi
  
  # Check 2: Gateway responding (if running)
  if [ ${#errors[@]} -eq 0 ]; then
    if ! curl -s --max-time 5 "http://localhost:3141/health" > /dev/null 2>&1; then
      # Try alternative port
      if ! curl -s --max-time 5 "http://localhost:8080/health" > /dev/null 2>&1; then
        errors+=("gateway_not_responding")
      fi
    fi
  fi
  
  # Check 3: Disk space (>10% free)
  local disk_free=$(df -h "$HOME" | awk 'NR==2 {gsub(/%/,""); print 100-$5}')
  if [ "$disk_free" -lt 10 ] 2>/dev/null; then
    errors+=("disk_low:${disk_free}%")
  fi
  
  # Check 4: Memory (>10% free)
  local mem_free=$(free | awk '/Mem:/ {printf "%.0f", $7/$2*100}')
  if [ "$mem_free" -lt 10 ] 2>/dev/null; then
    errors+=("memory_low:${mem_free}%")
  fi
  
  # Return errors
  if [ ${#errors[@]} -gt 0 ]; then
    echo "${errors[*]}"
    return 1
  fi
  
  return 0
}

# Update state (uses env vars to avoid shell injection in Python)
update_state() {
  local new_state="$1"
  local failures="$2"
  local errors="$3"

  WATCHDOG_STATE_FILE="$STATE_FILE" \
  WATCHDOG_NEW_STATE="$new_state" \
  WATCHDOG_FAILURES="$failures" \
  WATCHDOG_ERRORS="$errors" \
  python3 << 'EOF'
import json, os
from datetime import datetime

state_file = os.environ["WATCHDOG_STATE_FILE"]
new_state = os.environ["WATCHDOG_NEW_STATE"]
failures = int(os.environ["WATCHDOG_FAILURES"])
errors_str = os.environ["WATCHDOG_ERRORS"]

with open(state_file) as f:
    state = json.load(f)

state["state"] = new_state
state["consecutiveFailures"] = failures
state["lastCheck"] = datetime.now().isoformat()
state["errors"] = errors_str.split() if errors_str else []
if new_state == "HEALTHY":
    state["lastHealthy"] = datetime.now().isoformat()

with open(state_file, "w") as f:
    json.dump(state, f, indent=2)
EOF
}

# Get current state
get_state() {
  python3 -c "import json; print(json.load(open('$STATE_FILE')).get('state', 'UNKNOWN'))"
}

get_failures() {
  python3 -c "import json; print(json.load(open('$STATE_FILE')).get('consecutiveFailures', 0))"
}

# Single check
do_check() {
  local current_state=$(get_state)
  local failures=$(get_failures)
  
  echo "[$(date -Iseconds)] Checking health..."
  
  if errors=$(health_check); then
    # Healthy
    if [ "$current_state" != "HEALTHY" ]; then
      echo "✅ Recovered! State: $current_state -> HEALTHY"
      "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Recovered from $current_state"
    fi
    update_state "HEALTHY" 0 ""
    echo "✅ HEALTHY"
    return 0
  else
    # Failed
    failures=$((failures + 1))
    echo "⚠️ Check failed ($failures/$FAIL_THRESHOLD): $errors"
    
    if [ "$failures" -ge "$FAIL_THRESHOLD" ]; then
      if [ "$current_state" != "DEAD" ]; then
        echo "☠️ State: $current_state -> DEAD"
        update_state "DEAD" "$failures" "$errors"
        "$SCRIPT_DIR/notify.sh" "☠️ [$AGENT_NAME] DEAD! Errors: $errors. Starting recovery..."
        
        # Trigger resurrection
        "$SCRIPT_DIR/resuscitate.sh" &
        return 2
      fi
      update_state "DEAD" "$failures" "$errors"
    else
      update_state "CHECKING" "$failures" "$errors"
    fi
    
    return 1
  fi
}

# Main
echo "=== AMCP Watchdog ==="
echo "Agent: $AGENT_NAME"
echo "State file: $STATE_FILE"

if [ "$CONTINUOUS" = "--continuous" ]; then
  echo "Mode: Continuous (checking every ${CHECK_INTERVAL}s)"
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Watchdog started (continuous mode)"
  
  while true; do
    do_check || true
    sleep "$CHECK_INTERVAL"
  done
else
  echo "Mode: Single check"
  do_check
  exit $?
fi
