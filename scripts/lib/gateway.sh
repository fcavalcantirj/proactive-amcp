#!/bin/bash
# gateway.sh — Shared gateway restart with Telegram lock safety
#
# Source this file from any script that needs to restart the gateway:
#   source "$SCRIPT_DIR/lib/gateway.sh"
#   safe_restart_gateway   # returns 0 on success, 1 on failure
#
# Handles:
#   - PID wait (up to GATEWAY_STOP_TIMEOUT seconds) + SIGKILL fallback
#   - Telegram lock release gap (TELEGRAM_LOCK_GAP seconds)
#   - Restart lock to prevent concurrent restarts
#
# Environment:
#   GATEWAY_SETTLE_TIME              Sleep after start for health settling (default: 8)
#   TELEGRAM_LOCK_GAP                Sleep after old process exits (default: 5)
#   GATEWAY_STOP_TIMEOUT             Max wait for old PID to exit (default: 15)
#   GATEWAY_RESTART_LOCK             Lock file path (default: ~/.amcp/gateway-restart.lock)

# Guard against double-source
[ -n "${_GATEWAY_LIB_LOADED:-}" ] && return 0
_GATEWAY_LIB_LOADED=1

GATEWAY_SETTLE_TIME="${GATEWAY_SETTLE_TIME:-8}"
TELEGRAM_LOCK_GAP="${TELEGRAM_LOCK_GAP:-5}"
GATEWAY_STOP_TIMEOUT="${GATEWAY_STOP_TIMEOUT:-15}"
GATEWAY_RESTART_LOCK="${GATEWAY_RESTART_LOCK:-$HOME/.amcp/gateway-restart.lock}"

# Log helper — callers can override _gw_log
_gw_log() {
  echo "[gateway] $1" >&2
}

# Acquire restart lock (60s TTL, stale detection)
_gw_acquire_lock() {
  if [ -f "$GATEWAY_RESTART_LOCK" ]; then
    local lock_pid
    lock_pid=$(cat "$GATEWAY_RESTART_LOCK" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      _gw_log "Another restart in progress (PID $lock_pid), skipping"
      return 1
    fi
    # Stale lock — check age
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -c %Y "$GATEWAY_RESTART_LOCK" 2>/dev/null || echo "0") ))
    if [ "$lock_age" -lt 60 ]; then
      _gw_log "Recent restart lock (${lock_age}s ago), skipping"
      return 1
    fi
    _gw_log "Removing stale restart lock (${lock_age}s old)"
  fi
  mkdir -p "$(dirname "$GATEWAY_RESTART_LOCK")"
  echo $$ > "$GATEWAY_RESTART_LOCK"
  return 0
}

_gw_release_lock() {
  rm -f "$GATEWAY_RESTART_LOCK"
}

# Wait for a specific PID to exit, SIGKILL if needed
_gw_wait_for_exit() {
  local pid="$1"
  if [ -z "$pid" ]; then
    return 0
  fi

  local waited=0
  while [ -d "/proc/$pid" ] && [ "$waited" -lt "$GATEWAY_STOP_TIMEOUT" ]; do
    sleep 1
    waited=$((waited + 1))
  done

  if [ -d "/proc/$pid" ]; then
    _gw_log "PID $pid still alive after ${waited}s, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi

  # Telegram lock release gap
  _gw_log "Waiting ${TELEGRAM_LOCK_GAP}s for Telegram lock release"
  sleep "$TELEGRAM_LOCK_GAP"
}

# Main function: safely restart the gateway
safe_restart_gateway() {
  if ! _gw_acquire_lock; then
    return 1
  fi

  # Capture old PID before any stop
  local old_pid=""
  old_pid=$(pgrep -f "openclaw-gateway" 2>/dev/null | head -1) || true

  # Try systemctl stop + start (not restart, for gap control)
  if systemctl --user stop openclaw-gateway 2>/dev/null; then
    _gw_wait_for_exit "$old_pid"
    if systemctl --user start openclaw-gateway 2>/dev/null; then
      sleep "$GATEWAY_SETTLE_TIME"
      _gw_release_lock
      _gw_log "Restarted via systemctl"
      return 0
    fi
  fi

  # Fallback: pkill + direct start
  if command -v openclaw &>/dev/null; then
    pkill -f "openclaw-gateway" 2>/dev/null || true
    _gw_wait_for_exit "$old_pid"
    nohup openclaw gateway start > /tmp/openclaw-gateway.log 2>&1 &
    sleep "$GATEWAY_SETTLE_TIME"
    _gw_release_lock
    _gw_log "Restarted directly"
    return 0
  fi

  _gw_release_lock
  _gw_log "Restart failed — no systemctl or openclaw available"
  return 1
}
