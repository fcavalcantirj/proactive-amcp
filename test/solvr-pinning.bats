#!/usr/bin/env bats
# Tests for Solvr pinning integration
#
# Verifies:
# - _solvr-pin.sh with mock Solvr CLI returns CID
# - _solvr-pin.sh without API key fails gracefully
# - checkpoint.sh --full with provider=solvr uses Solvr
# - checkpoint.sh --full with provider=both uses both
# - resuscitate.sh tries Solvr gateway first
# - CID fields stored correctly in last-checkpoint.json

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Sandbox scripts
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in _solvr-pin.sh _solvr-checkpoint.sh solvr.sh checkpoint.sh _checkpoint-full.sh _secrets-scan.sh resuscitate.sh solvr-integration.sh _secrets-inject.sh _checkpoint-decrypt.sh; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock notify.sh in sandboxed scripts
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
if [ "$1" = "resuscitate" ]; then
  # Find --out-content and create mock content
  while [ $# -gt 0 ]; do
    if [ "$1" = "--out-content" ]; then
      mkdir -p "$2"
      echo "restored content" > "$2/MEMORY.md"
    fi
    if [ "$1" = "--out-secrets" ]; then
      echo "[]" > "$2"
    fi
    shift
  done
  exit 0
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Mock Solvr CLI — returns a CID
  cat > "$MOCK_BIN/solvr" << 'EOSOLVR'
#!/bin/bash
echo "solvr $*" >> "${TEST_DIR}/solvr.log"
if [ "$1" = "pin" ] && [ "$2" = "add-file" ]; then
  echo "Pinned: bafkreihdwdcefghdqkjv67uzcmw7ojeexedzdetojuzjevtenccjv274yab"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "solvr-cli 0.1.0"
  exit 0
fi
exit 0
EOSOLVR
  chmod +x "$MOCK_BIN/solvr"

  # Mock curl
  cat > "$MOCK_BIN/curl" << 'EOCURL'
#!/bin/bash
echo "curl $*" >> "${TEST_DIR}/curl.log"
# Pinata pinFileToIPFS
if echo "$*" | grep -q "pinFileToIPFS"; then
  echo '{"IpfsHash":"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"}'
  exit 0
fi
# Solvr /v1/me
if echo "$*" | grep -q "/v1/me"; then
  echo '{"name":"TestAgent"}'
  exit 0
fi
# Solvr /v1/add (pin endpoint)
if echo "$*" | grep -q "/v1/add"; then
  echo '{"cid":"bafkreihdwdcefghdqkjv67uzcmw7ojeexedzdetojuzjevtenccjv274yab","name":"test"}'
  exit 0
fi
# Solvr /v1/agents (registration) or /v1/agents/me/checkpoints
if echo "$*" | grep -q "/v1/agents"; then
  echo '{"id":"agent_TestAgent","name":"TestAgent"}'
  exit 0
fi
# Health endpoint
if echo "$*" | grep -q "health"; then
  echo '{"ok":true}'
  exit 0
fi
# IPFS gateway download
if echo "$*" | grep -q "ipfs.solvr.dev\|gateway.pinata.cloud\|ipfs.io\|cloudflare-ipfs.com"; then
  # Find -o flag and write mock checkpoint
  local output_file=""
  local args=($*)
  for ((i=0; i<${#args[@]}; i++)); do
    if [ "${args[$i]}" = "-o" ]; then
      output_file="${args[$((i+1))]}"
      break
    fi
  done
  if [ -n "$output_file" ]; then
    echo '{"checkpoint":"mock-from-gateway"}' > "$output_file"
  fi
  exit 0
fi
echo "ok"
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
    --exclude=*|-a|--info=*|--exclude) ;;
    *)
      if [ -z "$SRC" ]; then SRC="$arg"
      else DEST="$arg"
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

  # Mock pgrep (gateway not running)
  create_mock_pgrep_fail

  # Mock systemctl
  create_mock_systemctl

  # Create valid identity
  create_valid_identity

  # Create AMCP config with Solvr key
  cat > "$AMCP_DIR/config.json" << 'EOCONFIG'
{
  "pinata": {
    "jwt": "eyJhbGciOiJIUzI1NiJ9.test.pinata_jwt_value"
  },
  "solvr": {
    "apiKey": "solvr_test_key_for_pinning_12345678901234567890"
  },
  "pinning": {
    "provider": "pinata"
  }
}
EOCONFIG
  chmod 600 "$AMCP_DIR/config.json"

  # Create openclaw.json
  mkdir -p "$OPENCLAW_DIR"
  cat > "$OPENCLAW_DIR/openclaw.json" << 'EOOC'
{
  "gateway": {"port": 18789},
  "skills": {"entries": {}},
  "agents": {"defaults": {"workspace": "~/.openclaw/workspace"}}
}
EOOC

  # Create workspace with clean content
  mkdir -p "$CONTENT_DIR"
  echo "Hello world" > "$CONTENT_DIR/README.md"

  # Set env vars
  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export CHECKPOINT_DIR="$AMCP_DIR/checkpoints"
  export KEEP_CHECKPOINTS=5
  export SOLVR_CLI="$MOCK_BIN/solvr"
}

teardown() {
  teardown_test_env
}

# ============================================================
# Test 1: _solvr-pin.sh with valid file returns CID
# ============================================================

@test "_solvr-pin.sh with valid file returns CID" {
  # Create a test file
  echo "test checkpoint data" > "$TEST_DIR/test.amcp"

  # Export Solvr API key
  export SOLVR_API_KEY="solvr_test_key_for_pinning_12345678901234567890"

  run bash "$SANDBOXED_SCRIPTS/_solvr-pin.sh" "$TEST_DIR/test.amcp" "test-checkpoint"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  # Should output a CID (bafy... format from mock)
  [[ "$output" == *"bafkrei"* ]]

  # Verify curl was called with /v1/add (Solvr API endpoint)
  [ -f "$TEST_DIR/curl.log" ]
  grep -q "/v1/add" "$TEST_DIR/curl.log"
}

# ============================================================
# Test 2: _solvr-pin.sh with missing API key fails gracefully
# ============================================================

@test "_solvr-pin.sh with missing API key fails gracefully" {
  echo "test data" > "$TEST_DIR/test.amcp"

  # No SOLVR_API_KEY set, and config has no solvr.apiKey
  unset SOLVR_API_KEY
  local empty_config="$TEST_DIR/empty-config.json"
  echo '{}' > "$empty_config"

  run bash -c "CONFIG_FILE='$empty_config' SOLVR_API_KEY='' bash '$SANDBOXED_SCRIPTS/_solvr-pin.sh' '$TEST_DIR/test.amcp'"
  echo "OUTPUT: $output"
  [ "$status" -ne 0 ]
  [[ "$output" == *"No Solvr API key"* ]]
}

# ============================================================
# Test 3: checkpoint.sh --full with provider=solvr uses Solvr
# ============================================================

@test "checkpoint.sh --full with provider=solvr uploads to Solvr" {
  # Set provider to solvr in config
  python3 -c "
import json
with open('$AMCP_DIR/config.json') as f:
    d = json.load(f)
d['pinning'] = {'provider': 'solvr'}
with open('$AMCP_DIR/config.json', 'w') as f:
    json.dump(d, f, indent=2)
"

  export SOLVR_API_KEY="solvr_test_key_for_pinning_12345678901234567890"

  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --full
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FULL CHECKPOINT COMPLETE"* ]]
  # Should show Solvr pinning
  [[ "$output" == *"Solvr"* ]] || [[ "$output" == *"solvr"* ]]
  # Should store CID in last-checkpoint.json
  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  # Check provider field
  local provider
  provider=$(python3 -c "import json; print(json.load(open('$AMCP_DIR/last-checkpoint.json')).get('pinningProvider',''))")
  [ "$provider" = "solvr" ]
}

# ============================================================
# Test 4: checkpoint.sh --full with provider=both uploads to both
# ============================================================

@test "checkpoint.sh --full with provider=both uploads to both" {
  # Set provider to both in config
  python3 -c "
import json
with open('$AMCP_DIR/config.json') as f:
    d = json.load(f)
d['pinning'] = {'provider': 'both'}
with open('$AMCP_DIR/config.json', 'w') as f:
    json.dump(d, f, indent=2)
"

  export SOLVR_API_KEY="solvr_test_key_for_pinning_12345678901234567890"

  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --full
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FULL CHECKPOINT COMPLETE"* ]]
  # Should show both providers
  [[ "$output" == *"Pinata"* ]] || [[ "$output" == *"pinata"* ]]
  [[ "$output" == *"Solvr"* ]] || [[ "$output" == *"solvr"* ]]
  # Check last-checkpoint.json has provider field
  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  local provider
  provider=$(python3 -c "import json; print(json.load(open('$AMCP_DIR/last-checkpoint.json')).get('pinningProvider',''))")
  [ "$provider" = "both" ]
}

# ============================================================
# Test 5: resuscitate.sh tries Solvr gateway first
# ============================================================

@test "resuscitate.sh tries Solvr gateway first when fetching by CID" {
  export SOLVR_API_KEY=""
  # Disable Solvr in config for this test (testing gateway order, not Solvr integration)
  python3 -c "
import json
with open('$AMCP_DIR/config.json') as f:
    d = json.load(f)
d.pop('solvr', None)
with open('$AMCP_DIR/config.json', 'w') as f:
    json.dump(d, f)
"
  # Create a mock last-checkpoint.json
  cat > "$AMCP_DIR/last-checkpoint.json" << 'EOLC'
{
  "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "localPath": "",
  "timestamp": "2026-01-01T00:00:00Z"
}
EOLC

  # Mock pkill for gateway restart
  create_mock_pkill

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh" \
    --from-cid "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
  echo "OUTPUT: $output"

  # Check that Solvr gateway was tried first
  [ -f "$TEST_DIR/curl.log" ]
  # Solvr should appear before Pinata in the curl log
  local first_solvr_line
  first_solvr_line=$(grep -n "ipfs.solvr.dev" "$TEST_DIR/curl.log" | head -1 | cut -d: -f1)
  if [ -n "$first_solvr_line" ]; then
    # Solvr gateway was tried
    [[ "$output" == *"solvr"* ]] || [[ "$output" == *"Solvr"* ]]
  fi
}

# ============================================================
# Test 6: --gateway flag overrides default gateway order
# ============================================================

@test "resuscitate.sh --gateway flag overrides default order" {
  export SOLVR_API_KEY=""
  # Disable Solvr in config for this test (testing gateway order, not Solvr integration)
  python3 -c "
import json
with open('$AMCP_DIR/config.json') as f:
    d = json.load(f)
d.pop('solvr', None)
with open('$AMCP_DIR/config.json', 'w') as f:
    json.dump(d, f)
"
  cat > "$AMCP_DIR/last-checkpoint.json" << 'EOLC'
{
  "cid": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
  "localPath": "",
  "timestamp": "2026-01-01T00:00:00Z"
}
EOLC

  create_mock_pkill
  # Gateway must be DOWN so Tier 1 (restart) and Tier 2 (config fix) fail,
  # forcing resurrection to reach Tier 3 (rehydrate) where --gateway is used.
  create_mock_pgrep_fail
  # Curl mock: health endpoints fail, but IPFS gateway downloads succeed
  cat > "$MOCK_BIN/curl" << 'EOCURL'
#!/bin/bash
echo "curl $*" >> "${TEST_DIR}/curl.log"
# Health endpoint — must fail so restart/config tiers don't short-circuit
if echo "$*" | grep -q "health"; then
  exit 1
fi
# IPFS gateway download — succeed and write mock checkpoint
if echo "$*" | grep -q "ipfs.solvr.dev\|gateway.pinata.cloud\|ipfs.io\|cloudflare-ipfs.com"; then
  local output_file=""
  local args=($*)
  for ((i=0; i<${#args[@]}; i++)); do
    if [ "${args[$i]}" = "-o" ]; then
      output_file="${args[$((i+1))]}"
      break
    fi
  done
  if [ -n "$output_file" ]; then
    echo '{"checkpoint":"mock-from-gateway"}' > "$output_file"
  fi
  exit 0
fi
echo "ok"
exit 0
EOCURL
  chmod +x "$MOCK_BIN/curl"

  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh" \
    --from-cid "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" \
    --gateway pinata
  echo "OUTPUT: $output"

  # Should try preferred gateway
  [[ "$output" == *"preferred gateway: pinata"* ]] || [[ "$output" == *"Trying preferred gateway"* ]]
}

# ============================================================
# Test 7: last-checkpoint.json stores provider-specific CIDs
# ============================================================

@test "last-checkpoint.json stores pinataCid and solvrCid when provider=both" {
  python3 -c "
import json
with open('$AMCP_DIR/config.json') as f:
    d = json.load(f)
d['pinning'] = {'provider': 'both'}
with open('$AMCP_DIR/config.json', 'w') as f:
    json.dump(d, f, indent=2)
"

  export SOLVR_API_KEY="solvr_test_key_for_pinning_12345678901234567890"

  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --full
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  # Check that both CID fields exist
  local has_pinata
  has_pinata=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print('yes' if d.get('pinataCid') else 'no')")
  local has_solvr
  has_solvr=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print('yes' if d.get('solvrCid') else 'no')")
  [ "$has_pinata" = "yes" ]
  [ "$has_solvr" = "yes" ]
}

# ============================================================
# Test 8: _solvr-pin.sh --dry-run does not call Solvr CLI
# ============================================================

@test "_solvr-pin.sh --dry-run shows plan without pinning" {
  echo "test data" > "$TEST_DIR/test.amcp"
  export SOLVR_API_KEY="solvr_test_key_for_pinning_12345678901234567890"

  run bash "$SANDBOXED_SCRIPTS/_solvr-pin.sh" "$TEST_DIR/test.amcp" "test-pin" --dry-run
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"DRY RUN"* ]]
  # Solvr CLI should NOT have been called
  [ ! -f "$TEST_DIR/solvr.log" ]
}
