#!/bin/bash
# install.sh - Non-interactive AMCP setup for fleet tools (e.g. openclaw-deploy)
# Usage: ./install.sh [--pinata-jwt <jwt>] [--notify-target <id>]
#                     [--watchdog-interval <secs>] [--checkpoint-schedule <cron>]
#
# This wraps the init workflow with CLI flags for scripted, non-interactive use.
# All config values are written to ~/.amcp/config.json via config set.
# Exits 0 on success, 1 on failure with structured JSON error output.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$(command -v amcp 2>/dev/null || echo "$HOME/bin/amcp")}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"
AMCP_DIR="${AMCP_DIR:-$HOME/.amcp}"
AGENT_NAME="${AGENT_NAME:-$(hostname -s)}"

# Defaults
WATCHDOG_INTERVAL_DEFAULT=120
CHECKPOINT_SCHEDULE_DEFAULT="0 */4 * * *"

# Systemd paths
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
WATCHDOG_SERVICE="amcp-watchdog"
CHECKPOINT_TIMER="amcp-checkpoint"

# ============================================================
# Helpers
# ============================================================

log_info()  { echo "[install] INFO:  $*"; }
log_ok()    { echo "[install] OK:    $*"; }
log_warn()  { echo "[install] WARN:  $*" >&2; }
log_error() { echo "[install] ERROR: $*" >&2; }

# Structured JSON error output on failure
die_json() {
  local code="$1"
  local message="$2"
  local detail="${3:-}"
  cat >&2 <<EOF
{"error": true, "code": "$code", "message": "$message", "detail": "$detail"}
EOF
  exit 1
}

usage() {
  cat <<EOF
proactive-amcp install — Non-interactive setup for fleet tools

Usage: $(basename "$0") [OPTIONS]

Options:
  --pinata-jwt <jwt>              Pinata JWT for IPFS pinning
  --notify-target <telegram_id>   Telegram user ID for death/recovery alerts
  --watchdog-interval <seconds>   Watchdog check frequency (default: ${WATCHDOG_INTERVAL_DEFAULT}s)
  --checkpoint-schedule <cron>    Checkpoint cron expression (default: "${CHECKPOINT_SCHEDULE_DEFAULT}")
  --skip-services                 Write config + identity only, don't set up systemd/cron
  -h, --help                      Show this help

Examples:
  # Minimal install
  $(basename "$0") --pinata-jwt eyJhbGciOi...

  # Full install with alerts
  $(basename "$0") --pinata-jwt eyJhbGciOi... --notify-target 123456 --watchdog-interval 60

  # Config only (no services)
  $(basename "$0") --pinata-jwt eyJhbGciOi... --skip-services

All values are written to ~/.amcp/config.json. Exits 0 on success, 1 on failure.
EOF
  exit 0
}

# ============================================================
# Parse arguments
# ============================================================

FLAG_PINATA_JWT=""
FLAG_NOTIFY_TARGET=""
FLAG_WATCHDOG_INTERVAL=""
FLAG_CHECKPOINT_SCHEDULE=""
FLAG_SKIP_SERVICES=false

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --pinata-jwt)
        [ $# -lt 2 ] && die_json "missing_arg" "--pinata-jwt requires a value"
        FLAG_PINATA_JWT="$2"
        shift 2
        ;;
      --notify-target)
        [ $# -lt 2 ] && die_json "missing_arg" "--notify-target requires a value"
        FLAG_NOTIFY_TARGET="$2"
        shift 2
        ;;
      --watchdog-interval)
        [ $# -lt 2 ] && die_json "missing_arg" "--watchdog-interval requires a value"
        FLAG_WATCHDOG_INTERVAL="$2"
        # Validate it's a positive integer
        if ! [[ "$FLAG_WATCHDOG_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
          die_json "invalid_arg" "--watchdog-interval must be a positive integer" "$FLAG_WATCHDOG_INTERVAL"
        fi
        shift 2
        ;;
      --checkpoint-schedule)
        [ $# -lt 2 ] && die_json "missing_arg" "--checkpoint-schedule requires a value"
        FLAG_CHECKPOINT_SCHEDULE="$2"
        shift 2
        ;;
      --skip-services)
        FLAG_SKIP_SERVICES=true
        shift
        ;;
      -h|--help)
        usage
        ;;
      *)
        die_json "unknown_arg" "Unknown argument: $1"
        ;;
    esac
  done
}

# ============================================================
# Step 1: Identity — create if missing, validate if present
# ============================================================

install_identity() {
  log_info "Checking AMCP identity..."
  mkdir -p "$AMCP_DIR"

  if [ -f "$IDENTITY_PATH" ]; then
    # Validate existing identity
    if "$AMCP_CLI" identity validate --identity "$IDENTITY_PATH" 2>/dev/null; then
      log_ok "Identity valid at $IDENTITY_PATH"
      return 0
    else
      log_warn "Existing identity is invalid — replacing"
      local backup="${IDENTITY_PATH}.bak.$(date +%Y%m%d%H%M%S)"
      cp "$IDENTITY_PATH" "$backup"
      log_info "Backed up invalid identity to $backup"
    fi
  fi

  # Create new identity
  log_info "Creating new AMCP identity..."
  mkdir -p "$(dirname "$IDENTITY_PATH")"
  if "$AMCP_CLI" identity create --out "$IDENTITY_PATH" 2>/dev/null; then
    log_ok "Identity created at $IDENTITY_PATH"
  else
    die_json "identity_create_failed" "Failed to create AMCP identity" "Is 'amcp' CLI installed? Install: npm install -g @amcp/cli"
  fi
}

# ============================================================
# Step 2: Config — write values via config.sh
# ============================================================

install_config() {
  log_info "Writing config to $CONFIG_FILE..."

  local config_cmd="$SCRIPT_DIR/config.sh"

  if [ -n "$FLAG_PINATA_JWT" ]; then
    "$config_cmd" set pinata.jwt "$FLAG_PINATA_JWT"
    log_ok "Set pinata.jwt"
  fi

  if [ -n "$FLAG_NOTIFY_TARGET" ]; then
    "$config_cmd" set notify.target "$FLAG_NOTIFY_TARGET"
    log_ok "Set notify.target"
  fi

  local interval="${FLAG_WATCHDOG_INTERVAL:-$WATCHDOG_INTERVAL_DEFAULT}"
  "$config_cmd" set watchdog.interval "$interval"
  log_ok "Set watchdog.interval=$interval"

  local schedule="${FLAG_CHECKPOINT_SCHEDULE:-$CHECKPOINT_SCHEDULE_DEFAULT}"
  "$config_cmd" set checkpoint.schedule "$schedule"
  log_ok "Set checkpoint.schedule=$schedule"

  chmod 600 "$CONFIG_FILE"
}

# ============================================================
# Step 3: Services — systemd or cron (non-interactive)
# ============================================================

install_services() {
  if [ "$FLAG_SKIP_SERVICES" = true ]; then
    log_info "Skipping service setup (--skip-services)"
    return 0
  fi

  local interval="${FLAG_WATCHDOG_INTERVAL:-$WATCHDOG_INTERVAL_DEFAULT}"
  local schedule="${FLAG_CHECKPOINT_SCHEDULE:-$CHECKPOINT_SCHEDULE_DEFAULT}"

  # Try systemd first, fall back to cron
  if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
    install_watchdog_systemd "$interval"
    install_checkpoint_systemd "$schedule"
  else
    install_watchdog_cron "$interval"
    install_checkpoint_cron "$schedule"
  fi
}

# ---- Watchdog: systemd ----

install_watchdog_systemd() {
  local interval="$1"
  mkdir -p "$SYSTEMD_USER_DIR"

  cat > "$SYSTEMD_USER_DIR/${WATCHDOG_SERVICE}.service" <<EOF
[Unit]
Description=AMCP Watchdog — health monitor and recovery
After=network.target

[Service]
Type=simple
ExecStart=${SCRIPT_DIR}/watchdog.sh --continuous
Restart=on-failure
RestartSec=30
Environment=CHECK_INTERVAL=${interval}
Environment=IDENTITY_PATH=${IDENTITY_PATH}
Environment=AGENT_NAME=${AGENT_NAME}

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "$WATCHDOG_SERVICE" 2>/dev/null || true
  systemctl --user restart "$WATCHDOG_SERVICE" 2>/dev/null || true
  log_ok "Watchdog systemd service started (interval: ${interval}s)"
}

# ---- Watchdog: cron ----

install_watchdog_cron() {
  local interval="$1"
  local mins=$(( interval / 60 ))
  [ "$mins" -lt 1 ] && mins=1

  local cron_expr
  if [ "$mins" -lt 60 ]; then
    cron_expr="*/$mins * * * *"
  else
    cron_expr="0 */$((mins / 60)) * * *"
  fi

  local cron_line="$cron_expr ${SCRIPT_DIR}/watchdog.sh # amcp-watchdog"

  if crontab -l 2>/dev/null | grep -q "# amcp-watchdog"; then
    crontab -l 2>/dev/null | grep -v "# amcp-watchdog" | { cat; echo "$cron_line"; } | crontab -
  else
    { crontab -l 2>/dev/null || true; echo "$cron_line"; } | crontab -
  fi
  log_ok "Watchdog cron installed: $cron_expr"
}

# ---- Checkpoint: systemd ----

install_checkpoint_systemd() {
  local schedule="$1"
  mkdir -p "$SYSTEMD_USER_DIR"

  local on_calendar
  on_calendar=$(cron_to_oncalendar "$schedule")

  cat > "$SYSTEMD_USER_DIR/${CHECKPOINT_TIMER}.service" <<EOF
[Unit]
Description=AMCP Checkpoint — encrypt and pin to IPFS

[Service]
Type=oneshot
ExecStart=${SCRIPT_DIR}/checkpoint.sh --notify
Environment=IDENTITY_PATH=${IDENTITY_PATH}
Environment=AGENT_NAME=${AGENT_NAME}
EOF

  cat > "$SYSTEMD_USER_DIR/${CHECKPOINT_TIMER}.timer" <<EOF
[Unit]
Description=AMCP Checkpoint Timer

[Timer]
OnCalendar=${on_calendar}
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "${CHECKPOINT_TIMER}.timer" 2>/dev/null || true
  systemctl --user start "${CHECKPOINT_TIMER}.timer" 2>/dev/null || true
  log_ok "Checkpoint systemd timer started: $on_calendar"
}

# Convert cron expression to systemd OnCalendar (best-effort)
cron_to_oncalendar() {
  local cron="$1"
  local min hour dom mon dow
  read -r min hour dom mon dow <<< "$cron"

  # "0 */4 * * *" → "*-*-* 0/4:00:00"
  if [[ "$min" == "0" && "$hour" == "*/"* && "$dom" == "*" && "$mon" == "*" && "$dow" == "*" ]]; then
    local step="${hour#*/}"
    echo "*-*-* 0/${step}:00:00"
    return
  fi

  # "*/N * * * *" → "*-*-* *:0/N:00"
  if [[ "$min" == "*/"* && "$hour" == "*" && "$dom" == "*" && "$mon" == "*" && "$dow" == "*" ]]; then
    local step="${min#*/}"
    echo "*-*-* *:0/${step}:00"
    return
  fi

  # "M H * * *" → "*-*-* H:M:00"
  if [[ "$dom" == "*" && "$mon" == "*" && "$dow" == "*" ]]; then
    echo "*-*-* ${hour}:${min}:00"
    return
  fi

  # Fallback
  echo "*-*-* *:00:00"
}

# ---- Checkpoint: cron ----

install_checkpoint_cron() {
  local schedule="$1"
  local cron_line="$schedule ${SCRIPT_DIR}/checkpoint.sh --notify # amcp-checkpoint"

  if crontab -l 2>/dev/null | grep -q "# amcp-checkpoint"; then
    crontab -l 2>/dev/null | grep -v "# amcp-checkpoint" | { cat; echo "$cron_line"; } | crontab -
  else
    { crontab -l 2>/dev/null || true; echo "$cron_line"; } | crontab -
  fi
  log_ok "Checkpoint cron installed: $schedule"
}

# ============================================================
# Step 4: Solvr skill — install for Claude-powered diagnose
# ============================================================

install_solvr_skill() {
  local target_dir="$HOME/.claude/skills/solvr"

  # Skip if already installed
  if [[ -d "$target_dir" && -f "$target_dir/scripts/solvr.sh" ]]; then
    log_ok "Solvr skill already installed at $target_dir"
    return 0
  fi

  log_info "Installing Solvr skill from solvr.dev..."

  if curl -sL --connect-timeout 10 --max-time 30 "https://solvr.dev/install.sh" | bash 2>/dev/null; then
    log_ok "Solvr skill installed from solvr.dev"
    return 0
  fi

  log_warn "Solvr skill not installed (network unavailable) — diagnose will skip Solvr"
}

# ============================================================
# Step 5: Summary — structured JSON on success
# ============================================================

print_summary() {
  log_ok "Install complete"
  cat <<EOF
{"success": true, "identity": "$IDENTITY_PATH", "config": "$CONFIG_FILE", "services": $([ "$FLAG_SKIP_SERVICES" = true ] && echo '"skipped"' || echo '"installed"')}
EOF
}

# ============================================================
# Main
# ============================================================

main() {
  parse_args "$@"

  log_info "proactive-amcp install (non-interactive)"

  install_identity
  install_config
  install_solvr_skill

  install_services
  print_summary

  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "[${AGENT_NAME}] AMCP install complete — identity valid, config written" || true
}

main "$@"
