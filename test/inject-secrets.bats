#!/usr/bin/env bats
# Tests for _secrets-inject.sh
#
# IMPORTANT: Tests run against a COPY of _secrets-inject.sh in a temp dir.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env
  create_mock_systemctl

  # Copy script into isolated sandbox
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  cp "$REAL_SCRIPT_DIR/_secrets-inject.sh" "$SANDBOXED_SCRIPTS/"
  chmod +x "$SANDBOXED_SCRIPTS/_secrets-inject.sh"

  # Mock notify.sh in sandbox
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
true
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"
}

teardown() {
  teardown_test_env
}

@test "inject-secrets: processes secrets without crashing" {
  # This is the critical test — the broken first Python block causes a crash
  create_target_json "$OPENCLAW_DIR/openclaw.json"
  local secrets_file
  secrets_file=$(create_sample_secrets)

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$secrets_file"
  echo "OUTPUT: $output"
  echo "STATUS: $status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Injected"* ]]
}

@test "inject-secrets: file-type secrets update target JSON" {
  create_target_json "$OPENCLAW_DIR/openclaw.json"
  local secrets_file
  secrets_file=$(create_sample_secrets)

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$secrets_file"
  [ "$status" -eq 0 ]

  # Verify the JSON was updated
  local api_key
  api_key=$(python3 -c "import json; print(json.load(open('$OPENCLAW_DIR/openclaw.json'))['auth']['apiKey'])")
  [ "$api_key" = "sk-test-12345" ]
}

@test "inject-secrets: env-type secrets written to bashrc" {
  create_target_json "$OPENCLAW_DIR/openclaw.json"
  local secrets_file
  secrets_file=$(create_sample_secrets)

  # Create empty bashrc
  touch "$HOME/.bashrc"

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$secrets_file"
  [ "$status" -eq 0 ]

  # Verify bashrc has the secret
  grep -q "ANTHROPIC_API_KEY" "$HOME/.bashrc"
  grep -q "AMCP-SECRETS-START" "$HOME/.bashrc"
  grep -q "AMCP-SECRETS-END" "$HOME/.bashrc"
}

@test "inject-secrets: systemd-type secrets written to env file" {
  create_target_json "$OPENCLAW_DIR/openclaw.json"
  local secrets_file
  secrets_file=$(create_sample_secrets)

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$secrets_file"
  [ "$status" -eq 0 ]

  # Verify systemd env file exists and has the key
  [ -f "$SYSTEMD_ENV_FILE" ]
  grep -q "ANTHROPIC_API_KEY" "$SYSTEMD_ENV_FILE"
}

@test "inject-secrets: backup is created before modification" {
  create_target_json "$OPENCLAW_DIR/openclaw.json"
  local secrets_file
  secrets_file=$(create_sample_secrets)

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$secrets_file"
  [ "$status" -eq 0 ]

  # Verify backup directory was created with content
  local backup_dirs
  backup_dirs=$(ls "$AMCP_DIR/backups/" 2>/dev/null)
  [ -n "$backup_dirs" ]
}

@test "inject-secrets: rejects invalid JSON input" {
  echo "not json" > "$TEST_DIR/bad-secrets.json"

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$TEST_DIR/bad-secrets.json"
  [ "$status" -ne 0 ]
  [[ "$output" == *"not valid JSON"* ]]
}

@test "inject-secrets: fails with no arguments" {
  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage"* ]]
}

@test "inject-secrets: handles missing target file gracefully" {
  # Secret targets a file that doesn't exist — should skip, not crash
  cat > "$TEST_DIR/secrets.json" << 'EOF'
[
  {
    "key": "MISSING_KEY",
    "value": "some-value",
    "targets": [
      {
        "kind": "file",
        "path": "/nonexistent/path/config.json",
        "jsonPath": "key"
      }
    ]
  }
]
EOF

  run bash "$SANDBOXED_SCRIPTS/_secrets-inject.sh" "$TEST_DIR/secrets.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP"* ]]
}
