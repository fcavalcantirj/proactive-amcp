#!/bin/bash
# auto-checkpoint.sh - Continuous checkpoint runner
# Usage: ./auto-checkpoint.sh [--interval <minutes>]
#
# Pattern: ralph-continuous style
# - Telegram notification at START of batch
# - Telegram notification at END of batch
# - 3 minute pause between batches (configurable)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"
INTERVAL_MINS="${INTERVAL_MINS:-60}"  # Default 1 hour between checkpoints
BATCH_PAUSE_MINS="${BATCH_PAUSE_MINS:-3}"  # 3 minutes between batches
BATCH_PAUSE_SECS=$((BATCH_PAUSE_MINS * 60))

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --interval) INTERVAL_MINS="$2"; shift 2 ;;
    --pause) BATCH_PAUSE_MINS="$2"; BATCH_PAUSE_SECS=$((BATCH_PAUSE_MINS * 60)); shift 2 ;;
    *) shift ;;
  esac
done

INTERVAL_SECS=$((INTERVAL_MINS * 60))

format_time() {
  local secs=$1
  printf "%02d:%02d:%02d" $((secs/3600)) $((secs%3600/60)) $((secs%60))
}

checkpoint_count=0
runner_start=$(date +%s)

trap 'echo "Interrupted"; "$SCRIPT_DIR/notify.sh" "⏹️ [$AGENT_NAME] Auto-checkpoint stopped"; exit 1' INT TERM

echo "=== AMCP Auto-Checkpoint ==="
echo "Agent: $AGENT_NAME"
echo "Checkpoint interval: ${INTERVAL_MINS}m"
echo "Batch pause: ${BATCH_PAUSE_MINS}m"
echo ""

"$SCRIPT_DIR/notify.sh" "🚀 [$AGENT_NAME] Auto-checkpoint started. Interval: ${INTERVAL_MINS}m, pause: ${BATCH_PAUSE_MINS}m"

while true; do
  checkpoint_count=$((checkpoint_count + 1))
  batch_start=$(date +%s)
  
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ CHECKPOINT #${checkpoint_count}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  # Notify START
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Checkpoint #${checkpoint_count} starting..."
  
  # Run checkpoint
  if "$SCRIPT_DIR/checkpoint.sh"; then
    batch_end=$(date +%s)
    batch_time=$((batch_end - batch_start))
    total_time=$((batch_end - runner_start))
    
    # Get CID from last checkpoint
    CID=$(python3 -c "import json; print(json.load(open('$HOME/.amcp/last-checkpoint.json')).get('cid','local'))" 2>/dev/null || echo 'local')
    
    # Notify END (success)
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Checkpoint #${checkpoint_count} complete. CID: $CID. Took: $(format_time $batch_time). Total uptime: $(format_time $total_time)"
  else
    batch_end=$(date +%s)
    batch_time=$((batch_end - batch_start))
    
    # Notify END (failure)
    "$SCRIPT_DIR/notify.sh" "❌ [$AGENT_NAME] Checkpoint #${checkpoint_count} FAILED after $(format_time $batch_time)"
  fi
  
  echo ""
  # Wait for the remaining interval (guard against negative if pause >= interval)
  local remaining=$((INTERVAL_SECS - BATCH_PAUSE_SECS))
  if [ "$remaining" -gt 0 ]; then
    echo "⏸️  Pausing ${BATCH_PAUSE_MINS}m before next interval check..."
    sleep $BATCH_PAUSE_SECS
    echo "⏳ Waiting remaining time until next checkpoint..."
    sleep $remaining
  else
    echo "⏸️  Waiting ${INTERVAL_MINS}m until next checkpoint..."
    sleep $INTERVAL_SECS
  fi
done
