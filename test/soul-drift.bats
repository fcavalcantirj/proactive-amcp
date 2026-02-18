#!/usr/bin/env bats
# Tests for SOUL.md drift detection in full-checkpoint.sh
#
# Verifies:
# - soulHash stored in last-checkpoint.json
# - Drift logged to soul-drift.log with correct severity
# - Notifications sent for moderate/major drift
# - No drift on unchanged SOUL.md
# - Graceful handling when SOUL.md absent
# - notify.enableSoulDrift config toggle

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Sandbox scripts
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in full-checkpoint.sh scan-secrets.sh; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock notify.sh that logs calls
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  # Mock amcp CLI — validate succeeds, checkpoint create produces a file
  cat > "$MOCK_BIN/amcp" << 'EOAMCP'
#!/bin/bash
if [ "$1" = "identity" ] && [ "$2" = "validate" ]; then
  exit 0
fi
if [ "$1" = "checkpoint" ] && [ "$2" = "create" ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = "--out" ]; then
      echo '{"checkpoint":"mock"}' > "$2"
      break
    fi
    shift
  done
  exit 0
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Mock curl (Pinata upload)
  cat > "$MOCK_BIN/curl" << 'EOCURL'
#!/bin/bash
echo '{"IpfsHash":"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"}'
exit 0
EOCURL
  chmod +x "$MOCK_BIN/curl"

  # Mock rsync
  cat > "$MOCK_BIN/rsync" << 'EORSYNC'
#!/bin/bash
SRC=""
DEST=""
for arg in "$@"; do
  case "$arg" in
    --exclude=*|-a|--info=*) ;;
    *)
      if [ -z "$SRC" ]; then
        SRC="$arg"
      else
        DEST="$arg"
      fi
      ;;
  esac
done
if [ -n "$SRC" ] && [ -n "$DEST" ]; then
  mkdir -p "$DEST"
  if [ -d "${SRC%/}" ]; then
    cp -a "${SRC%/}/." "$DEST/" 2>/dev/null || true
  fi
fi
exit 0
EORSYNC
  chmod +x "$MOCK_BIN/rsync"

  # Create valid identity
  create_valid_identity

  # AMCP config (no secrets in workspace)
  cat > "$AMCP_DIR/config.json" << 'EOCONFIG'
{
  "pinata": {
    "jwt": "eyJhbGciOiJIUzI1NiJ9.test.pinata_jwt_value"
  }
}
EOCONFIG
  chmod 600 "$AMCP_DIR/config.json"

  # openclaw.json (minimal, no secrets in workspace)
  mkdir -p "$OPENCLAW_DIR"
  cat > "$OPENCLAW_DIR/openclaw.json" << 'EOOC'
{
  "gateway": { "port": 18789 },
  "agents": { "defaults": { "workspace": "WORKSPACE_PLACEHOLDER" } }
}
EOOC
  # Replace placeholder with actual path (avoid hardcoding)
  sed -i "s|WORKSPACE_PLACEHOLDER|$CONTENT_DIR|" "$OPENCLAW_DIR/openclaw.json"

  # Create workspace with clean content (no secrets)
  mkdir -p "$CONTENT_DIR"
  echo "# My Project" > "$CONTENT_DIR/README.md"

  # Set env vars
  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export CHECKPOINT_DIR="$AMCP_DIR/checkpoints"
  export KEEP_CHECKPOINTS=5
  export SOUL_DRIFT_LOG="$AMCP_DIR/soul-drift.log"
}

teardown() {
  teardown_test_env
}

run_checkpoint() {
  bash "$SANDBOXED_SCRIPTS/full-checkpoint.sh" "$@"
}

create_small_soul() {
  cat > "$CONTENT_DIR/SOUL.md" << 'EOSOUL'
# My Soul
I am a helpful agent.
My purpose is to assist.
I value accuracy.
I respect humans.
EOSOUL
}

create_large_soul() {
  # 120 lines so changed_lines = 120//5 = 24 >= 20 (major)
  {
    echo "# My Soul"
    echo "I am a helpful agent."
    for i in $(seq 1 118); do
      echo "Principle $i: I follow the code of the sea."
    done
  } > "$CONTENT_DIR/SOUL.md"
}

# ============================================================
# Test 1: Initial checkpoint — soulHash stored, no drift alert
# ============================================================
@test "initial checkpoint with SOUL.md stores soulHash in last-checkpoint.json" {
  create_small_soul

  run run_checkpoint
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # soulHash should be in last-checkpoint.json
  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  local soul_hash
  soul_hash=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print(d.get('soulHash',''))")
  [ -n "$soul_hash" ]

  # No drift log on first checkpoint (no previous hash to compare)
  [ ! -f "$SOUL_DRIFT_LOG" ]
}

# ============================================================
# Test 2: Minor drift — 3 lines added, logged, no notification
# ============================================================
@test "minor SOUL.md change logs drift but no notification" {
  create_small_soul

  # First checkpoint (baseline)
  run run_checkpoint
  [ "$status" -eq 0 ]

  # Modify SOUL.md slightly (add 3 lines, total ~8 lines => 8//5=1 => minor)
  cat >> "$CONTENT_DIR/SOUL.md" << 'EOADD'
I learn from experience.
I grow with time.
I adapt to change.
EOADD

  # Second checkpoint — should detect drift
  run run_checkpoint
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Drift should be logged
  [ -f "$SOUL_DRIFT_LOG" ]
  grep -q "severity=minor" "$SOUL_DRIFT_LOG"

  # No notification for minor drift
  [ ! -f "$AMCP_DIR/notifications.log" ]
}

# ============================================================
# Test 3: Major drift — 25+ lines, triggers notification
# ============================================================
@test "major SOUL.md change triggers notification" {
  create_small_soul

  # First checkpoint (baseline)
  run run_checkpoint
  [ "$status" -eq 0 ]

  # Replace SOUL.md with a large version (120 lines => 120//5=24 => major)
  create_large_soul

  # Second checkpoint — should detect major drift
  run run_checkpoint --notify
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Drift should be logged as major
  [ -f "$SOUL_DRIFT_LOG" ]
  grep -q "severity=major" "$SOUL_DRIFT_LOG"

  # Notification should be sent (notify.sh called with drift message)
  [ -f "$AMCP_DIR/notifications.log" ]
  grep -q "SOUL.md drift" "$AMCP_DIR/notifications.log"
}

# ============================================================
# Test 4: No SOUL.md — no soulHash, no error
# ============================================================
@test "no SOUL.md present — no soulHash in last-checkpoint.json, no error" {
  # Don't create SOUL.md — workspace only has README.md

  run run_checkpoint
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # last-checkpoint.json should exist but without soulHash
  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  local soul_hash
  soul_hash=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print(d.get('soulHash',''))")
  [ -z "$soul_hash" ]

  # No drift log
  [ ! -f "$SOUL_DRIFT_LOG" ]
}

# ============================================================
# Test 5: Unchanged SOUL.md across 3 checkpoints — no drift
# ============================================================
@test "unchanged SOUL.md across 3 checkpoints — no drift alerts" {
  create_small_soul

  # Run 3 checkpoints without changing SOUL.md
  run run_checkpoint
  [ "$status" -eq 0 ]

  run run_checkpoint
  [ "$status" -eq 0 ]

  run run_checkpoint
  [ "$status" -eq 0 ]

  # No drift log at all (hash matches every time after first)
  [ ! -f "$SOUL_DRIFT_LOG" ]
}

# ============================================================
# Test 6: enableSoulDrift=false — drift logged, no notification
# ============================================================
@test "notify.enableSoulDrift false — drift logged but no notification sent" {
  create_small_soul

  # First checkpoint (baseline)
  run run_checkpoint
  [ "$status" -eq 0 ]

  # Disable soul drift notifications in config
  python3 -c "
import json
with open('$AMCP_DIR/config.json') as f:
    cfg = json.load(f)
cfg.setdefault('notify', {})['enableSoulDrift'] = False
with open('$AMCP_DIR/config.json', 'w') as f:
    json.dump(cfg, f, indent=2)
"

  # Replace SOUL.md with large version (major drift)
  create_large_soul

  # Second checkpoint with --notify flag
  run run_checkpoint --notify
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Drift should still be logged
  [ -f "$SOUL_DRIFT_LOG" ]
  grep -q "severity=major" "$SOUL_DRIFT_LOG"

  # But notification should NOT be sent (enableSoulDrift=false)
  if [ -f "$AMCP_DIR/notifications.log" ]; then
    # If notifications.log exists, it should NOT contain drift message
    ! grep -q "SOUL.md drift" "$AMCP_DIR/notifications.log"
  fi
}
