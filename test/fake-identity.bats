#!/usr/bin/env bats
# Integration tests: fake openclaw-deploy-style identity.json → all scripts refuse to operate
#
# These tests verify that scripts with identity validation correctly reject
# fake identities (sha256 AID, flat secrets, no KEL) created by openclaw-deploy.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Export IDENTITY_PATH for use in test bodies (scripts derive it from $HOME)
  export IDENTITY_PATH="$AMCP_DIR/identity.json"

  # Export AMCP_CLI so scripts use our mock (scripts default to $HOME/bin/amcp absolute path)
  export AMCP_CLI="$MOCK_BIN/amcp"

  # Mock amcp CLI: identity validate returns exit 1 (fake identity fails validation)
  create_mock_amcp 1

  # Create the fake (openclaw-deploy-style) identity
  create_fake_identity

  # Copy scripts into isolated sandbox
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in watchdog.sh checkpoint.sh _checkpoint-full.sh resuscitate.sh \
           solvr-integration.sh diagnose.sh _diagnose-fix.sh _secrets-scan.sh config.sh \
           proactive-amcp.sh init.sh install.sh notify.sh; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock notify.sh in sandbox (avoid real notifications)
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  # Create minimal OpenClaw config for scripts that read it
  mkdir -p "$HOME/.openclaw"
  echo '{"gateway":{"port":3141}}' > "$HOME/.openclaw/openclaw.json"

  # Create minimal AMCP config so scripts don't fail on config read
  mkdir -p "$HOME/.amcp"
  echo '{}' > "$HOME/.amcp/config.json"
  chmod 600 "$HOME/.amcp/config.json"
}

teardown() {
  teardown_test_env
}

# ============================================================
# Test 1: watchdog.sh with fake identity exits 1
# ============================================================
@test "fake identity: watchdog.sh exits 1 with 'Invalid AMCP identity' error" {
  run bash "$SANDBOXED_SCRIPTS/watchdog.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FATAL: Invalid AMCP identity"* ]]
}

# ============================================================
# Test 2: checkpoint.sh with fake identity exits 1 before creating tarball
# ============================================================
@test "fake identity: checkpoint.sh exits 1 before creating tarball" {
  # Ensure no checkpoint is created
  local checkpoint_dir="$HOME/.amcp/checkpoints"
  mkdir -p "$checkpoint_dir"

  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FATAL: Invalid AMCP identity"* ]]

  # Verify no checkpoint was created
  local count
  count=$(find "$checkpoint_dir" -name "checkpoint-*.amcp" 2>/dev/null | wc -l)
  [ "$count" -eq 0 ]
}

# ============================================================
# Test 3: checkpoint.sh --full with fake identity exits 1 before staging
# ============================================================
@test "fake identity: checkpoint.sh --full exits 1 before staging content" {
  local checkpoint_dir="$HOME/.amcp/checkpoints"
  mkdir -p "$checkpoint_dir"

  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --full

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FATAL: Invalid AMCP identity"* ]]

  # Verify no checkpoint was created
  local count
  count=$(find "$checkpoint_dir" -name "checkpoint-*.amcp" 2>/dev/null | wc -l)
  [ "$count" -eq 0 ]
}

# ============================================================
# Test 4: resuscitate.sh with fake identity exits 1 before resurrection
# ============================================================
@test "fake identity: resuscitate.sh exits 1 before attempting resurrection" {
  # Mock pgrep so gateway checks don't interfere
  create_mock_pgrep_fail

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FATAL: Invalid AMCP identity"* ]]

  # Verify no lock file was created (resurrection never started)
  [ ! -f "$HOME/.amcp/resurrection.lock" ]
}

# ============================================================
# Test 5: proactive-amcp init with fake identity replaces it via amcp identity create
# ============================================================
@test "fake identity: init detects fake identity and replaces via amcp identity create" {
  # Create a more sophisticated mock amcp that:
  # - Fails validate on first call (fake identity detected)
  # - Succeeds on create (simulates generating new identity)
  # - Succeeds validate on subsequent calls (new identity is valid)
  cat > "$MOCK_BIN/amcp" << 'EOAMCP'
#!/bin/bash
echo "amcp $*" >> "${TEST_DIR}/amcp.log"
if [ "$1" = "identity" ] && [ "$2" = "validate" ]; then
  # Check if the identity file has been replaced (contains did:keri)
  identity_file=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --identity) identity_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$identity_file" ] && [ -f "$identity_file" ]; then
    if grep -q '"did:keri:' "$identity_file" 2>/dev/null; then
      exit 0  # Valid (replaced)
    fi
  fi
  exit 1  # Invalid (still fake)
fi
if [ "$1" = "identity" ] && [ "$2" = "create" ]; then
  # Find --out path
  out_path=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) out_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$out_path" ]; then
    mkdir -p "$(dirname "$out_path")"
    cat > "$out_path" << 'EOID'
{
  "aid": "did:keri:EBqK1z2v3jFj4L5q6R7sT8uV9wXyZ",
  "kel": [{"event": "inception", "sn": 0}],
  "keys": {"current": "key-placeholder"},
  "created": "2025-01-01T00:00:00Z"
}
EOID
  fi
  exit 0
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Mock systemctl to fail (no systemd in test)
  create_mock_systemctl

  # Save original fake identity content for comparison
  local original_aid
  original_aid=$(python3 -c "import json; print(json.load(open('$IDENTITY_PATH'))['aid'])")
  [ "$original_aid" = "sha256:fakehash123456" ]

  # Mock crontab (no real cron in test env)
  cat > "$MOCK_BIN/crontab" << 'EOCRONTAB'
#!/bin/bash
if [ "$1" = "-l" ]; then echo ""; exit 0; fi
cat > /dev/null  # consume stdin for install
exit 0
EOCRONTAB
  chmod +x "$MOCK_BIN/crontab"

  # Run init with piped stdin: "y" to replace identity, then accept defaults
  # Prompt sequence: (1) replace identity=y, (2) pinata jwt=skip, (3) notify=skip,
  # (4) watchdog interval=accept default, (5) checkpoint schedule=accept default
  run bash "$SANDBOXED_SCRIPTS/init.sh" <<< "$(printf 'y\n\n\n\n\n')"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  # init should succeed (exit 0)
  [ "$status" -eq 0 ]

  # The identity should have been replaced
  [[ "$output" == *"INVALID"* ]] || [[ "$output" == *"invalid"* ]] || [[ "$output" == *"Replace"* ]]

  # Verify the identity file was replaced with a valid one
  local new_aid
  new_aid=$(python3 -c "import json; print(json.load(open('$IDENTITY_PATH'))['aid'])")
  [[ "$new_aid" == did:keri:* ]]

  # Verify a backup was created
  local backup_count
  backup_count=$(find "$AMCP_DIR" -name "identity.json.bak.*" 2>/dev/null | wc -l)
  [ "$backup_count" -ge 1 ]

  # Verify amcp identity create was called (check log)
  grep -q "identity create" "$TEST_DIR/amcp.log"
}

# ============================================================
# Test 6: proactive-amcp config set never writes to identity.json
# ============================================================
@test "fake identity: config set never writes to identity.json" {
  # Save identity content before config operations
  local identity_before
  identity_before=$(cat "$IDENTITY_PATH")

  # config.sh doesn't require valid identity — it manages config.json
  # Use a passing amcp mock so warn_identity_secrets can call validate if needed
  create_mock_amcp 0

  run bash "$SANDBOXED_SCRIPTS/config.sh" set pinata.jwt "eyJtest123"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]

  # Verify identity.json was NOT modified
  local identity_after
  identity_after=$(cat "$IDENTITY_PATH")
  [ "$identity_before" = "$identity_after" ]

  # Verify the value was written to config.json, NOT identity.json
  local config_jwt
  config_jwt=$(python3 -c "import json; print(json.load(open('$HOME/.amcp/config.json')).get('pinata',{}).get('jwt',''))")
  [ "$config_jwt" = "eyJtest123" ]

  # Verify identity.json does NOT contain the new value
  ! grep -q "eyJtest123" "$IDENTITY_PATH"
}

# ============================================================
# Bonus: verify fake identity fixture matches openclaw-deploy format
# ============================================================
@test "fake identity fixture: has sha256 AID, flat secrets, no KEL" {
  local identity="$IDENTITY_PATH"

  # Has sha256-style AID (not did:keri)
  local aid
  aid=$(python3 -c "import json; print(json.load(open('$identity'))['aid'])")
  [[ "$aid" == sha256:* ]]

  # Has flat secrets (pinata_jwt, solvr_api_key)
  python3 -c "
import json, sys
d = json.load(open('$identity'))
assert 'pinata_jwt' in d, 'Missing pinata_jwt'
assert 'solvr_api_key' in d, 'Missing solvr_api_key'
sys.exit(0)
"

  # Does NOT have KEL
  run python3 -c "
import json, sys
d = json.load(open('$identity'))
if 'kel' in d:
    print('ERROR: fake identity should not have kel')
    sys.exit(1)
sys.exit(0)
"
  [ "$status" -eq 0 ]
}

# ============================================================
# Bonus: install.sh with fake identity replaces it non-interactively
# ============================================================
@test "fake identity: install.sh replaces fake identity non-interactively" {
  # Same smart mock as init test
  cat > "$MOCK_BIN/amcp" << 'EOAMCP'
#!/bin/bash
echo "amcp $*" >> "${TEST_DIR}/amcp.log"
if [ "$1" = "identity" ] && [ "$2" = "validate" ]; then
  identity_file=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --identity) identity_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$identity_file" ] && [ -f "$identity_file" ]; then
    if grep -q '"did:keri:' "$identity_file" 2>/dev/null; then
      exit 0
    fi
  fi
  exit 1
fi
if [ "$1" = "identity" ] && [ "$2" = "create" ]; then
  out_path=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) out_path="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$out_path" ]; then
    mkdir -p "$(dirname "$out_path")"
    cat > "$out_path" << 'EOID'
{
  "aid": "did:keri:EBqK1z2v3jFj4L5q6R7sT8uV9wXyZ",
  "kel": [{"event": "inception", "sn": 0}],
  "keys": {"current": "key-placeholder"},
  "created": "2025-01-01T00:00:00Z"
}
EOID
  fi
  exit 0
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Mock systemctl for service setup
  create_mock_systemctl

  # Verify original is fake
  local original_aid
  original_aid=$(python3 -c "import json; print(json.load(open('$IDENTITY_PATH'))['aid'])")
  [ "$original_aid" = "sha256:fakehash123456" ]

  run bash "$SANDBOXED_SCRIPTS/install.sh" --pinata-jwt "testjwt123" --skip-services

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]

  # Identity should have been replaced
  local new_aid
  new_aid=$(python3 -c "import json; print(json.load(open('$IDENTITY_PATH'))['aid'])")
  [[ "$new_aid" == did:keri:* ]]

  # Backup should exist
  local backup_count
  backup_count=$(find "$AMCP_DIR" -name "identity.json.bak.*" 2>/dev/null | wc -l)
  [ "$backup_count" -ge 1 ]

  # Config should have the JWT
  local config_jwt
  config_jwt=$(python3 -c "import json; print(json.load(open('$HOME/.amcp/config.json')).get('pinata',{}).get('jwt',''))")
  [ "$config_jwt" = "testjwt123" ]
}
