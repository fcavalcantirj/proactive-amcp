#!/bin/bash
# smart-checkpoint-trigger.sh - Decide if checkpoint needed, create if so
# Usage: ./smart-checkpoint-trigger.sh [--trigger <type>] [--force]
#
# Triggers: heartbeat, learning, recovery, session-end, manual
# 
# Smart logic:
#   - heartbeat: checkpoint if >2h since last OR >10 file changes
#   - learning: always checkpoint (captures new knowledge)
#   - recovery: always checkpoint (fresh state after resurrection)
#   - session-end: checkpoint if any changes since last
#   - manual/force: always checkpoint

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"
LAST_CHECKPOINT_FILE="${LAST_CHECKPOINT_FILE:-$HOME/.amcp/last-checkpoint.json}"
WORKSPACE="${WORKSPACE:-$HOME/.openclaw/workspace}"
CHECKPOINT_STATE_FILE="${CHECKPOINT_STATE_FILE:-$HOME/.amcp/checkpoint-state.json}"

# Configurable thresholds (can override via config)
HEARTBEAT_CHECKPOINT_HOURS="${HEARTBEAT_CHECKPOINT_HOURS:-2}"
HEARTBEAT_CHECKPOINT_CHANGES="${HEARTBEAT_CHECKPOINT_CHANGES:-10}"

# Parse args
TRIGGER="manual"
FORCE=false
QUIET=false

for arg in "$@"; do
  case "$arg" in
    --trigger) shift; TRIGGER="${1:-manual}"; shift || true ;;
    --trigger=*) TRIGGER="${arg#*=}" ;;
    --force) FORCE=true ;;
    --quiet|-q) QUIET=true ;;
    -h|--help)
      echo "Usage: $0 [--trigger <type>] [--force] [--quiet]"
      echo "Triggers: heartbeat, learning, recovery, session-end, manual"
      exit 0
      ;;
  esac
done

log() {
  [ "$QUIET" = true ] || echo "[smart-checkpoint] $1"
}

# Get last checkpoint timestamp (seconds since epoch)
get_last_checkpoint_time() {
  if [ -f "$LAST_CHECKPOINT_FILE" ]; then
    python3 -c "
import json, os
from datetime import datetime
try:
    d = json.load(open('$LAST_CHECKPOINT_FILE'))
    ts = d.get('timestamp', '')
    if ts:
        # Parse ISO format
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        print(int(dt.timestamp()))
    else:
        print(0)
except Exception:
    print(0)
" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

# Get hours since last checkpoint
hours_since_checkpoint() {
  local last_ts
  last_ts=$(get_last_checkpoint_time)
  local now_ts
  now_ts=$(date +%s)
  local diff=$((now_ts - last_ts))
  echo $((diff / 3600))
}

# Count file changes since last checkpoint
count_changes_since_checkpoint() {
  local last_ts
  last_ts=$(get_last_checkpoint_time)
  
  if [ "$last_ts" -eq 0 ]; then
    echo "999"  # No checkpoint = many changes
    return
  fi
  
  # Find files modified since last checkpoint
  local count
  count=$(find "$WORKSPACE" -type f \( -name "*.md" -o -name "*.json" \) -newermt "@$last_ts" 2>/dev/null | wc -l)
  echo "$count"
}

# Load config thresholds
load_config() {
  if [ -f "$CONFIG_FILE" ]; then
    HEARTBEAT_CHECKPOINT_HOURS=$(python3 -c "
import json
try:
    d = json.load(open('$CONFIG_FILE'))
    print(d.get('checkpoint',{}).get('heartbeatHours', 2))
except:
    print(2)
" 2>/dev/null || echo "2")
    
    HEARTBEAT_CHECKPOINT_CHANGES=$(python3 -c "
import json
try:
    d = json.load(open('$CONFIG_FILE'))
    print(d.get('checkpoint',{}).get('heartbeatChanges', 10))
except:
    print(10)
" 2>/dev/null || echo "10")
  fi
}

# Decide if checkpoint needed based on trigger
should_checkpoint() {
  local trigger="$1"
  
  case "$trigger" in
    learning|recovery)
      # Always checkpoint after learning or recovery
      log "Trigger '$trigger' → always checkpoint"
      return 0
      ;;
    
    heartbeat)
      local hours
      hours=$(hours_since_checkpoint)
      local changes
      changes=$(count_changes_since_checkpoint)
      
      log "Heartbeat check: ${hours}h since last, $changes files changed"
      
      if [ "$hours" -ge "$HEARTBEAT_CHECKPOINT_HOURS" ]; then
        log "Checkpoint needed: ${hours}h >= ${HEARTBEAT_CHECKPOINT_HOURS}h threshold"
        return 0
      fi
      
      if [ "$changes" -ge "$HEARTBEAT_CHECKPOINT_CHANGES" ]; then
        log "Checkpoint needed: $changes changes >= $HEARTBEAT_CHECKPOINT_CHANGES threshold"
        return 0
      fi
      
      log "No checkpoint needed (${hours}h, $changes changes)"
      return 1
      ;;
    
    session-end)
      local changes
      changes=$(count_changes_since_checkpoint)
      
      if [ "$changes" -gt 0 ]; then
        log "Session end: $changes files changed → checkpoint"
        return 0
      fi
      
      log "Session end: no changes → skip"
      return 1
      ;;
    
    manual|*)
      log "Manual trigger → checkpoint"
      return 0
      ;;
  esac
}

# Create checkpoint
do_checkpoint() {
  local trigger="$1"
  
  log "Creating checkpoint (trigger: $trigger)..."
  
  # Use quick checkpoint for heartbeat, full for others
  local checkpoint_script="$SCRIPT_DIR/checkpoint.sh"
  if [ "$trigger" = "recovery" ] || [ "$trigger" = "learning" ]; then
    checkpoint_script="$SCRIPT_DIR/full-checkpoint.sh"
  fi
  
  if [ -x "$checkpoint_script" ]; then
    "$checkpoint_script" --notify 2>&1 | while read -r line; do
      log "  $line"
    done
    
    # Update state file
    mkdir -p "$(dirname "$CHECKPOINT_STATE_FILE")"
    python3 -c "
import json
from datetime import datetime
state = {
    'lastTrigger': '$trigger',
    'lastCheckpoint': datetime.utcnow().isoformat() + 'Z',
    'triggerCounts': {}
}
# Merge with existing
try:
    with open('$CHECKPOINT_STATE_FILE') as f:
        old = json.load(f)
        state['triggerCounts'] = old.get('triggerCounts', {})
except:
    pass
state['triggerCounts']['$trigger'] = state['triggerCounts'].get('$trigger', 0) + 1
with open('$CHECKPOINT_STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)
"
    log "✅ Checkpoint complete"
    return 0
  else
    log "❌ Checkpoint script not found: $checkpoint_script"
    return 1
  fi
}

# Main
load_config

if [ "$FORCE" = true ]; then
  do_checkpoint "$TRIGGER"
  exit $?
fi

if should_checkpoint "$TRIGGER"; then
  do_checkpoint "$TRIGGER"
  exit $?
else
  exit 0
fi
