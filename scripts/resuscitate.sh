#!/bin/bash
# resuscitate.sh - Full resurrection flow
# Usage: ./resuscitate.sh [--from-cid <cid>]
#
# Solvr: SEARCH only (read-only). Agent posts after alive.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$HOME/bin/amcp}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
LAST_CHECKPOINT_FILE="$HOME/.amcp/last-checkpoint.json"
CONTENT_DIR="${CONTENT_DIR:-$HOME/.openclaw/workspace}"
AGENT_NAME="${AGENT_NAME:-Agent}"
RECOVERY_LOG="$HOME/.amcp/recovery-$(date +%Y%m%d-%H%M%S).log"
LOCK_FILE="$HOME/.amcp/resurrection.lock"
GATEWAY_SETTLE_TIME="${GATEWAY_SETTLE_TIME:-5}"

# Solvr config (READ-ONLY)
SOLVR_API_KEY="${SOLVR_API_KEY:-}"
SOLVR_BASE="https://api.solvr.dev/v1"

# Track temp files for cleanup
TEMP_FILES=()
cleanup() {
  rm -f "$LOCK_FILE"
  for f in "${TEMP_FILES[@]}"; do
    rm -rf "$f" 2>/dev/null || true
  done
}
trap cleanup EXIT

# --- Lock file: prevent concurrent resurrection ---
acquire_lock() {
  if [ -f "$LOCK_FILE" ]; then
    local existing_pid
    existing_pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "Resurrection already running (PID $existing_pid), exiting"
      # Exit without triggering cleanup trap (don't remove their lock)
      trap - EXIT
      exit 0
    fi
    # Stale lock — take over
    echo "Removing stale lock (PID $existing_pid)"
  fi
  mkdir -p "$(dirname "$LOCK_FILE")"
  echo $$ > "$LOCK_FILE"
}

# --- Gateway detection (single source of truth, matches watchdog patterns) ---
is_gateway_running() {
  if pgrep -f "openclaw-gateway" > /dev/null 2>&1; then
    return 0
  fi
  if pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Parse args
FROM_CID=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --from-cid) FROM_CID="$2"; shift 2 ;;
    --content-dir) CONTENT_DIR="$2"; shift 2 ;;
    --agent-name) AGENT_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate CID format if provided (alphanumeric, starts with Qm or bafy)
if [ -n "$FROM_CID" ]; then
  if ! echo "$FROM_CID" | grep -qE '^(Qm[a-zA-Z0-9]{44}|bafy[a-zA-Z0-9]{55,})$'; then
    echo "ERROR: Invalid CID format: $FROM_CID"
    echo "CIDs should start with 'Qm' (CIDv0) or 'bafy' (CIDv1)"
    exit 1
  fi
fi

# ============================================================
# Identity pre-flight — validate before operating
# ============================================================
validate_identity() {
  if [ ! -f "$IDENTITY_PATH" ]; then
    echo "FATAL: Invalid AMCP identity — run amcp identity create or amcp identity validate for details"
    exit 1
  fi
  if ! "$AMCP_CLI" identity validate --identity "$IDENTITY_PATH" 2>/dev/null; then
    echo "FATAL: Invalid AMCP identity — run amcp identity create or amcp identity validate for details"
    exit 1
  fi
}

validate_identity

# Warn if secrets found in identity.json (they belong in config.json)
warn_identity_secrets() {
  python3 -c "
import json, os, sys
p = os.path.expanduser('$IDENTITY_PATH')
if not os.path.exists(p): sys.exit(0)
d = json.load(open(p))
bad = [k for k in d if k in ('pinata_jwt','pinata_api_key','solvr_api_key','api_key','apiKey','jwt','token','secret','password','mnemonic','email','notifyTarget')]
if bad:
    print(f'WARNING: Secrets found in identity.json: {\", \".join(bad)}', file=sys.stderr)
    print('  Migrate with: proactive-amcp config set <key> <value>', file=sys.stderr)
" 2>&1 || true
}
warn_identity_secrets

# Acquire lock before doing anything
acquire_lock

mkdir -p "$(dirname "$RECOVERY_LOG")"

log() {
  echo "[$(date -Iseconds)] $1" | tee -a "$RECOVERY_LOG"
}

# Send email summary on resurrection completion
send_resurrection_email() {
  local status="$1"  # "success" or "failed"
  local method="$2"  # recovery method used
  local downtime="$3"  # seconds
  local log_file="$4"  # path to recovery log

  local subject="Agent Resurrection: $AGENT_NAME - ${status^^}"
  local body="
=== Agent Resurrection Report ===

Agent: $AGENT_NAME
Status: ${status^^}
Recovery Method: $method
Downtime: ${downtime}s
Timestamp: $(date -Iseconds)

=== Recovery Log ===
$(tail -50 "$log_file" 2>/dev/null || echo "Log not available")
"

  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "$body" --email "$subject"
}

# Solvr SEARCH only (no POST)
solvr_search() {
  local query="$1"
  if [ -n "$SOLVR_API_KEY" ]; then
    local result
    result=$(curl -s --max-time 10 "$SOLVR_BASE/search?q=$(echo "$query" | sed 's/ /+/g')" \
      -H "Authorization: Bearer $SOLVR_API_KEY" 2>/dev/null || echo '{}')

    # Log if we found solutions
    local count=$(echo "$result" | jq '.data | length' 2>/dev/null || echo "0")
    if [ "$count" != "0" ] && [ "$count" != "null" ]; then
      log "Solvr: Found $count potential solutions"
      echo "$result" | jq -r '.data[:3][] | "  - \(.title)"' 2>/dev/null || true
    fi
  else
    log "Solvr: No API key, skipping search"
  fi
}

# Recovery attempts
try_restart_gateway() {
  log "Attempting: restart gateway"

  # Try systemctl first
  if systemctl --user restart openclaw-gateway 2>/dev/null; then
    sleep "$GATEWAY_SETTLE_TIME"
    if is_gateway_running; then
      log "Gateway restarted via systemctl"
      return 0
    fi
  fi

  # Try direct restart
  if command -v openclaw &>/dev/null; then
    pkill -f "openclaw-gateway" 2>/dev/null || true
    sleep 2
    nohup openclaw gateway start > /tmp/openclaw-gateway.log 2>&1 &
    sleep "$GATEWAY_SETTLE_TIME"
    if is_gateway_running; then
      log "Gateway restarted directly"
      return 0
    fi
  fi

  return 1
}

try_fix_config() {
  # Gate: if gateway came up from a previous tier, skip
  if is_gateway_running; then
    log "Gateway already running, skipping config fix"
    return 0
  fi

  log "Attempting: fix config from backup"

  # Check for config backups
  local backup_dir="$HOME/.amcp/config-backups"
  if [ -d "$backup_dir" ]; then
    local latest_backup=$(ls -1t "$backup_dir"/openclaw-*.json 2>/dev/null | head -1)
    if [ -f "$latest_backup" ]; then
      log "Found backup: $latest_backup"

      # Validate JSON before restoring
      if jq . "$latest_backup" > /dev/null 2>&1; then
        cp "$HOME/.openclaw/openclaw.json" "$HOME/.openclaw/openclaw.json.pre-recovery" 2>/dev/null || true
        cp "$latest_backup" "$HOME/.openclaw/openclaw.json"
        log "Restored openclaw.json"

        # Try restart again
        if try_restart_gateway; then
          return 0
        fi
      else
        log "Backup JSON invalid, skipping"
      fi
    fi
  fi

  return 1
}

try_rehydrate() {
  local cid="$1"

  # Gate: if gateway came up from a previous tier, skip
  if is_gateway_running; then
    log "Gateway already running, skipping rehydrate"
    return 0
  fi

  log "Attempting: rehydrate from checkpoint ${cid:-local}"

  # Fetch from IPFS if CID provided
  local checkpoint_path=""
  if [ -n "$cid" ]; then
    checkpoint_path="/tmp/checkpoint-$cid.amcp"
    TEMP_FILES+=("$checkpoint_path")
    log "Fetching from IPFS: $cid"
    if curl -s --max-time 120 "https://gateway.pinata.cloud/ipfs/$cid" -o "$checkpoint_path"; then
      log "Downloaded checkpoint from IPFS"
    else
      log "Failed to fetch from IPFS"
      return 1
    fi
  else
    # Use local checkpoint
    if [ -f "$LAST_CHECKPOINT_FILE" ]; then
      checkpoint_path=$(jq -r '.localPath // empty' "$LAST_CHECKPOINT_FILE" 2>/dev/null)
    fi

    # Fallback: find latest local checkpoint
    if [ -z "$checkpoint_path" ] || [ ! -f "$checkpoint_path" ]; then
      checkpoint_path=$(ls -1t "$HOME/.amcp/checkpoints"/*.amcp 2>/dev/null | head -1)
    fi
  fi

  if [ -z "$checkpoint_path" ] || [ ! -f "$checkpoint_path" ]; then
    log "No checkpoint found"
    return 1
  fi

  log "Using checkpoint: $checkpoint_path"

  # Verify AMCP CLI exists
  if [ ! -x "$AMCP_CLI" ]; then
    log "AMCP CLI not found at $AMCP_CLI"
    return 1
  fi

  # Resuscitate (verify + decrypt)
  local secrets_file="/tmp/secrets-$$.json"
  local content_dir="/tmp/restored-$$"
  TEMP_FILES+=("$secrets_file" "$content_dir")

  if ! $AMCP_CLI resuscitate \
       --checkpoint "$checkpoint_path" \
       --identity "$IDENTITY_PATH" \
       --out-content "$content_dir" \
       --out-secrets "$secrets_file" 2>&1 | tee -a "$RECOVERY_LOG"; then
    log "Resuscitate command failed"
    return 1
  fi

  log "Checkpoint verified and decrypted"

  # Restore content to workspace
  if [ -d "$content_dir" ]; then
    log "Restoring content to $CONTENT_DIR..."
    mkdir -p "$CONTENT_DIR"

    # Restore workspace files (memory/, AGENTS.md, etc.)
    # Be careful not to overwrite code repos
    for item in "$content_dir"/*; do
      if [ -e "$item" ]; then
        local basename=$(basename "$item")
        # Skip directories that look like code repos
        if [[ "$basename" =~ ^(solvr|amcp-protocol|openclaw-|proactive-)$ ]]; then
          log "Skipping code repo: $basename"
          continue
        fi
        cp -r "$item" "$CONTENT_DIR/" 2>/dev/null || true
        log "Restored: $basename"
      fi
    done
  fi

  # Inject secrets
  if [ -f "$secrets_file" ] && [ -s "$secrets_file" ]; then
    log "Injecting secrets..."
    if [ -x "$SCRIPT_DIR/inject-secrets.sh" ]; then
      "$SCRIPT_DIR/inject-secrets.sh" "$secrets_file" 2>&1 | tee -a "$RECOVERY_LOG" || true
    else
      log "inject-secrets.sh not found, skipping"
    fi
  fi

  # Cleanup temp files
  rm -rf "$content_dir" "$secrets_file"
  [ -n "$cid" ] && rm -f "$checkpoint_path"

  # Restart gateway with restored config
  if try_restart_gateway; then
    return 0
  fi

  log "Gateway failed to start after rehydration"
  return 1
}

# Main resurrection flow
main() {
  local start_time=$(date +%s)

  log "========================================="
  log "=== AMCP Resurrection Started ==="
  log "========================================="
  log "Agent: $AGENT_NAME"
  log "Identity: $IDENTITY_PATH"
  log "Content dir: $CONTENT_DIR"
  log "Recovery log: $RECOVERY_LOG"

  # Notify start
  if [ -x "$SCRIPT_DIR/notify.sh" ]; then
    "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Starting resurrection..."
  fi

  # Step 1: Search Solvr for similar issues (READ-ONLY)
  log ""
  log "=== Step 1: Search Solvr for solutions ==="
  solvr_search "agent death gateway crash openclaw"
  solvr_search "checkpoint resurrection failed"

  # Step 2: Try recovery hierarchy (lightweight first)
  log ""
  log "=== Step 2: Recovery attempts ==="

  # 2a: Restart gateway
  log ""
  log "--- Attempt 1: Restart gateway ---"
  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Trying: restart gateway"

  if try_restart_gateway; then
    local end_time=$(date +%s)
    local downtime=$((end_time - start_time))
    log "✅ Recovery succeeded: restart gateway (${downtime}s)"
    [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Alive! Downtime: ${downtime}s. Method: restart"

    # Write recovery summary for agent to post to Solvr
    echo "{\"method\":\"restart\",\"downtime\":$downtime,\"timestamp\":\"$(date -Iseconds)\"}" > "$HOME/.amcp/last-recovery.json"

    # Send email summary
    send_resurrection_email "success" "restart" "$downtime" "$RECOVERY_LOG"
    return 0
  fi
  log "❌ Restart gateway failed"

  # 2b: Fix config
  log ""
  log "--- Attempt 2: Fix config ---"
  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Trying: fix config"

  if try_fix_config; then
    local end_time=$(date +%s)
    local downtime=$((end_time - start_time))
    log "✅ Recovery succeeded: fix config (${downtime}s)"
    [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Alive! Downtime: ${downtime}s. Method: config fix"

    echo "{\"method\":\"config_fix\",\"downtime\":$downtime,\"timestamp\":\"$(date -Iseconds)\"}" > "$HOME/.amcp/last-recovery.json"

    # Send email summary
    send_resurrection_email "success" "config_fix" "$downtime" "$RECOVERY_LOG"
    return 0
  fi
  log "❌ Fix config failed"

  # 2c: Rehydrate from checkpoint
  local cid="$FROM_CID"
  if [ -z "$cid" ] && [ -f "$LAST_CHECKPOINT_FILE" ]; then
    cid=$(jq -r '.cid // empty' "$LAST_CHECKPOINT_FILE" 2>/dev/null)
  fi

  log ""
  log "--- Attempt 3: Rehydrate from checkpoint ---"
  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Trying: rehydrate from checkpoint ${cid:-local}"

  if try_rehydrate "$cid"; then
    local end_time=$(date +%s)
    local downtime=$((end_time - start_time))
    log "✅ Recovery succeeded: rehydrate (${downtime}s)"
    [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Alive! Downtime: ${downtime}s. Method: checkpoint"

    echo "{\"method\":\"rehydrate\",\"cid\":\"$cid\",\"downtime\":$downtime,\"timestamp\":\"$(date -Iseconds)\"}" > "$HOME/.amcp/last-recovery.json"

    # Send email summary
    send_resurrection_email "success" "rehydrate" "$downtime" "$RECOVERY_LOG"
    return 0
  fi
  log "❌ Rehydrate failed"

  # All recovery methods failed
  local end_time=$(date +%s)
  local downtime=$((end_time - start_time))

  log ""
  log "========================================="
  log "❌ ALL RECOVERY METHODS FAILED"
  log "Elapsed: ${downtime}s"
  log "Human intervention required"
  log "========================================="

  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "❌ [$AGENT_NAME] Resurrection FAILED! Need human. Log: $RECOVERY_LOG"

  echo "{\"method\":\"failed\",\"downtime\":$downtime,\"timestamp\":\"$(date -Iseconds)\",\"log\":\"$RECOVERY_LOG\"}" > "$HOME/.amcp/last-recovery.json"

  # Send email summary (critical - always send on failure)
  send_resurrection_email "failed" "all_methods_exhausted" "$downtime" "$RECOVERY_LOG"
  return 1
}

main "$@"
