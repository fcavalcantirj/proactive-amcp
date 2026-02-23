#!/usr/bin/env bats
# Tests for _diagnose-fix.sh
#
# IMPORTANT: Tests run against a COPY in a temp dir. Never touches live sessions.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Sandbox scripts
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in _diagnose-fix.sh fix-openclaw-session.py; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Session directory
  export SESSION_DIR="$HOME/.openclaw/agents/main/sessions"
  mkdir -p "$SESSION_DIR"
}

teardown() {
  teardown_test_env
}

# --- Helper: create a corrupted session ---
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

  cat > "$session_file" << 'EOLINES'
{"id":"msg-001","parentId":"","type":"message","message":{"role":"user","content":[{"type":"text","text":"check status"}]}}
{"id":"msg-002","parentId":"msg-001","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"Bad escaped character","content":[{"type":"text","text":"Let me check"},{"type":"toolCall","id":"toolu_broken456","name":"exec","partialJson":"{\"action\": \"run\""}]}}
{"id":"msg-003","parentId":"msg-002","type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"[clawdbot] missing tool result in session history; inserted synthetic error result for transcript repair"}]}}
{"id":"msg-004","parentId":"msg-003","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"unexpected `tool_use_id` found in `tool_result` blocks: toolu_broken456\"}}","content":[]}}
{"id":"msg-005","parentId":"msg-004","type":"message","message":{"role":"user","content":[{"type":"text","text":"hello?"}]}}
{"id":"msg-006","parentId":"msg-005","type":"message","message":{"role":"assistant","stopReason":"error","errorMessage":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"unexpected `tool_use_id` found in `tool_result` blocks: toolu_broken456\"}}","content":[]}}
EOLINES

  echo "$session_file"
}

# --- Helper: create a clean session ---
create_clean_session() {
  local session_id="${1:-test-session-clean}"
  local session_file="$SESSION_DIR/${session_id}.jsonl"

  cat > "$SESSION_DIR/sessions.json" << EOJSON
{
  "agent:main:main": {
    "sessionId": "$session_id",
    "agentId": "main"
  }
}
EOJSON

  cat > "$session_file" << 'EOLINES'
{"id":"msg-001","parentId":"","type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
{"id":"msg-002","parentId":"msg-001","type":"message","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Hi!"}]}}
EOLINES

  echo "$session_file"
}

run_session_fix() {
  bash "$SANDBOXED_SCRIPTS/_diagnose-fix.sh" "$@"
}

# ============================================================
# _diagnose-fix.sh tests
# ============================================================

@test "session-fix: dry-run by default (no changes)" {
  local session_file
  session_file=$(create_corrupted_session)
  local before_lines
  before_lines=$(wc -l < "$session_file")

  run run_session_fix --session-dir "$SESSION_DIR"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # File should NOT be modified (dry-run)
  local after_lines
  after_lines=$(wc -l < "$session_file")
  [ "$before_lines" -eq "$after_lines" ]
  [[ "$output" == *"dry"* ]] || [[ "$output" == *"DRY"* ]] || [[ "$output" == *"Dry"* ]]
}

@test "session-fix: --fix removes corrupted lines" {
  local session_file
  session_file=$(create_corrupted_session)
  local before_lines
  before_lines=$(wc -l < "$session_file")

  run run_session_fix --fix --session-dir "$SESSION_DIR"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # File should have fewer lines (corrupted ones removed)
  local after_lines
  after_lines=$(wc -l < "$session_file")
  [ "$after_lines" -lt "$before_lines" ]
}

@test "session-fix: creates backup before fixing" {
  local session_file
  session_file=$(create_corrupted_session)

  run run_session_fix --fix --session-dir "$SESSION_DIR"
  [ "$status" -eq 0 ]

  # Backup file should exist
  local backup_count
  backup_count=$(ls "$SESSION_DIR"/*.bak.* 2>/dev/null | wc -l)
  [ "$backup_count" -gt 0 ]
}

@test "session-fix: fixed session has no corruption" {
  local session_file
  session_file=$(create_corrupted_session)

  run run_session_fix --fix --session-dir "$SESSION_DIR"
  [ "$status" -eq 0 ]

  # Scan the fixed file — should find no partialJson or 400 errors
  local remaining_corrupt
  remaining_corrupt=$(python3 -c "
import json
count = 0
with open('$session_file') as f:
    for line in f:
        obj = json.loads(line.strip())
        msg = obj.get('message', {})
        err = msg.get('errorMessage', '')
        if 'tool_use_id' in err:
            count += 1
        for c in msg.get('content', []):
            if isinstance(c, dict) and 'partialJson' in c:
                count += 1
print(count)
")
  [ "$remaining_corrupt" -eq 0 ]
}

@test "session-fix: preserves valid messages" {
  local session_file
  session_file=$(create_corrupted_session)

  run run_session_fix --fix --session-dir "$SESSION_DIR"
  [ "$status" -eq 0 ]

  # msg-001 (the original user message) should survive
  local has_original
  has_original=$(grep -c "msg-001" "$session_file")
  [ "$has_original" -ge 1 ]
}

@test "session-fix: reports clean session as clean" {
  create_clean_session

  run run_session_fix --session-dir "$SESSION_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"CLEAN"* ]] || [[ "$output" == *"clean"* ]] || [[ "$output" == *"no corruption"* ]]
}

@test "session-fix: accepts --session-id to target specific session" {
  create_corrupted_session "specific-session-id"

  run run_session_fix --fix --session-dir "$SESSION_DIR" --session-id "specific-session-id"
  [ "$status" -eq 0 ]
  [[ "$output" == *"specific-session-id"* ]]
}

@test "session-fix: outputs structured result" {
  create_corrupted_session

  run run_session_fix --fix --session-dir "$SESSION_DIR"
  [ "$status" -eq 0 ]

  # Should have some indication of what was done
  [[ "$output" == *"removed"* ]] || [[ "$output" == *"Removed"* ]] || [[ "$output" == *"fixed"* ]] || [[ "$output" == *"Fixed"* ]]
}
