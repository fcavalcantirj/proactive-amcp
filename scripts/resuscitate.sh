#!/bin/bash
# resuscitate.sh - Full resurrection flow with Solvr integration
# Usage: ./resuscitate.sh [--from-cid <cid>]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$HOME/bin/amcp}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
LAST_CHECKPOINT_FILE="$HOME/.amcp/last-checkpoint.json"
CONTENT_DIR="${CONTENT_DIR:-$HOME/clawd}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"
RECOVERY_LOG="$HOME/.amcp/recovery-$(date +%Y%m%d-%H%M%S).log"

# Solvr config
SOLVR_API_KEY="${SOLVR_API_KEY:-$(python3 -c "import json; d=json.load(open('$HOME/.openclaw/openclaw.json')); print(d.get('skills',{}).get('entries',{}).get('solvr',{}).get('apiKey',''))" 2>/dev/null || echo '')}"
SOLVR_BASE="https://api.solvr.dev/v1"

# Parse args
FROM_CID=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --from-cid) FROM_CID="$2"; shift 2 ;;
    *) shift ;;
  esac
done

mkdir -p "$(dirname "$RECOVERY_LOG")"

log() {
  echo "[$(date -Iseconds)] $1" | tee -a "$RECOVERY_LOG"
}

# Solvr functions
solvr_search() {
  local query="$1"
  if [ -n "$SOLVR_API_KEY" ]; then
    curl -s "$SOLVR_BASE/search?q=$(echo "$query" | sed 's/ /+/g')" \
      -H "Authorization: Bearer $SOLVR_API_KEY" 2>/dev/null || echo '{}'
  fi
}

solvr_post_problem() {
  local title="$1"
  local desc="$2"
  if [ -n "$SOLVR_API_KEY" ]; then
    curl -s -X POST "$SOLVR_BASE/posts" \
      -H "Authorization: Bearer $SOLVR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"problem\",\"title\":\"$title\",\"description\":\"$desc\",\"tags\":[\"agent-death\",\"amcp\",\"recovery\"]}" 2>/dev/null || echo '{}'
  fi
}

solvr_post_approach() {
  local problem_id="$1"
  local approach="$2"
  if [ -n "$SOLVR_API_KEY" ] && [ -n "$problem_id" ]; then
    curl -s -X POST "$SOLVR_BASE/problems/$problem_id/approaches" \
      -H "Authorization: Bearer $SOLVR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"angle\":\"$approach\"}" 2>/dev/null || echo '{}'
  fi
}

solvr_update_approach() {
  local approach_id="$1"
  local status="$2"  # succeeded, failed
  local notes="$3"
  if [ -n "$SOLVR_API_KEY" ] && [ -n "$approach_id" ]; then
    curl -s -X PATCH "$SOLVR_BASE/approaches/$approach_id" \
      -H "Authorization: Bearer $SOLVR_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"status\":\"$status\",\"notes\":\"$notes\"}" 2>/dev/null || echo '{}'
  fi
}

# Recovery attempts
try_restart_gateway() {
  log "Attempting: restart gateway"
  
  # Try systemctl first
  if systemctl --user restart openclaw-gateway 2>/dev/null; then
    sleep 3
    if curl -s --max-time 5 "http://localhost:3141/health" > /dev/null 2>&1; then
      return 0
    fi
  fi
  
  # Try direct restart
  if command -v openclaw &>/dev/null; then
    pkill -f "openclaw-gateway" 2>/dev/null || true
    sleep 2
    nohup openclaw gateway start > /tmp/openclaw-gateway.log 2>&1 &
    sleep 5
    if curl -s --max-time 5 "http://localhost:3141/health" > /dev/null 2>&1; then
      return 0
    fi
  fi
  
  return 1
}

try_fix_config() {
  log "Attempting: fix config from backup"
  
  # Check for config backups
  local backup_dir="$HOME/.amcp/backups"
  if [ -d "$backup_dir" ]; then
    local latest_backup=$(ls -1td "$backup_dir"/*/ 2>/dev/null | head -1)
    if [ -d "$latest_backup" ]; then
      log "Found backup: $latest_backup"
      
      # Restore openclaw.json if exists
      if [ -f "$latest_backup/openclaw.json" ]; then
        cp "$latest_backup/openclaw.json" "$HOME/.openclaw/openclaw.json"
        log "Restored openclaw.json"
      fi
      
      # Try restart again
      if try_restart_gateway; then
        return 0
      fi
    fi
  fi
  
  return 1
}

try_rehydrate() {
  local cid="$1"
  log "Attempting: rehydrate from checkpoint $cid"
  
  # Fetch from IPFS if CID provided
  local checkpoint_path=""
  if [ -n "$cid" ]; then
    checkpoint_path="/tmp/checkpoint-$cid.amcp"
    log "Fetching from IPFS..."
    if curl -s --max-time 60 "https://gateway.pinata.cloud/ipfs/$cid" -o "$checkpoint_path"; then
      log "Downloaded checkpoint from IPFS"
    else
      log "Failed to fetch from IPFS"
      return 1
    fi
  else
    # Use local checkpoint
    if [ -f "$LAST_CHECKPOINT_FILE" ]; then
      checkpoint_path=$(python3 -c "import json; print(json.load(open('$LAST_CHECKPOINT_FILE')).get('localPath',''))" 2>/dev/null)
    fi
  fi
  
  if [ -z "$checkpoint_path" ] || [ ! -f "$checkpoint_path" ]; then
    log "No checkpoint found"
    return 1
  fi
  
  log "Checkpoint: $checkpoint_path"
  
  # Resuscitate (verify + decrypt)
  local secrets_file="/tmp/secrets-$$.json"
  local content_dir="/tmp/restored-$$"
  
  if ! $AMCP_CLI resuscitate --checkpoint "$checkpoint_path" --identity "$IDENTITY_PATH" \
       --out-content "$content_dir" --out-secrets "$secrets_file" 2>&1 | tee -a "$RECOVERY_LOG"; then
    log "Resuscitate failed"
    return 1
  fi
  
  log "Checkpoint verified and decrypted"
  
  # Restore content
  if [ -d "$content_dir" ]; then
    log "Restoring content to $CONTENT_DIR..."
    cp -r "$content_dir"/* "$CONTENT_DIR/" 2>/dev/null || true
  fi
  
  # Inject secrets
  if [ -f "$secrets_file" ]; then
    log "Injecting secrets..."
    "$SCRIPT_DIR/inject-secrets.sh" "$secrets_file" 2>&1 | tee -a "$RECOVERY_LOG"
  fi
  
  # Cleanup
  rm -rf "$content_dir" "$secrets_file"
  [ -n "$cid" ] && rm -f "$checkpoint_path"
  
  # Restart gateway
  if try_restart_gateway; then
    return 0
  fi
  
  return 1
}

# Main resurrection flow
main() {
  local start_time=$(date +%s)
  local problem_id=""
  local approach_id=""
  
  log "=== AMCP Resurrection ==="
  log "Agent: $AGENT_NAME"
  log "Identity: $IDENTITY_PATH"
  
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Starting resurrection..."
  
  # Step 1: Search Solvr for similar issues
  log "Searching Solvr for similar deaths..."
  local search_result=$(solvr_search "agent death gateway crash")
  log "Solvr search complete"
  
  # Step 2: Post problem to Solvr
  log "Posting problem to Solvr..."
  local problem_response=$(solvr_post_problem \
    "Agent death: $AGENT_NAME - $(date -Iseconds)" \
    "Agent $AGENT_NAME died and is attempting resurrection")
  problem_id=$(echo "$problem_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo '')
  [ -n "$problem_id" ] && log "Solvr problem ID: $problem_id"
  
  # Step 3: Try recovery hierarchy
  
  # 3a: Restart gateway
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Trying: restart gateway"
  approach_id=$(echo "$(solvr_post_approach "$problem_id" "restart gateway")" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo '')
  
  if try_restart_gateway; then
    log "✅ Recovery succeeded: restart gateway"
    solvr_update_approach "$approach_id" "succeeded" "Gateway restart worked"
    
    local end_time=$(date +%s)
    local downtime=$((end_time - start_time))
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Alive! Downtime: ${downtime}s. Method: restart gateway"
    return 0
  else
    log "❌ Restart gateway failed"
    solvr_update_approach "$approach_id" "failed" "Gateway restart did not work"
  fi
  
  # 3b: Fix config
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Trying: fix config"
  approach_id=$(echo "$(solvr_post_approach "$problem_id" "fix config from backup")" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo '')
  
  if try_fix_config; then
    log "✅ Recovery succeeded: fix config"
    solvr_update_approach "$approach_id" "succeeded" "Config fix worked"
    
    local end_time=$(date +%s)
    local downtime=$((end_time - start_time))
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Alive! Downtime: ${downtime}s. Method: config fix"
    return 0
  else
    log "❌ Fix config failed"
    solvr_update_approach "$approach_id" "failed" "Config fix did not work"
  fi
  
  # 3c: Rehydrate from checkpoint
  local cid="$FROM_CID"
  [ -z "$cid" ] && cid=$(python3 -c "import json; print(json.load(open('$LAST_CHECKPOINT_FILE')).get('cid',''))" 2>/dev/null || echo '')
  
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Trying: rehydrate from checkpoint ${cid:-local}"
  approach_id=$(echo "$(solvr_post_approach "$problem_id" "rehydrate from checkpoint $cid")" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo '')
  
  if try_rehydrate "$cid"; then
    log "✅ Recovery succeeded: rehydrate"
    solvr_update_approach "$approach_id" "succeeded" "Full rehydration worked"
    
    local end_time=$(date +%s)
    local downtime=$((end_time - start_time))
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Alive! Downtime: ${downtime}s. Method: checkpoint rehydration" \
      "Agent Resurrection: $AGENT_NAME - SUCCESS"
    return 0
  else
    log "❌ Rehydrate failed"
    solvr_update_approach "$approach_id" "failed" "Checkpoint rehydration did not work"
  fi
  
  # All recovery methods failed
  local end_time=$(date +%s)
  local downtime=$((end_time - start_time))
  log "❌ All recovery methods failed after ${downtime}s"
  "$SCRIPT_DIR/notify.sh" "❌ [$AGENT_NAME] Resurrection FAILED! All methods exhausted. Need human intervention." \
    "Agent Resurrection: $AGENT_NAME - FAILED"
  
  return 1
}

main "$@"
