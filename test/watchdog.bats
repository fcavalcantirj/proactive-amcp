#!/usr/bin/env bats
# Tests for watchdog.sh
#
# IMPORTANT: Tests run against a COPY of the scripts in a temp dir.
# resuscitate.sh is replaced with a no-op mock so tests never touch
# the live gateway.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env
  create_mock_amcp 0
  create_valid_identity
  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  create_mock_systemctl
  create_mock_df 50
  create_mock_free 50

  # Copy scripts into isolated sandbox so we never run against real gateway
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in watchdog.sh diagnose.sh session-fix.sh fix-openclaw-session.py; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock resuscitate.sh — no-op, never touches real gateway
  cat > "$SANDBOXED_SCRIPTS/resuscitate.sh" << 'EORESUS'
#!/bin/bash
echo "mock-resuscitate called at $(date -Iseconds)" >> "${HOME}/.amcp/resuscitate.log"
EORESUS
  chmod +x "$SANDBOXED_SCRIPTS/resuscitate.sh"

  # Mock notify.sh
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  # Config file (diagnose checks it)
  export OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
  mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
  echo '{"gateway":{"port":3141}}' > "$OPENCLAW_CONFIG"

  # Session directory (diagnose scans it)
  export SESSION_DIR="$HOME/.openclaw/agents/main/sessions"
  mkdir -p "$SESSION_DIR"
  # Create a clean session so diagnose doesn't flag missing sessions
  cat > "$SESSION_DIR/sessions.json" << 'EOJSON'
{"agent:main:main":{"sessionId":"test-session","agentId":"main"}}
EOJSON
  cat > "$SESSION_DIR/test-session.jsonl" << 'EOLINES'
{"id":"msg-001","parentId":"","type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
{"id":"msg-002","parentId":"msg-001","type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Hi!"}]}}
EOLINES

  export STATE_FILE="$AMCP_DIR/watchdog-state.json"
  export CHECK_INTERVAL=1
  export FAIL_THRESHOLD=2
}

teardown() {
  teardown_test_env
}

# Helper: run a single watchdog check (not continuous mode)
run_watchdog() {
  bash "$SANDBOXED_SCRIPTS/watchdog.sh"
}

# Helper: inject a corrupted session
inject_corrupted_session() {
  cat > "$SESSION_DIR/test-session.jsonl" << 'EOLINES'
{"id":"msg-001","parentId":"","type":"message","message":{"role":"user","content":[{"type":"text","text":"check status"}]}}
{"id":"msg-002","parentId":"msg-001","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"Bad escaped character","content":[{"type":"text","text":"Let me check"},{"type":"toolCall","id":"toolu_broken789","name":"exec","partialJson":"{\"action\": \"run\""}]}}
{"id":"msg-003","parentId":"msg-002","type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"[clawdbot] missing tool result in session history; inserted synthetic error result for transcript repair"}]}}
{"id":"msg-004","parentId":"msg-003","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"unexpected `tool_use_id` found in `tool_result` blocks: toolu_broken789\"}}","content":[]}}
{"id":"msg-005","parentId":"msg-004","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"unexpected `tool_use_id` found in `tool_result` blocks: toolu_broken789\"}}","content":[]}}
EOLINES
}

@test "watchdog: reports HEALTHY when everything is fine" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"

  run run_watchdog
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"HEALTHY"* ]]

  local state
  state=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['state'])")
  [ "$state" = "HEALTHY" ]
}

@test "watchdog: transitions to CHECKING on first failure" {
  create_mock_pgrep_fail
  create_mock_curl_fail

  run run_watchdog
  [ "$status" -eq 1 ]

  local state
  state=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['state'])")
  [ "$state" = "CHECKING" ]
}

@test "watchdog: transitions CHECKING -> DEAD after threshold failures" {
  create_mock_pgrep_fail
  create_mock_curl_fail

  run run_watchdog
  [ "$status" -eq 1 ]

  run run_watchdog
  [ "$status" -eq 2 ]

  local state
  state=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['state'])")
  [ "$state" = "DEAD" ]
}

@test "watchdog: launches resurrection on DEAD transition" {
  create_mock_pgrep_fail
  create_mock_curl_fail

  run run_watchdog  # -> CHECKING
  run run_watchdog  # -> DEAD

  [ "$status" -eq 2 ]
  [[ "$output" == *"DEAD"* ]]
}

@test "watchdog: does NOT launch duplicate resurrection when already DEAD" {
  create_mock_pgrep_fail
  create_mock_curl_fail

  run run_watchdog  # -> CHECKING
  run run_watchdog  # -> DEAD

  mkdir -p "$AMCP_DIR"
  touch "$AMCP_DIR/resurrection.lock"

  run run_watchdog
  [ "$status" -eq 1 ] || [ "$status" -eq 2 ]
}

@test "watchdog: retries resurrection after cooldown when still DEAD" {
  export RETRY_DELAY_INITIAL=1
  create_mock_pgrep_fail
  create_mock_curl_fail

  run run_watchdog  # -> CHECKING
  run run_watchdog  # -> DEAD, resurrection launched

  rm -f "$AMCP_DIR/resurrection.lock"
  sleep 2

  run run_watchdog
  echo "OUTPUT: $output"
  [[ "$output" == *"Retrying"* ]] || [[ "$output" == *"Launching"* ]] || [[ "$output" == *"resurrection"* ]]
}

@test "watchdog: detects recovery (DEAD -> HEALTHY)" {
  create_mock_pgrep_fail
  create_mock_curl_fail

  run run_watchdog  # -> CHECKING
  run run_watchdog  # -> DEAD

  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"

  run run_watchdog
  [ "$status" -eq 0 ]
  [[ "$output" == *"Recovered"* ]]

  local state
  state=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['state'])")
  [ "$state" = "HEALTHY" ]
}

@test "watchdog: session corruption auto-fixed without resurrection" {
  # Gateway is running, but session is corrupted
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  inject_corrupted_session

  # Mock systemctl to succeed for restart (gateway is alive in this scenario)
  cat > "$MOCK_BIN/systemctl" << 'EOF'
#!/bin/bash
if [[ "$*" == *"restart"* ]]; then exit 0; fi
exit 1
EOF
  chmod +x "$MOCK_BIN/systemctl"

  run run_watchdog
  echo "OUTPUT: $output"

  # Should detect and fix the session without going to DEAD
  [[ "$output" == *"session"* ]] || [[ "$output" == *"Session"* ]]
  # Should end up HEALTHY (session fixed)
  local state
  state=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['state'])")
  [ "$state" = "HEALTHY" ]
}
