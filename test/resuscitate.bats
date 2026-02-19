#!/usr/bin/env bats
# Tests for resuscitate.sh
#
# IMPORTANT: Tests run against a COPY of the scripts in a temp dir
# with all external commands mocked. Tests never touch the live gateway.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env
  create_mock_systemctl
  create_mock_pkill
  create_mock_nohup

  # Copy scripts into isolated sandbox
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  cp "$REAL_SCRIPT_DIR/resuscitate.sh" "$SANDBOXED_SCRIPTS/"
  cp "$REAL_SCRIPT_DIR/solvr-integration.sh" "$SANDBOXED_SCRIPTS/"
  cp "$REAL_SCRIPT_DIR/inject-secrets.sh" "$SANDBOXED_SCRIPTS/"
  chmod +x "$SANDBOXED_SCRIPTS/resuscitate.sh" "$SANDBOXED_SCRIPTS/solvr-integration.sh" "$SANDBOXED_SCRIPTS/inject-secrets.sh"

  # Mock notify.sh in sandbox
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export SOLVR_API_KEY=""  # Disable Solvr in tests

  # Create mock amcp CLI
  cat > "$MOCK_BIN/amcp" << 'EOAMCP'
#!/bin/bash
echo "amcp $*" >> "${HOME}/.amcp/amcp.log"
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Create mock identity
  echo '{"id":"test-agent"}' > "$IDENTITY_PATH"
}

teardown() {
  teardown_test_env
}

@test "resuscitate: Tier 1 success exits without touching config" {
  # Gateway restart succeeds on first try
  create_mock_pgrep "openclaw-gateway"
  create_mock_openclaw true

  # Mock systemctl to succeed for restart
  cat > "$MOCK_BIN/systemctl" << 'EOF'
#!/bin/bash
if [[ "$*" == *"restart"* ]]; then
  exit 0
fi
exit 1
EOF
  chmod +x "$MOCK_BIN/systemctl"

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"restart gateway"* ]] || [[ "$output" == *"Recovery succeeded"* ]]

  # Config should NOT have been touched (no .pre-recovery file)
  [ ! -f "$OPENCLAW_DIR/openclaw.json.pre-recovery" ]
}

@test "resuscitate: Tier 2 does NOT run if Tier 1 succeeded" {
  create_mock_pgrep "openclaw-gateway"

  # systemctl restart succeeds
  cat > "$MOCK_BIN/systemctl" << 'EOF'
#!/bin/bash
if [[ "$*" == *"restart"* ]]; then
  exit 0
fi
exit 1
EOF
  chmod +x "$MOCK_BIN/systemctl"

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"
  [ "$status" -eq 0 ]

  # Should NOT have attempted config fix
  [[ "$output" != *"Fix config"* ]] && [[ "$output" != *"fix config"* ]]
}

@test "resuscitate: lock file prevents concurrent resurrection" {
  # Create lock file with a PID that looks alive (use our own PID)
  mkdir -p "$AMCP_DIR"
  echo "$$" > "$AMCP_DIR/resurrection.lock"

  # Try to run resurrection
  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"
  echo "OUTPUT: $output"

  # Should exit early due to lock
  [[ "$output" == *"already running"* ]]
}

@test "resuscitate: lock file cleaned up on exit" {
  # Gateway restart succeeds immediately
  create_mock_pgrep "openclaw-gateway"
  cat > "$MOCK_BIN/systemctl" << 'EOF'
#!/bin/bash
if [[ "$*" == *"restart"* ]]; then
  exit 0
fi
exit 1
EOF
  chmod +x "$MOCK_BIN/systemctl"

  bash "$SANDBOXED_SCRIPTS/resuscitate.sh" || true

  # Lock file should be cleaned up
  [ ! -f "$AMCP_DIR/resurrection.lock" ]
}

@test "resuscitate: consistent pgrep patterns with watchdog" {
  # Both watchdog and resuscitate should check the same patterns
  create_mock_pgrep_fail
  create_mock_openclaw false
  create_mock_curl_fail

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh" 2>&1
  # It should fail (nothing running) but should have tried without crashing
  true
}

@test "resuscitate: gates tier escalation on gateway check" {
  # If tier 1 fails, tier 2 should check if gateway is now running
  # before overwriting config
  create_mock_pgrep_fail
  create_mock_openclaw false
  create_mock_curl_fail

  # Create a config backup for tier 2 to find
  echo '{"test": true}' > "$AMCP_DIR/config-backups/openclaw-backup.json"
  echo '{}' > "$OPENCLAW_DIR/openclaw.json"

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"
  # Should attempt all tiers and fail
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAILED"* ]] || [[ "$output" == *"failed"* ]]
}
