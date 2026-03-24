#!/usr/bin/env bats
# Tests for scripts/lib/gateway.sh — safe_restart_gateway()

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Export vars for gateway.sh
  export GATEWAY_SETTLE_TIME=0
  export TELEGRAM_LOCK_GAP=0
  export GATEWAY_STOP_TIMEOUT=2
  export GATEWAY_RESTART_LOCK="$TEST_DIR/gateway-restart.lock"

  # Source the library
  export SCRIPT_DIR="$REAL_SCRIPT_DIR"
}

teardown() {
  teardown_test_env
}

# Helper: source gateway.sh in a subshell and run safe_restart_gateway
run_safe_restart() {
  bash -c "
    export PATH=\"$MOCK_BIN:\$PATH\"
    export GATEWAY_SETTLE_TIME=$GATEWAY_SETTLE_TIME
    export TELEGRAM_LOCK_GAP=$TELEGRAM_LOCK_GAP
    export GATEWAY_STOP_TIMEOUT=$GATEWAY_STOP_TIMEOUT
    export GATEWAY_RESTART_LOCK=$GATEWAY_RESTART_LOCK
    source '$REAL_SCRIPT_DIR/lib/gateway.sh'
    safe_restart_gateway
  " 2>&1
}

@test "gateway-lib: safe_restart_gateway succeeds with systemctl" {
  # Mock systemctl that succeeds for stop and start
  cat > "$MOCK_BIN/systemctl" << 'EOF'
#!/bin/bash
echo "systemctl $*" >> "${TEST_DIR:-/tmp}/systemctl.log"
exit 0
EOF
  chmod +x "$MOCK_BIN/systemctl"
  create_mock_pgrep "openclaw-gateway"

  run run_safe_restart
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Restarted via systemctl"* ]]
}

@test "gateway-lib: safe_restart_gateway falls back to pkill when systemctl fails" {
  # systemctl fails
  cat > "$MOCK_BIN/systemctl" << 'EOF'
#!/bin/bash
exit 1
EOF
  chmod +x "$MOCK_BIN/systemctl"
  create_mock_pgrep "openclaw-gateway"
  create_mock_openclaw true

  run run_safe_restart
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Restarted directly"* ]]
}

@test "gateway-lib: restart lock prevents concurrent restarts" {
  mkdir -p "$(dirname "$GATEWAY_RESTART_LOCK")"
  echo $$ > "$GATEWAY_RESTART_LOCK"

  run run_safe_restart
  echo "OUTPUT: $output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Another restart in progress"* ]]
}

@test "gateway-lib: stale lock is cleaned up" {
  create_mock_systemctl
  create_mock_pgrep "openclaw-gateway"
  mkdir -p "$(dirname "$GATEWAY_RESTART_LOCK")"
  echo "99999" > "$GATEWAY_RESTART_LOCK"
  # Make lock old (>60s) by touching with old timestamp
  touch -t 202601010000 "$GATEWAY_RESTART_LOCK"

  run run_safe_restart
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"stale restart lock"* ]]
}

@test "gateway-lib: lock file cleaned up after successful restart" {
  create_mock_systemctl
  create_mock_pgrep "openclaw-gateway"

  run run_safe_restart
  [ "$status" -eq 0 ]
  [ ! -f "$GATEWAY_RESTART_LOCK" ]
}

@test "gateway-lib: guard prevents double-source" {
  run bash -c "
    source '$REAL_SCRIPT_DIR/lib/gateway.sh'
    source '$REAL_SCRIPT_DIR/lib/gateway.sh'
    echo 'no error'
  "
  [ "$status" -eq 0 ]
  [[ "$output" == *"no error"* ]]
}
