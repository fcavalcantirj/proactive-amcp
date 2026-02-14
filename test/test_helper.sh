#!/bin/bash
# test_helper.sh - Shared test setup, teardown, and mocks for bats tests

# Create isolated temp dir per test
setup_test_env() {
  export TEST_DIR="$(mktemp -d)"
  export HOME="$TEST_DIR/home"
  export AMCP_DIR="$HOME/.amcp"
  export OPENCLAW_DIR="$HOME/.openclaw"
  export CONTENT_DIR="$OPENCLAW_DIR/workspace"
  export SYSTEMD_ENV_FILE="$HOME/.config/openclaw/env"
  export AGENT_NAME="TestAgent"
  export MOCK_BIN="$TEST_DIR/mock-bin"

  mkdir -p "$HOME" "$AMCP_DIR" "$OPENCLAW_DIR" "$CONTENT_DIR"
  mkdir -p "$MOCK_BIN"
  mkdir -p "$HOME/.config/openclaw"
  mkdir -p "$AMCP_DIR/config-backups"
  mkdir -p "$AMCP_DIR/checkpoints"

  # Put mock bin at front of PATH
  export ORIGINAL_PATH="$PATH"
  export PATH="$MOCK_BIN:$PATH"

  # Create a no-op notify.sh
  cat > "$MOCK_BIN/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${TEST_DIR}/notifications.log"
EONOTIFY
  chmod +x "$MOCK_BIN/notify.sh"
}

teardown_test_env() {
  if [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR" ]; then
    rm -rf "$TEST_DIR"
  fi
}

# --- Mock creation helpers ---

# Mock pgrep: configure with MOCK_PGREP_MATCH (patterns that should "match")
create_mock_pgrep() {
  local match_patterns="${1:-}"  # space-separated patterns to match
  cat > "$MOCK_BIN/pgrep" << EOPGREP
#!/bin/bash
# Mock pgrep - matches patterns: $match_patterns
for pattern in $match_patterns; do
  if echo "\$*" | grep -q -- "\$pattern" || [[ "\$*" == *"-f"* ]] && echo "\${*}" | grep -qF "\$pattern"; then
    echo "12345"
    exit 0
  fi
done
exit 1
EOPGREP
  chmod +x "$MOCK_BIN/pgrep"
}

# Mock pgrep that always fails (nothing running)
create_mock_pgrep_fail() {
  cat > "$MOCK_BIN/pgrep" << 'EOPGREP'
#!/bin/bash
exit 1
EOPGREP
  chmod +x "$MOCK_BIN/pgrep"
}

# Mock pkill: just logs the call
create_mock_pkill() {
  cat > "$MOCK_BIN/pkill" << 'EOPKILL'
#!/bin/bash
echo "pkill $*" >> "${TEST_DIR}/pkill.log"
exit 0
EOPKILL
  chmod +x "$MOCK_BIN/pkill"
}

# Mock curl: returns configurable responses
# Usage: create_mock_curl "200" '{"status":"ok"}'
create_mock_curl() {
  local status="${1:-200}"
  local body="${2:-ok}"
  cat > "$MOCK_BIN/curl" << EOCURL
#!/bin/bash
# Mock curl - returns status $status
if echo "\$*" | grep -q "health"; then
  if [ "$status" = "200" ]; then
    echo "$body"
    exit 0
  else
    exit 1
  fi
fi
# Default: succeed
echo "$body"
exit 0
EOCURL
  chmod +x "$MOCK_BIN/curl"
}

# Mock curl that always fails
create_mock_curl_fail() {
  cat > "$MOCK_BIN/curl" << 'EOCURL'
#!/bin/bash
exit 1
EOCURL
  chmod +x "$MOCK_BIN/curl"
}

# Mock systemctl: always fails (no systemd in test)
create_mock_systemctl() {
  cat > "$MOCK_BIN/systemctl" << 'EOSYSTEMCTL'
#!/bin/bash
echo "systemctl $*" >> "${TEST_DIR}/systemctl.log"
exit 1
EOSYSTEMCTL
  chmod +x "$MOCK_BIN/systemctl"
}

# Mock openclaw command
create_mock_openclaw() {
  local should_succeed="${1:-true}"
  cat > "$MOCK_BIN/openclaw" << EOOC
#!/bin/bash
echo "openclaw \$*" >> "\${TEST_DIR}/openclaw.log"
if [ "$should_succeed" = "true" ]; then
  exit 0
else
  exit 1
fi
EOOC
  chmod +x "$MOCK_BIN/openclaw"
}

# Mock nohup: just runs the command
create_mock_nohup() {
  cat > "$MOCK_BIN/nohup" << 'EONOHUP'
#!/bin/bash
# Just run the command, skip nohup behavior
"$@" &
EONOHUP
  chmod +x "$MOCK_BIN/nohup"
}

# Mock df: returns configurable disk usage
create_mock_df() {
  local free_pct="${1:-50}"
  local used_pct=$((100 - free_pct))
  cat > "$MOCK_BIN/df" << EODF
#!/bin/bash
echo "Filesystem      Size  Used Avail Use% Mounted on"
echo "/dev/sda1       100G  ${used_pct}G   ${free_pct}G  ${used_pct}% /"
EODF
  chmod +x "$MOCK_BIN/df"
}

# Mock free: returns configurable memory
create_mock_free() {
  local free_pct="${1:-50}"
  # Total=1000, available = free_pct * 10
  local available=$((free_pct * 10))
  cat > "$MOCK_BIN/free" << EOFREE
#!/bin/bash
echo "              total        used        free      shared  buff/cache   available"
echo "Mem:           1000         500         200         100         300         $available"
EOFREE
  chmod +x "$MOCK_BIN/free"
}

# Create a sample secrets JSON file
create_sample_secrets() {
  local path="${1:-$TEST_DIR/secrets.json}"
  cat > "$path" << 'EOSECRETS'
[
  {
    "key": "ANTHROPIC_API_KEY",
    "value": "sk-test-12345",
    "targets": [
      {
        "kind": "file",
        "path": "~/.openclaw/openclaw.json",
        "jsonPath": "auth.apiKey"
      },
      {
        "kind": "env",
        "name": "ANTHROPIC_API_KEY"
      },
      {
        "kind": "systemd",
        "service": "openclaw-gateway",
        "name": "ANTHROPIC_API_KEY"
      }
    ]
  }
]
EOSECRETS
  echo "$path"
}

# Create a target JSON file for file-type secrets
create_target_json() {
  local path="${1:-$OPENCLAW_DIR/openclaw.json}"
  mkdir -p "$(dirname "$path")"
  cat > "$path" << 'EOJSON'
{
  "auth": {
    "apiKey": ""
  },
  "gateway": {
    "port": 3141
  }
}
EOJSON
  echo "$path"
}

# Mock amcp CLI: configurable identity validate behavior
# Usage: create_mock_amcp [validate_exit_code]
create_mock_amcp() {
  local validate_exit="${1:-0}"
  cat > "$MOCK_BIN/amcp" << EOAMCP
#!/bin/bash
echo "amcp \$*" >> "\${TEST_DIR}/amcp.log"
if [ "\$1" = "identity" ] && [ "\$2" = "validate" ]; then
  exit $validate_exit
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"
}

# Create a valid (mock) AMCP identity.json for testing
create_valid_identity() {
  local path="${1:-$AMCP_DIR/identity.json}"
  cat > "$path" << 'EOIDENTITY'
{
  "aid": "did:keri:EBqK1z2v3jFj4L5q6R7sT8uV9wXyZ",
  "kel": [{"event": "inception", "sn": 0}],
  "keys": {"current": "key-placeholder"},
  "created": "2025-01-01T00:00:00Z"
}
EOIDENTITY
  echo "$path"
}

# Create a fake (openclaw-deploy-style) identity.json that should fail validation
create_fake_identity() {
  local path="${1:-$AMCP_DIR/identity.json}"
  cat > "$path" << 'EOIDENTITY'
{
  "aid": "sha256:fakehash123456",
  "pinata_jwt": "eyJhbGciOiJIUzI1NiJ9.fake",
  "solvr_api_key": "solvr_fake_key"
}
EOIDENTITY
  echo "$path"
}

# Create mock SCRIPT_DIR with no-op notify.sh
setup_script_dir_mock() {
  local script_dir="$1"
  cp "$MOCK_BIN/notify.sh" "$script_dir/notify.sh"
  chmod +x "$script_dir/notify.sh"
}
