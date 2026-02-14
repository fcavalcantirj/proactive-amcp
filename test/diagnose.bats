#!/usr/bin/env bats
# Tests for diagnose.sh
#
# IMPORTANT: Tests run against a COPY in a temp dir. Never touches live system.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env
  create_mock_systemctl
  create_mock_df 50
  create_mock_free 50

  # Sandbox scripts
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in diagnose.sh fix-openclaw-session.py; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Session directory for tests
  export SESSION_DIR="$HOME/.openclaw/agents/main/sessions"
  mkdir -p "$SESSION_DIR"

  # Config file (diagnose checks it exists and is valid JSON)
  export OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
  mkdir -p "$(dirname "$OPENCLAW_CONFIG")"
  echo '{"gateway":{"port":3141}}' > "$OPENCLAW_CONFIG"
}

teardown() {
  teardown_test_env
}

# --- Helper: create a clean session file ---
create_clean_session() {
  local session_id="${1:-test-session-001}"
  local session_file="$SESSION_DIR/${session_id}.jsonl"

  # sessions.json pointing to this session
  cat > "$SESSION_DIR/sessions.json" << EOJSON
{
  "agent:main:main": {
    "sessionId": "$session_id",
    "agentId": "main"
  }
}
EOJSON

  # Clean session with a few normal messages
  cat > "$session_file" << 'EOLINES'
{"id":"msg-001","parentId":"","type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
{"id":"msg-002","parentId":"msg-001","type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Hello! How can I help?"}]}}
{"id":"msg-003","parentId":"msg-002","type":"message","message":{"role":"user","content":[{"type":"text","text":"what time is it?"}]}}
{"id":"msg-004","parentId":"msg-003","type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"I don't have access to the current time."}]}}
EOLINES

  echo "$session_file"
}

# --- Helper: create a corrupted session file ---
create_corrupted_session() {
  local session_id="${1:-test-session-corrupt}"
  local session_file="$SESSION_DIR/${session_id}.jsonl"

  cat > "$SESSION_DIR/sessions.json" << EOJSON
{
  "agent:main:main": {
    "sessionId": "$session_id",
    "agentId": "main"
  }
}
EOJSON

  # Session with the exact corruption pattern:
  # 1. Normal messages
  # 2. Assistant aborted mid-tool_use with partialJson
  # 3. Synthetic toolResult inserted by openclaw repair
  # 4. Cascading 400 errors on every subsequent turn
  cat > "$session_file" << 'EOLINES'
{"id":"msg-001","parentId":"","type":"message","message":{"role":"user","content":[{"type":"text","text":"check the server status"}]}}
{"id":"msg-002","parentId":"msg-001","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"Bad escaped character in JSON at position 794","content":[{"type":"text","text":"Let me check"},{"type":"toolCall","id":"toolu_broken123","name":"exec","partialJson":"{\"action\": \"run\", \"command\": \"uptime"}]}}
{"id":"msg-003","parentId":"msg-002","type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"[clawdbot] missing tool result in session history; inserted synthetic error result for transcript repair"}]}}
{"id":"msg-004","parentId":"msg-003","type":"message","message":{"role":"user","content":[{"type":"text","text":"hello?"}]}}
{"id":"msg-005","parentId":"msg-004","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.2.content.1: unexpected `tool_use_id` found in `tool_result` blocks: toolu_broken123\"}}","content":[]}}
{"id":"msg-006","parentId":"msg-005","type":"message","message":{"role":"user","content":[{"type":"text","text":"are you there?"}]}}
{"id":"msg-007","parentId":"msg-006","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.2.content.1: unexpected `tool_use_id` found in `tool_result` blocks: toolu_broken123\"}}","content":[]}}
EOLINES

  echo "$session_file"
}

run_diagnose() {
  bash "$SANDBOXED_SCRIPTS/diagnose.sh" "$@"
}

# ============================================================
# diagnose.sh tests
# ============================================================

@test "diagnose: outputs valid JSON" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  create_clean_session

  run run_diagnose
  echo "OUTPUT: $output"
  # Should output parseable JSON
  echo "$output" | python3 -c "import json,sys; json.load(sys.stdin)"
}

@test "diagnose: reports HEALTHY when everything is fine" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  create_clean_session

  run run_diagnose
  [ "$status" -eq 0 ]

  local overall
  overall=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  [ "$overall" = "healthy" ]
}

@test "diagnose: detects gateway not running" {
  create_mock_pgrep_fail
  create_mock_curl_fail
  create_clean_session

  run run_diagnose
  [ "$status" -ne 0 ]

  local has_gateway_issue
  has_gateway_issue=$(echo "$output" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(any(f['type'] == 'gateway_down' for f in d['findings']))
")
  [ "$has_gateway_issue" = "True" ]
}

@test "diagnose: detects session corruption (400 error loop)" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  create_corrupted_session

  run run_diagnose
  echo "OUTPUT: $output"
  [ "$status" -ne 0 ]

  # Should find session_corrupted finding
  local has_corruption
  has_corruption=$(echo "$output" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(any(f['type'] == 'session_corrupted' for f in d['findings']))
")
  [ "$has_corruption" = "True" ]
}

@test "diagnose: session corruption finding includes fix command" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  create_corrupted_session

  run run_diagnose

  local fix_cmd
  fix_cmd=$(echo "$output" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for f in d['findings']:
    if f['type'] == 'session_corrupted':
        print(f['fix_command'])
        break
")
  [[ "$fix_cmd" == *"session-fix"* ]]
}

@test "diagnose: session corruption finding includes session path" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  local session_file
  session_file=$(create_corrupted_session)

  run run_diagnose

  local path
  path=$(echo "$output" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for f in d['findings']:
    if f['type'] == 'session_corrupted':
        print(f['path'])
        break
")
  [ "$path" = "$session_file" ]
}

@test "diagnose: clean session has no corruption finding" {
  create_mock_pgrep "openclaw-gateway"
  create_mock_curl "200"
  create_clean_session

  run run_diagnose
  [ "$status" -eq 0 ]

  local has_corruption
  has_corruption=$(echo "$output" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(any(f['type'] == 'session_corrupted' for f in d['findings']))
")
  [ "$has_corruption" = "False" ]
}

@test "diagnose: severity levels are correct" {
  create_mock_pgrep_fail
  create_mock_curl_fail
  create_corrupted_session

  run run_diagnose

  # gateway_down should be critical, session_corrupted should be critical
  local severities
  severities=$(echo "$output" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for f in d['findings']:
    print(f'{f[\"type\"]}={f[\"severity\"]}')
")
  echo "SEVERITIES: $severities"
  [[ "$severities" == *"gateway_down=critical"* ]]
  [[ "$severities" == *"session_corrupted=critical"* ]]
}
