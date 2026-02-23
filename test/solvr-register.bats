#!/usr/bin/env bats
# Tests for _solvr-register.sh — auto-registration of child Solvr accounts
#
# Verifies:
#   - Already registered (SOLVR_API_KEY exists) → exits 0, no registration
#   - Root agent (no parentSolvrName) → warns, exits 0, no registration
#   - Child agent (parentSolvrName set) → registers with protocol-08 naming
#   - Stores key in AMCP config and OpenClaw config
#   - Dry run shows plan without registering

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export AMCP_CLI="$MOCK_BIN/amcp"
  export OC_CONFIG="$HOME/.openclaw/openclaw.json"
  export AMCP_CONFIG="$HOME/.amcp/config.json"

  # Valid identity
  create_mock_amcp 0
  create_valid_identity

  # Copy scripts into sandbox
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in _solvr-register.sh config.sh notify.sh; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock notify.sh
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  # Minimal OpenClaw config (valid JSON for jq)
  mkdir -p "$HOME/.openclaw"
  echo '{"gateway":{"port":3141}}' > "$OC_CONFIG"

  # Minimal AMCP config
  mkdir -p "$HOME/.amcp"
  echo '{}' > "$AMCP_CONFIG"
  chmod 600 "$AMCP_CONFIG"
}

teardown() {
  teardown_test_env
}

# Helper: create mock curl that simulates Solvr API responses
# Uses -w "\n%{http_code}" format: body\nHTTP_CODE
create_solvr_mock_curl() {
  local parent_name="${1:-TestParent}"
  local child_api_key="${2:-solvr_child_key_abc123}"
  cat > "$MOCK_BIN/curl" << EOCURL
#!/bin/bash
# Mock curl for Solvr API — output format: body\\nHTTP_CODE

# GET /agents/<name> check (availability) — NOT register
if echo "\$*" | grep -q "/agents/" && ! echo "\$*" | grep -q "register" && ! echo "\$*" | grep -q "/me"; then
  printf '{"error":"not found"}\n404'
  exit 0
fi

# GET /me — return parent identity
if echo "\$*" | grep -q "/me"; then
  printf '{"agent":{"name":"$parent_name"}}\n200'
  exit 0
fi

# POST /agents/register — return child API key
if echo "\$*" | grep -q "register"; then
  printf '{"api_key":"$child_api_key"}\n201'
  exit 0
fi

# Default
printf 'ok\n200'
exit 0
EOCURL
  chmod +x "$MOCK_BIN/curl"
}

# ============================================================
# Test 1: Already registered — exits 0 immediately
# ============================================================
@test "solvr-register: already registered via env SOLVR_API_KEY exits 0" {
  export SOLVR_API_KEY="solvr_existing_key"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Already registered"* ]]
  [[ "$output" == *"already_registered"* ]]
}

# ============================================================
# Test 2: Already registered via OpenClaw config
# ============================================================
@test "solvr-register: already registered via OpenClaw config exits 0" {
  python3 -c "
import json
with open('$OC_CONFIG') as f:
    d = json.load(f)
d.setdefault('skills',{}).setdefault('entries',{}).setdefault('proactive-solvr',{})['apiKey'] = 'solvr_from_oc'
with open('$OC_CONFIG','w') as f:
    json.dump(d, f)
"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Already registered"* ]]
}

# ============================================================
# Test 3: Already registered via AMCP config
# ============================================================
@test "solvr-register: already registered via AMCP config exits 0" {
  python3 -c "
import json
with open('$AMCP_CONFIG') as f:
    d = json.load(f)
d.setdefault('solvr',{})['apiKey'] = 'solvr_from_amcp'
with open('$AMCP_CONFIG','w') as f:
    json.dump(d, f)
"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Already registered"* ]]
}

# ============================================================
# Test 4: Root agent — no parentSolvrName → warns, exits 0
# ============================================================
@test "solvr-register: root agent (no parentSolvrName) warns and exits 0" {
  unset SOLVR_API_KEY 2>/dev/null || true

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"root agent"* ]]
  [[ "$output" == *"solvr_disabled"* ]]
}

# ============================================================
# Test 5: Child agent — auto-registers with protocol-08 naming
# ============================================================
@test "solvr-register: child agent auto-registers with correct naming" {
  unset SOLVR_API_KEY 2>/dev/null || true

  # Set parentSolvrName in OpenClaw config
  python3 -c "
import json
with open('$OC_CONFIG') as f:
    d = json.load(f)
d.setdefault('skills',{}).setdefault('entries',{}).setdefault('proactive-amcp',{}).setdefault('config',{})['parentSolvrName'] = 'TestParent'
with open('$OC_CONFIG','w') as f:
    json.dump(d, f, indent=2)
"

  # Set parent key in AMCP config
  python3 -c "
import json
with open('$AMCP_CONFIG') as f:
    d = json.load(f)
d.setdefault('solvr',{})['parentKey'] = 'solvr_parent_key_xyz'
with open('$AMCP_CONFIG','w') as f:
    json.dump(d, f, indent=2)
"

  # Mock curl for Solvr API (real jq handles JSON parsing)
  create_solvr_mock_curl "TestParent" "solvr_child_abc"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh" --instance-name "dana"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"registered"* ]]
  [[ "$output" == *"TestParent_child_dana"* ]]
  [[ "$output" == *"CHILD_SOLVR_NAME=TestParent_child_dana"* ]]
}

# ============================================================
# Test 6: Child registration stores key in AMCP config
# ============================================================
@test "solvr-register: stores API key in AMCP config after registration" {
  unset SOLVR_API_KEY 2>/dev/null || true

  # Set parentSolvrName via AMCP config (not OpenClaw)
  python3 -c "
import json
with open('$AMCP_CONFIG') as f:
    d = json.load(f)
d.setdefault('solvr',{})['parentName'] = 'MockParent'
d['solvr']['parentKey'] = 'solvr_parent_key_xyz'
with open('$AMCP_CONFIG','w') as f:
    json.dump(d, f, indent=2)
"

  create_solvr_mock_curl "MockParent" "solvr_new_child_key"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh" --instance-name "worker1"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]

  # Verify key was stored in AMCP config
  local stored_key
  stored_key=$(python3 -c "import json; print(json.load(open('$AMCP_CONFIG')).get('solvr',{}).get('apiKey',''))")
  [ "$stored_key" = "solvr_new_child_key" ]

  # Verify child name stored
  local stored_name
  stored_name=$(python3 -c "import json; print(json.load(open('$AMCP_CONFIG')).get('solvr',{}).get('name',''))")
  [[ "$stored_name" == *"child_worker1"* ]]
}

# ============================================================
# Test 7: Dry run shows what would happen without registering
# ============================================================
@test "solvr-register: dry run does not register" {
  unset SOLVR_API_KEY 2>/dev/null || true

  python3 -c "
import json
with open('$AMCP_CONFIG') as f:
    d = json.load(f)
d.setdefault('solvr',{})['parentName'] = 'DryRunParent'
d['solvr']['parentKey'] = 'solvr_parent_key_xyz'
with open('$AMCP_CONFIG','w') as f:
    json.dump(d, f, indent=2)
"

  # Curl should NOT be called in dry run
  cat > "$MOCK_BIN/curl" << 'EOCURL'
#!/bin/bash
echo "ERROR: curl should not be called in dry run" >&2
exit 1
EOCURL
  chmod +x "$MOCK_BIN/curl"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh" --instance-name "test" --dry-run

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"DRY RUN"* ]]
  [[ "$output" == *"DryRunParent_child_test"* ]]

  # Verify no key stored
  local stored_key
  stored_key=$(python3 -c "import json; print(json.load(open('$AMCP_CONFIG')).get('solvr',{}).get('apiKey',''))")
  [ -z "$stored_key" ]
}

# ============================================================
# Test 8: No parent key available → warns gracefully
# ============================================================
@test "solvr-register: no parent key available warns and exits 0" {
  unset SOLVR_API_KEY 2>/dev/null || true
  unset SOLVR_PARENT_KEY 2>/dev/null || true

  # parentSolvrName but NO parentKey
  python3 -c "
import json
with open('$AMCP_CONFIG') as f:
    d = json.load(f)
d.setdefault('solvr',{})['parentName'] = 'OrphanParent'
with open('$AMCP_CONFIG','w') as f:
    json.dump(d, f, indent=2)
"

  run bash "$SANDBOXED_SCRIPTS/_solvr-register.sh"

  echo "STATUS: $status"
  echo "OUTPUT: $output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no parent API key"* ]] || [[ "$output" == *"no_parent_key"* ]]
}
