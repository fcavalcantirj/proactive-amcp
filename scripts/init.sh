#!/bin/bash
# init.sh - Interactive AMCP setup
# Usage: ./init.sh [--non-interactive]
#
# Steps:
#   1. Check/create ~/.amcp/identity.json
#   2. Set up watchdog (systemd or cron fallback)
#   3. Set up checkpoint cron schedule
#   4. Write config to ~/.amcp/config.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$(command -v amcp 2>/dev/null || echo "$HOME/bin/amcp")}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"
AMCP_DIR="${AMCP_DIR:-$HOME/.amcp}"
AGENT_NAME="${AGENT_NAME:-$(hostname -s)}"

# Watchdog defaults
WATCHDOG_INTERVAL="${WATCHDOG_INTERVAL:-120}"  # seconds
CHECKPOINT_SCHEDULE="${CHECKPOINT_SCHEDULE:-0 */4 * * *}"  # every 4 hours

# Systemd paths
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
WATCHDOG_SERVICE="amcp-watchdog"
CHECKPOINT_TIMER="amcp-checkpoint"

# ============================================================
# Helpers
# ============================================================

info()  { echo "  → $*"; }
ok()    { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*" >&2; }
fail()  { echo "  ✗ $*" >&2; }
header() { echo ""; echo "═══ $* ═══"; }

prompt_yn() {
  local msg="$1" default="${2:-y}"
  local yn
  if [ "$default" = "y" ]; then
    read -rp "  $msg [Y/n] " yn
    yn="${yn:-y}"
  else
    read -rp "  $msg [y/N] " yn
    yn="${yn:-n}"
  fi
  [[ "$yn" =~ ^[Yy] ]]
}

prompt_value() {
  local msg="$1" default="${2:-}"
  local val
  if [ -n "$default" ]; then
    read -rp "  $msg [$default]: " val
    echo "${val:-$default}"
  else
    read -rp "  $msg: " val
    echo "$val"
  fi
}

# ============================================================
# Step 1: Identity
# ============================================================

setup_identity() {
  header "Step 1: AMCP Identity"

  mkdir -p "$AMCP_DIR"

  if [ -f "$IDENTITY_PATH" ]; then
    info "Found identity at $IDENTITY_PATH"

    # Validate it
    if "$AMCP_CLI" identity validate --identity "$IDENTITY_PATH" 2>/dev/null; then
      ok "Identity is valid"
      return 0
    else
      warn "Identity exists but is INVALID (possibly fake/placeholder)"
      if prompt_yn "Replace with a fresh identity?"; then
        local backup="${IDENTITY_PATH}.bak.$(date +%Y%m%d%H%M%S)"
        cp "$IDENTITY_PATH" "$backup"
        info "Backed up old identity to $backup"
        create_identity
      else
        fail "Cannot continue with invalid identity"
        exit 1
      fi
    fi
  else
    info "No identity found at $IDENTITY_PATH"
    info "Creating new AMCP identity..."
    create_identity
  fi
}

create_identity() {
  mkdir -p "$(dirname "$IDENTITY_PATH")"
  if "$AMCP_CLI" identity create --out "$IDENTITY_PATH" 2>/dev/null; then
    ok "Identity created at $IDENTITY_PATH"
  else
    fail "Failed to create identity. Is 'amcp' CLI installed?"
    echo ""
    echo "  Install: npm install -g @amcp/cli"
    echo "  Or:      go install github.com/fcavalcantirj/amcp-protocol/cmd/amcp@latest"
    exit 1
  fi
}

# ============================================================
# Step 2: Config
# ============================================================

setup_config() {
  header "Step 2: Configuration"

  mkdir -p "$AMCP_DIR"

  # Load existing config or start fresh
  local existing_config="{}"
  if [ -f "$CONFIG_FILE" ]; then
    existing_config=$(cat "$CONFIG_FILE")
    info "Found existing config at $CONFIG_FILE"
  else
    info "No config found — creating $CONFIG_FILE"
  fi

  # ============================================================
  # IPFS Pinning — Solvr (free) or Pinata (own account)
  # ============================================================
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │  📌 IPFS PINNING                                        │"
  echo "  │                                                         │"
  echo "  │  Your checkpoints need to be pinned to IPFS so they    │"
  echo "  │  persist and can be retrieved from anywhere.           │"
  echo "  │                                                         │"
  echo "  │  Option 1: SOLVR (recommended)                         │"
  echo "  │    • Free tier — no account needed                     │"
  echo "  │    • Integrated with agent knowledge network           │"
  echo "  │    • Just works out of the box                         │"
  echo "  │                                                         │"
  echo "  │  Option 2: PINATA (self-managed)                       │"
  echo "  │    • Your own Pinata account                           │"
  echo "  │    • Full control over your pins                       │"
  echo "  │    • Requires API key setup                            │"
  echo "  └─────────────────────────────────────────────────────────┘"
  echo ""

  local current_provider
  current_provider=$(echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ipfs',{}).get('provider',''))" 2>/dev/null || echo "")

  if [ -n "$current_provider" ]; then
    ok "IPFS provider already configured: $current_provider"
  else
    if prompt_yn "Use Solvr for free IPFS pinning? (recommended)"; then
      existing_config=$(echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('ipfs', {})['provider'] = 'solvr'
json.dump(d, sys.stdout, indent=2)
")
      ok "Solvr pinning enabled — no API key needed!"
    else
      info "Using Pinata instead."
      info "Get a free API key at: https://pinata.cloud → API Keys → New Key"
      local jwt
      jwt=$(prompt_value "Pinata JWT (or press Enter to skip)")
      if [ -n "$jwt" ]; then
        existing_config=$(echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('pinata', {})['jwt'] = '$jwt'
d.setdefault('ipfs', {})['provider'] = 'pinata'
json.dump(d, sys.stdout, indent=2)
")
        ok "Pinata JWT saved"
      else
        warn "Skipped — checkpoints won't be pinned until configured"
        warn "Set later: proactive-amcp config set pinata.jwt <jwt>"
      fi
    fi
  fi

  # ============================================================
  # Groq — Intelligent Memory Pruning (optional)
  # ============================================================
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │  🧠 INTELLIGENT MEMORY (optional)                       │"
  echo "  │                                                         │"
  echo "  │  Groq can make your agent smarter by:                  │"
  echo "  │    • Evaluating what memories are worth keeping        │"
  echo "  │    • Condensing verbose logs into insights             │"
  echo "  │    • Pruning noise while preserving lessons            │"
  echo "  │                                                         │"
  echo "  │  Why? Your context window is limited. Groq helps your  │"
  echo "  │  agent remember what matters and forget what doesn't.  │"
  echo "  │                                                         │"
  echo "  │  Free tier at: https://console.groq.com                │"
  echo "  └─────────────────────────────────────────────────────────┘"
  echo ""

  local current_groq
  current_groq=$(echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('groq',{}).get('apiKey',''))" 2>/dev/null || echo "")

  if [ -n "$current_groq" ]; then
    ok "Groq API key already configured"
  else
    if prompt_yn "Enable Groq intelligent memory? (optional)" "n"; then
      local groq_key
      groq_key=$(prompt_value "Groq API key")
      if [ -n "$groq_key" ]; then
        existing_config=$(echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('groq', {})['apiKey'] = '$groq_key'
d['groq']['model'] = 'llama-3.3-70b-versatile'
json.dump(d, sys.stdout, indent=2)
")
        ok "Groq enabled — your agent just got smarter!"
      fi
    else
      info "Skipped — you can enable later with: proactive-amcp config set groq.apiKey <key>"
    fi
  fi

  # Notify target (Telegram user ID)
  local current_notify
  current_notify=$(echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('notify',{}).get('target',''))" 2>/dev/null || echo "")

  if [ -n "$current_notify" ]; then
    ok "Notify target already configured: $current_notify"
  else
    echo ""
    local notify_target
    notify_target=$(prompt_value "Telegram user ID for alerts (or press Enter to skip)")
    if [ -n "$notify_target" ]; then
      existing_config=$(echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('notify', {})['target'] = '$notify_target'
json.dump(d, sys.stdout, indent=2)
")
      ok "Notify target saved"
    else
      warn "Skipped — no death/recovery alerts until configured"
    fi
  fi

  # Watchdog interval
  local current_interval
  current_interval=$(echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('watchdog',{}).get('interval',''))" 2>/dev/null || echo "")

  local interval="${current_interval:-$WATCHDOG_INTERVAL}"
  interval=$(prompt_value "Watchdog check interval (seconds)" "$interval")
  existing_config=$(echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('watchdog', {})['interval'] = int('$interval')
json.dump(d, sys.stdout, indent=2)
")

  # Checkpoint schedule
  local current_schedule
  current_schedule=$(echo "$existing_config" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('checkpoint',{}).get('schedule',''))" 2>/dev/null || echo "")

  local schedule="${current_schedule:-$CHECKPOINT_SCHEDULE}"
  schedule=$(prompt_value "Checkpoint cron schedule" "$schedule")
  existing_config=$(echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('checkpoint', {})['schedule'] = '''$schedule'''
json.dump(d, sys.stdout, indent=2)
")

  # Write config
  echo "$existing_config" | python3 -c "
import json, sys
d = json.load(sys.stdin)
json.dump(d, sys.stdout, indent=2)
" > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  ok "Config written to $CONFIG_FILE"
}

# ============================================================
# Learning storage — create Problem/Learning entity stores
# ============================================================

setup_learning_storage() {
  local workspace
  workspace=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.openclaw/openclaw.json'))); print(d.get('agents',{}).get('defaults',{}).get('workspace','~/.openclaw/workspace'))" 2>/dev/null || echo "$HOME/.openclaw/workspace")
  workspace="${workspace/#\~/$HOME}"
  local learning_dir="$workspace/memory/learning"

  if [ -d "$learning_dir" ] && [ -f "$learning_dir/stats.json" ]; then
    info "Learning storage already exists at $learning_dir"
    return 0
  fi

  mkdir -p "$learning_dir"

  # problems.jsonl — append-only log of Problem entities
  if [ ! -f "$learning_dir/problems.jsonl" ]; then
    touch "$learning_dir/problems.jsonl"
  fi

  # learnings.jsonl — append-only log of Learning entities
  if [ ! -f "$learning_dir/learnings.jsonl" ]; then
    touch "$learning_dir/learnings.jsonl"
  fi

  # stats.json — aggregated statistics
  if [ ! -f "$learning_dir/stats.json" ]; then
    cat > "$learning_dir/stats.json" <<'EOJSON'
{
  "total_problems": 0,
  "total_solved": 0,
  "solved_post_recovery": 0,
  "total_learnings": 0,
  "last_updated": null
}
EOJSON
  fi

  ok "Learning storage initialized at $learning_dir"
}

# ============================================================
# Step 3: Watchdog service
# ============================================================

setup_watchdog() {
  header "Step 3: Watchdog Service"

  local interval
  interval=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('watchdog',{}).get('interval', $WATCHDOG_INTERVAL))" 2>/dev/null || echo "$WATCHDOG_INTERVAL")

  # Try systemd first
  if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
    info "systemd user session available — setting up service"
    setup_watchdog_systemd "$interval"
  else
    info "systemd not available — falling back to cron"
    setup_watchdog_cron "$interval"
  fi
}

setup_watchdog_systemd() {
  local interval="$1"

  mkdir -p "$SYSTEMD_USER_DIR"

  # Write service unit
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
  ok "Wrote ${WATCHDOG_SERVICE}.service"

  # Reload and enable
  systemctl --user daemon-reload
  systemctl --user enable "$WATCHDOG_SERVICE" 2>/dev/null || true

  if prompt_yn "Start watchdog now?"; then
    systemctl --user restart "$WATCHDOG_SERVICE"
    ok "Watchdog started (interval: ${interval}s)"
    info "Check status: systemctl --user status $WATCHDOG_SERVICE"
  else
    info "Start later: systemctl --user start $WATCHDOG_SERVICE"
  fi
}

setup_watchdog_cron() {
  local interval="$1"
  local cron_expr

  # Convert seconds to nearest cron-compatible minute interval
  local mins=$(( interval / 60 ))
  [ "$mins" -lt 1 ] && mins=1

  if [ "$mins" -lt 60 ]; then
    cron_expr="*/$mins * * * *"
  else
    cron_expr="0 */$((mins / 60)) * * *"
  fi

  local cron_line="$cron_expr ${SCRIPT_DIR}/watchdog.sh # amcp-watchdog"

  # Check if already installed
  if crontab -l 2>/dev/null | grep -q "# amcp-watchdog"; then
    info "Watchdog cron entry already exists — updating"
    # Remove old entry, add new
    crontab -l 2>/dev/null | grep -v "# amcp-watchdog" | { cat; echo "$cron_line"; } | crontab -
  else
    # Append to existing crontab
    { crontab -l 2>/dev/null || true; echo "$cron_line"; } | crontab -
  fi

  ok "Watchdog cron installed: $cron_expr"
  info "View: crontab -l | grep amcp"
}

# ============================================================
# Step 4: Checkpoint schedule
# ============================================================

setup_checkpoint() {
  header "Step 4: Checkpoint Schedule"

  local schedule
  schedule=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('checkpoint',{}).get('schedule', '$CHECKPOINT_SCHEDULE'))" 2>/dev/null || echo "$CHECKPOINT_SCHEDULE")

  # Try systemd timer first
  if command -v systemctl &>/dev/null && systemctl --user status &>/dev/null 2>&1; then
    info "systemd user session available — setting up timer"
    setup_checkpoint_systemd "$schedule"
  else
    info "systemd not available — falling back to cron"
    setup_checkpoint_cron "$schedule"
  fi
}

setup_checkpoint_systemd() {
  local schedule="$1"

  mkdir -p "$SYSTEMD_USER_DIR"

  # Convert cron to OnCalendar (best-effort)
  local on_calendar
  on_calendar=$(cron_to_oncalendar "$schedule")

  # Write service unit
  cat > "$SYSTEMD_USER_DIR/${CHECKPOINT_TIMER}.service" <<EOF
[Unit]
Description=AMCP Checkpoint — encrypt and pin to IPFS

[Service]
Type=oneshot
ExecStart=${SCRIPT_DIR}/checkpoint.sh --notify
Environment=IDENTITY_PATH=${IDENTITY_PATH}
Environment=AGENT_NAME=${AGENT_NAME}
EOF

  # Write timer unit
  cat > "$SYSTEMD_USER_DIR/${CHECKPOINT_TIMER}.timer" <<EOF
[Unit]
Description=AMCP Checkpoint Timer

[Timer]
OnCalendar=${on_calendar}
Persistent=true

[Install]
WantedBy=timers.target
EOF

  ok "Wrote ${CHECKPOINT_TIMER}.service + .timer"

  systemctl --user daemon-reload
  systemctl --user enable "${CHECKPOINT_TIMER}.timer" 2>/dev/null || true

  if prompt_yn "Start checkpoint timer now?"; then
    systemctl --user start "${CHECKPOINT_TIMER}.timer"
    ok "Checkpoint timer started: $on_calendar"
    info "Check: systemctl --user list-timers | grep amcp"
  else
    info "Start later: systemctl --user start ${CHECKPOINT_TIMER}.timer"
  fi
}

cron_to_oncalendar() {
  local cron="$1"
  # Best-effort cron → systemd OnCalendar conversion
  # Handles common patterns; falls back to hourly
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

setup_checkpoint_cron() {
  local schedule="$1"
  local cron_line="$schedule ${SCRIPT_DIR}/checkpoint.sh --notify # amcp-checkpoint"

  # Check if already installed
  if crontab -l 2>/dev/null | grep -q "# amcp-checkpoint"; then
    info "Checkpoint cron entry already exists — updating"
    crontab -l 2>/dev/null | grep -v "# amcp-checkpoint" | { cat; echo "$cron_line"; } | crontab -
  else
    { crontab -l 2>/dev/null || true; echo "$cron_line"; } | crontab -
  fi

  ok "Checkpoint cron installed: $schedule"
  info "View: crontab -l | grep amcp"
}

# ============================================================
# Step 5: Summary
# ============================================================

print_summary() {
  header "Setup Complete"

  echo ""
  echo "  Identity:    $IDENTITY_PATH"
  echo "  Config:      $CONFIG_FILE"
  echo "  Watchdog:    active"
  echo "  Checkpoints: scheduled"
  echo ""
  echo "  Next steps:"
  echo "    • Run your first checkpoint:  ${SCRIPT_DIR}/checkpoint.sh"
  echo "    • Check watchdog status:      systemctl --user status $WATCHDOG_SERVICE"
  echo "    • View config:                cat $CONFIG_FILE"
  echo ""
  echo "  Save your identity file! If you lose $IDENTITY_PATH,"
  echo "  you cannot decrypt your checkpoints."
  echo ""
}

# ============================================================
# Main
# ============================================================

show_intro() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║                    proactive-amcp                            ║"
  echo "║         Agent Memory Continuity Protocol                     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  🧠 WHAT THIS DOES:"
  echo "     Back up your agent's soul, memories, and secrets."
  echo "     If your agent dies, resurrect it from anywhere."
  echo ""
  echo "  🌐 WHY IPFS?"
  echo "     • Content-addressed — same content = same CID = verifiable"
  echo "     • Distributed — your memories survive even if one server dies"
  echo "     • Immutable — once pinned, your checkpoint can't be tampered with"
  echo "     • Fetch from anywhere — any IPFS gateway can retrieve your soul"
  echo ""
  echo "  🔧 WHAT WE'LL SET UP:"
  echo "     1. Your unique cryptographic identity (KERI-based)"
  echo "     2. IPFS pinning (Solvr free tier or your own Pinata)"
  echo "     3. Watchdog service (auto-detect death, auto-resurrect)"
  echo "     4. Checkpoint schedule (automatic backups)"
  echo "     5. Optional: Groq AI for intelligent memory pruning"
  echo ""
  if ! prompt_yn "Ready to begin?"; then
    echo "  Aborted. Run 'proactive-amcp init' when ready."
    exit 0
  fi
}

main() {
  show_intro

  setup_identity
  setup_config
  setup_learning_storage
  setup_watchdog
  setup_checkpoint
  print_summary

  [ -x "$SCRIPT_DIR/notify.sh" ] && "$SCRIPT_DIR/notify.sh" "🎉 [${AGENT_NAME}] AMCP init complete — identity valid, services running"
}

main "$@"
