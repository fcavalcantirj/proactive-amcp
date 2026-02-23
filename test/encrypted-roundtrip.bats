#!/usr/bin/env bats
# Tests for encrypted checkpoint round-trip
#
# Verifies that:
# - checkpoint.sh --encrypt creates an encrypted checkpoint using real openssl
# - Encryption key is saved to checkpoint-keys.json keyed by CID
# - resuscitate.sh detects encrypted checkpoint and auto-resolves key
# - Content (SOUL.md, MEMORY.md) is restored after decrypt + resuscitate
# - --key-file flag works for manual key provision
#
# IMPORTANT: Uses REAL openssl for encrypt/decrypt — that's the code under test.
# All other external commands (amcp CLI, curl, pgrep, systemctl) are mocked.

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Sandbox scripts — copy all scripts needed by checkpoint.sh and resuscitate.sh
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  local scripts_to_copy=(
    checkpoint.sh
    resuscitate.sh
    checkpoint-decrypt.sh
    scan-secrets.sh
    solvr-integration.sh
    inject-secrets.sh
  )
  for f in "${scripts_to_copy[@]}"; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock notify.sh in sandbox
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  # Mock solvr.sh (no-op for checkpoint registration and pin)
  cat > "$SANDBOXED_SCRIPTS/solvr.sh" << 'EOSOLVR'
#!/bin/bash
exit 0
EOSOLVR
  chmod +x "$SANDBOXED_SCRIPTS/solvr.sh"

  # Mock recreate-venvs.sh (no-op)
  cat > "$SANDBOXED_SCRIPTS/recreate-venvs.sh" << 'EOVENV'
#!/bin/bash
exit 0
EOVENV
  chmod +x "$SANDBOXED_SCRIPTS/recreate-venvs.sh"

  # Keep real openssl on PATH — it's the code under test
  # But mock amcp CLI to produce/consume checkpoint files
  MOCK_CID="QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"

  cat > "$MOCK_BIN/amcp" << 'EOAMCP'
#!/bin/bash
if [ "$1" = "identity" ] && [ "$2" = "validate" ]; then
  exit 0
fi
if [ "$1" = "checkpoint" ] && [ "$2" = "create" ]; then
  # Parse --out and --content args
  OUT_PATH=""
  CONTENT_PATH=""
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) OUT_PATH="$2"; shift 2 ;;
      --content) CONTENT_PATH="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -n "$OUT_PATH" ]; then
    # Create a real tarball from content dir so decrypt round-trip is meaningful
    if [ -n "$CONTENT_PATH" ] && [ -d "$CONTENT_PATH" ]; then
      tar -czf "$OUT_PATH" -C "$CONTENT_PATH" . 2>/dev/null
    else
      echo '{"checkpoint":"mock-data"}' > "$OUT_PATH"
    fi
  fi
  exit 0
fi
if [ "$1" = "resuscitate" ]; then
  # Parse args
  CHECKPOINT=""
  OUT_CONTENT=""
  OUT_SECRETS=""
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --checkpoint) CHECKPOINT="$2"; shift 2 ;;
      --out-content) OUT_CONTENT="$2"; shift 2 ;;
      --out-secrets) OUT_SECRETS="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  # Extract tarball to out-content (this is the decrypted checkpoint)
  if [ -n "$CHECKPOINT" ] && [ -n "$OUT_CONTENT" ]; then
    mkdir -p "$OUT_CONTENT"
    tar -xzf "$CHECKPOINT" -C "$OUT_CONTENT" 2>/dev/null || {
      # If not a tarball, just copy the file
      cp "$CHECKPOINT" "$OUT_CONTENT/checkpoint-data"
    }
  fi
  # Create empty secrets file
  if [ -n "$OUT_SECRETS" ]; then
    echo '[]' > "$OUT_SECRETS"
  fi
  exit 0
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Mock curl — handles both Pinata pinning and IPFS gateway fetching
  cat > "$MOCK_BIN/curl" << EOCURL
#!/bin/bash
# Mock curl for encrypted roundtrip tests

# Pinata upload: return mock CID
if echo "\$*" | grep -q "pinFileToIPFS"; then
  echo '{"IpfsHash":"$MOCK_CID"}'
  exit 0
fi

# IPFS gateway fetch: serve local checkpoint file
# Parse -o flag to find output path
OUTPUT_PATH=""
PREV_ARG=""
for arg in "\$@"; do
  if [ "\$PREV_ARG" = "-o" ]; then
    OUTPUT_PATH="\$arg"
    break
  fi
  PREV_ARG="\$arg"
done

if [ -n "\$OUTPUT_PATH" ] && echo "\$*" | grep -qE "ipfs|gateway"; then
  # Find the latest local checkpoint and serve it
  LATEST_CP=\$(ls -1t "$CHECKPOINT_DIR"/checkpoint-*.amcp 2>/dev/null | head -1)
  if [ -n "\$LATEST_CP" ] && [ -f "\$LATEST_CP" ]; then
    cp "\$LATEST_CP" "\$OUTPUT_PATH"
    exit 0
  fi
fi

# Health checks and Solvr: fail
if echo "\$*" | grep -q "health\|solvr"; then
  exit 1
fi
echo '{}'
exit 0
EOCURL
  chmod +x "$MOCK_BIN/curl"

  # Mock pgrep — gateway is not running (for resuscitate)
  create_mock_pgrep_fail

  # Mock systemctl — always fails (no systemd in test)
  create_mock_systemctl

  # Mock pkill
  create_mock_pkill

  # Mock nohup
  create_mock_nohup

  # Create valid identity
  create_valid_identity

  # Create AMCP config (minimal — pinata JWT for pinning)
  cat > "$AMCP_DIR/config.json" << 'EOCONFIG'
{
  "pinata": {
    "jwt": "eyJhbGciOiJIUzI1NiJ9.test.mock_pinata_jwt"
  },
  "pinning": {
    "provider": "pinata"
  }
}
EOCONFIG
  chmod 600 "$AMCP_DIR/config.json"

  # Create workspace with SOUL.md and MEMORY.md
  mkdir -p "$CONTENT_DIR"
  echo "I am a pirate emperor. I sail the digital seas." > "$CONTENT_DIR/SOUL.md"
  echo "I learned that openssl encryption is deterministic with same key." > "$CONTENT_DIR/MEMORY.md"
  echo "print('hello world')" > "$CONTENT_DIR/main.py"

  # Set env vars
  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export CHECKPOINT_DIR="$AMCP_DIR/checkpoints"
  export KEEP_CHECKPOINTS=5
  export SOLVR_API_KEY=""  # Disable Solvr in tests
  export GATEWAY_SETTLE_TIME=0
}

teardown() {
  teardown_test_env
}

# ============================================================
# Checkpoint encryption tests
# ============================================================

@test "checkpoint --encrypt creates encrypted checkpoint file" {
  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --encrypt
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should mention encryption in output
  [[ "$output" == *"Encrypting Checkpoint"* ]] || [[ "$output" == *"Encrypted checkpoint"* ]]

  # Checkpoint file should exist
  local checkpoint_file
  checkpoint_file=$(ls -1t "$CHECKPOINT_DIR"/checkpoint-*.amcp 2>/dev/null | head -1)
  [ -n "$checkpoint_file" ]
  [ -f "$checkpoint_file" ]

  # File should be encrypted (openssl "Salted__" magic header)
  local magic
  magic=$(head -c 8 "$checkpoint_file" | cat -v)
  [[ "$magic" == "Salted__" ]]
}

@test "checkpoint --encrypt saves key to checkpoint-keys.json" {
  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --encrypt
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # checkpoint-keys.json should exist
  local keys_file="$AMCP_DIR/checkpoint-keys.json"
  [ -f "$keys_file" ]

  # Should have at least one entry with a 64-char hex key
  local key_value
  key_value=$(python3 -c "
import json
with open('$keys_file') as f:
    keys = json.load(f)
# Get first entry's key value
for entry in keys.values():
    if isinstance(entry, dict):
        print(entry.get('key', ''))
    else:
        print(entry)
    break
")
  [ -n "$key_value" ]
  # Key should be 64 hex chars (32 bytes)
  [ "${#key_value}" -eq 64 ]
}

@test "checkpoint --encrypt sets encrypted=true in last-checkpoint.json" {
  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --encrypt
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  local last_cp="$AMCP_DIR/last-checkpoint.json"
  [ -f "$last_cp" ]

  local encrypted_flag
  encrypted_flag=$(python3 -c "import json; print(json.load(open('$last_cp')).get('encrypted', False))")
  [ "$encrypted_flag" = "True" ]
}

@test "checkpoint without --encrypt creates plaintext checkpoint" {
  run bash "$SANDBOXED_SCRIPTS/checkpoint.sh"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Checkpoint file should NOT have "Salted__" magic
  local checkpoint_file
  checkpoint_file=$(ls -1t "$CHECKPOINT_DIR"/checkpoint-*.amcp 2>/dev/null | head -1)
  [ -n "$checkpoint_file" ]

  local magic
  magic=$(head -c 8 "$checkpoint_file" | cat -v)
  [[ "$magic" != "Salted__" ]]

  # last-checkpoint.json should show encrypted=false
  local encrypted_flag
  encrypted_flag=$(python3 -c "import json; print(json.load(open('$AMCP_DIR/last-checkpoint.json')).get('encrypted', False))")
  [ "$encrypted_flag" = "False" ]
}

# ============================================================
# Round-trip: encrypt then decrypt via resuscitate
# ============================================================

@test "round-trip: encrypted checkpoint decrypted by resuscitate using auto key lookup" {
  # Step 1: Create encrypted checkpoint
  bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --encrypt

  # Verify checkpoint is encrypted
  local checkpoint_file
  checkpoint_file=$(ls -1t "$CHECKPOINT_DIR"/checkpoint-*.amcp 2>/dev/null | head -1)
  [ -f "$checkpoint_file" ]
  local magic
  magic=$(head -c 8 "$checkpoint_file" | cat -v)
  [[ "$magic" == "Salted__" ]]

  # Verify key is saved (keyed by CID or local path)
  [ -f "$AMCP_DIR/checkpoint-keys.json" ]

  # Step 2: Clear CID in last-checkpoint.json so resuscitate uses local file
  # (avoids needing to mock IPFS gateway fetch)
  python3 -c "
import json
lcp = '$AMCP_DIR/last-checkpoint.json'
with open(lcp) as f:
    d = json.load(f)
d['cid'] = ''
with open(lcp, 'w') as f:
    json.dump(d, f)
"

  # Step 3: Delete workspace content
  rm -f "$CONTENT_DIR/SOUL.md" "$CONTENT_DIR/MEMORY.md" "$CONTENT_DIR/main.py"
  [ ! -f "$CONTENT_DIR/SOUL.md" ]
  [ ! -f "$CONTENT_DIR/MEMORY.md" ]

  # Step 4: Resuscitate — should auto-find key from checkpoint-keys.json
  # Uses local checkpoint path from last-checkpoint.json
  # Gateway won't start (mocked to fail) so resuscitate exits non-zero,
  # but content restoration happens during the rehydrate tier
  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"
  echo "RESUSCITATE OUTPUT: $output"

  # Should show decryption messages (logged by checkpoint-decrypt.sh)
  [[ "$output" == *"encrypted"* ]] || [[ "$output" == *"Decrypt"* ]] || [[ "$output" == *"decrypt"* ]]

  # Step 5: Verify content restored — content is copied to CONTENT_DIR
  # before the gateway restart attempt (which fails in test env)
  [ -f "$CONTENT_DIR/SOUL.md" ]
  [ -f "$CONTENT_DIR/MEMORY.md" ]

  # Verify restored content matches original
  local soul_content
  soul_content=$(cat "$CONTENT_DIR/SOUL.md")
  [[ "$soul_content" == *"pirate emperor"* ]]

  local memory_content
  memory_content=$(cat "$CONTENT_DIR/MEMORY.md")
  [[ "$memory_content" == *"openssl encryption"* ]]
}

@test "round-trip: resuscitate with --key-file decrypts successfully" {
  # Step 1: Create encrypted checkpoint
  bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --encrypt

  # Step 2: Extract the key and save to a separate file
  local keys_file="$AMCP_DIR/checkpoint-keys.json"
  local key_value
  key_value=$(python3 -c "
import json
with open('$keys_file') as f:
    keys = json.load(f)
for entry in keys.values():
    if isinstance(entry, dict):
        print(entry.get('key', ''))
    else:
        print(entry)
    break
")
  local key_file="$TEST_DIR/my-key.txt"
  echo -n "$key_value" > "$key_file"

  # Step 3: Remove checkpoint-keys.json so auto-lookup would fail
  rm -f "$keys_file"

  # Step 4: Clear CID so resuscitate uses local checkpoint
  python3 -c "
import json
lcp = '$AMCP_DIR/last-checkpoint.json'
with open(lcp) as f:
    d = json.load(f)
d['cid'] = ''
with open(lcp, 'w') as f:
    json.dump(d, f)
"

  # Step 5: Delete workspace content
  rm -f "$CONTENT_DIR/SOUL.md" "$CONTENT_DIR/MEMORY.md" "$CONTENT_DIR/main.py"

  # Step 6: Resuscitate with --key-file
  # Gateway won't start so overall exit is non-zero, but content is restored
  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh" --key-file "$key_file"
  echo "RESUSCITATE OUTPUT: $output"

  # Should show decryption messages
  [[ "$output" == *"decrypt"* ]] || [[ "$output" == *"Decrypt"* ]] || [[ "$output" == *"encrypted"* ]]

  # Content should be restored before gateway restart attempt
  [ -f "$CONTENT_DIR/SOUL.md" ]
  [ -f "$CONTENT_DIR/MEMORY.md" ]
}

@test "round-trip: resuscitate fails gracefully when encrypted checkpoint has no key" {
  # Step 1: Create encrypted checkpoint
  bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --encrypt

  # Step 2: Remove key store
  rm -f "$AMCP_DIR/checkpoint-keys.json"

  # Step 3: Clear CID so resuscitate uses local checkpoint
  python3 -c "
import json
lcp = '$AMCP_DIR/last-checkpoint.json'
with open(lcp) as f:
    d = json.load(f)
d['cid'] = ''
with open(lcp, 'w') as f:
    json.dump(d, f)
"

  # Step 4: Resuscitate should fail with helpful error about missing key
  run bash "$SANDBOXED_SCRIPTS/resuscitate.sh"
  echo "OUTPUT: $output"

  # Should mention encryption/key issue
  [[ "$output" == *"encrypted"* ]] || [[ "$output" == *"key"* ]]
}

# ============================================================
# Encryption detection tests (checkpoint-decrypt.sh helpers)
# ============================================================

@test "is_checkpoint_encrypted detects openssl-encrypted files" {
  # Create a plaintext file
  local plain_file="$TEST_DIR/plain.amcp"
  echo "plaintext checkpoint data" > "$plain_file"

  # Create an encrypted file using real openssl
  local enc_file="$TEST_DIR/encrypted.amcp"
  echo "secret data" | openssl enc -aes-256-cbc -salt -pbkdf2 \
    -out "$enc_file" -pass pass:testkey123 2>/dev/null

  # Source the decrypt helpers
  CHECKPOINT_KEYS_FILE="$AMCP_DIR/checkpoint-keys.json"
  KEY_FILE=""
  TEMP_FILES=()
  log() { echo "$*"; }
  source "$SANDBOXED_SCRIPTS/checkpoint-decrypt.sh"

  # Plaintext should NOT be detected as encrypted
  ! is_checkpoint_encrypted "$plain_file"

  # Encrypted file SHOULD be detected
  is_checkpoint_encrypted "$enc_file"
}

@test "decrypt_checkpoint decrypts with correct key" {
  # Encrypt some data
  local test_data="Hello, this is my agent soul"
  local enc_file="$TEST_DIR/test-checkpoint.amcp"
  local test_key="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"

  echo "$test_data" | openssl enc -aes-256-cbc -salt -pbkdf2 \
    -out "$enc_file" -pass "pass:${test_key}" 2>/dev/null

  # Source decrypt helpers
  CHECKPOINT_KEYS_FILE="$AMCP_DIR/checkpoint-keys.json"
  KEY_FILE=""
  TEMP_FILES=()
  log() { echo "$*"; }
  source "$SANDBOXED_SCRIPTS/checkpoint-decrypt.sh"

  # Decrypt should succeed
  decrypt_checkpoint "$enc_file" "$test_key"
  local result
  result=$(cat "$enc_file")
  [[ "$result" == *"$test_data"* ]]
}

@test "decrypt_checkpoint fails with wrong key" {
  # Encrypt some data
  local enc_file="$TEST_DIR/test-checkpoint.amcp"
  echo "secret" | openssl enc -aes-256-cbc -salt -pbkdf2 \
    -out "$enc_file" -pass pass:correctkey 2>/dev/null

  # Source decrypt helpers
  CHECKPOINT_KEYS_FILE="$AMCP_DIR/checkpoint-keys.json"
  KEY_FILE=""
  TEMP_FILES=()
  log() { echo "$*"; }
  source "$SANDBOXED_SCRIPTS/checkpoint-decrypt.sh"

  # Decrypt with wrong key should fail
  ! decrypt_checkpoint "$enc_file" "wrongkeywrongkeywrongkeywrongkey"
}

@test "resolve_decrypt_key prefers --key-file over checkpoint-keys.json" {
  # Set up checkpoint-keys.json with one key
  cat > "$AMCP_DIR/checkpoint-keys.json" << 'EOF'
{
  "QmTestCID": {
    "key": "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
    "created": "2026-01-01T00:00:00Z"
  }
}
EOF

  # Set up a key file with a different key
  local key_file="$TEST_DIR/override-key.txt"
  echo -n "override_key_value_here_1234567890abcdef1234567890abcdef" > "$key_file"

  # Source decrypt helpers with KEY_FILE set
  CHECKPOINT_KEYS_FILE="$AMCP_DIR/checkpoint-keys.json"
  KEY_FILE="$key_file"
  TEMP_FILES=()
  log() { echo "$*"; }
  source "$SANDBOXED_SCRIPTS/checkpoint-decrypt.sh"

  # resolve_decrypt_key should return key-file content, not checkpoint-keys.json content
  local resolved
  resolved=$(resolve_decrypt_key "QmTestCID" "/some/path")
  [[ "$resolved" == *"override_key_value"* ]]
}
