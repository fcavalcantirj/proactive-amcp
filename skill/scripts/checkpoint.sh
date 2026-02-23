#!/bin/bash
# checkpoint.sh - Create AMCP checkpoint and pin to IPFS
# Usage: ./checkpoint.sh [--notify] [--force] [--encrypt] [--smart]

set -euo pipefail

command -v python3 &>/dev/null || { echo "FATAL: python3 required but not found" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$(command -v amcp 2>/dev/null || echo "$HOME/bin/amcp")}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"

# Ensure Node.js webcrypto is available for amcp CLI (fixes "crypto.subtle must be defined")
# Node 18 needs this flag; Node 20+ has webcrypto by default (flag is a harmless no-op)
# Critical for systemd/cron contexts where env may be minimal
case "${NODE_OPTIONS:-}" in
  *--experimental-global-webcrypto*) ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--experimental-global-webcrypto" ;;
esac

# Get workspace from OpenClaw config, default to ~/.openclaw/workspace
get_workspace() {
  local ws
  ws=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.openclaw/openclaw.json'))); print(d.get('agents',{}).get('defaults',{}).get('workspace','~/.openclaw/workspace'))" 2>/dev/null || echo '~/.openclaw/workspace')
  echo "${ws/#\~/$HOME}"
}
CONTENT_DIR="${CONTENT_DIR:-$(get_workspace)}"
CHECKPOINT_DIR="${CHECKPOINT_DIR:-$HOME/.amcp/checkpoints}"
LAST_CHECKPOINT_FILE="$HOME/.amcp/last-checkpoint.json"
SECRETS_FILE="$HOME/.amcp/secrets.json"
KEEP_CHECKPOINTS="${KEEP_CHECKPOINTS:-5}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

# Parse args
NOTIFY=""
FORCE_CHECKPOINT=""
SMART_CHECKPOINT=false
NO_SOLVR_METADATA=false
ENCRYPT=false
CHECKPOINT_KEYS_FILE="$HOME/.amcp/checkpoint-keys.json"
for arg in "$@"; do
  case $arg in
    --notify) NOTIFY="--notify" ;;
    --force)  FORCE_CHECKPOINT="force" ;;
    --smart)  SMART_CHECKPOINT=true ;;
    --no-solvr-metadata) NO_SOLVR_METADATA=true ;;
    --encrypt) ENCRYPT=true ;;
  esac
done

# Source secret scanner
source "$SCRIPT_DIR/scan-secrets.sh"

# Pinata config - read from ~/.amcp/config.json (AMCP's own config, not openclaw.json)
PINATA_JWT="${PINATA_JWT:-$(python3 -c "import json; d=json.load(open('$HOME/.amcp/config.json')); print(d.get('pinata',{}).get('jwt',''))" 2>/dev/null || echo '')}"

# Pinning provider: 'pinata' (default) | 'solvr' | 'both'
PINNING_PROVIDER="${PINNING_PROVIDER:-$(python3 -c "import json; d=json.load(open('$HOME/.amcp/config.json')); print(d.get('pinning',{}).get('provider','pinata'))" 2>/dev/null || echo 'pinata')}"

# Cleanup secrets on exit (normal or error) to prevent plaintext secrets on disk
cleanup() {
  rm -f "$SECRETS_FILE"
}
trap cleanup EXIT

# ============================================================
# Identity pre-flight — validate before operating
# ============================================================
validate_identity() {
  if [ ! -f "$IDENTITY_PATH" ]; then
    echo "FATAL: Invalid AMCP identity — run amcp identity create or amcp identity validate for details"
    exit 1
  fi
  if ! "$AMCP_CLI" identity validate --identity "$IDENTITY_PATH" 2>/dev/null; then
    echo "FATAL: Invalid AMCP identity — run amcp identity create or amcp identity validate for details"
    exit 1
  fi
}

validate_identity

# Warn if secrets found in identity.json (they belong in config.json)
warn_identity_secrets() {
  python3 -c "
import json, os, sys
p = os.path.expanduser('$IDENTITY_PATH')
if not os.path.exists(p): sys.exit(0)
d = json.load(open(p))
bad = [k for k in d if k in ('pinata_jwt','pinata_api_key','solvr_api_key','api_key','apiKey','jwt','token','secret','password','mnemonic','email','notifyTarget')]
if bad:
    print(f'WARNING: Secrets found in identity.json: {\", \".join(bad)}', file=sys.stderr)
    print('  Migrate with: proactive-amcp config set <key> <value>', file=sys.stderr)
" 2>&1 || true
}
warn_identity_secrets

mkdir -p "$CHECKPOINT_DIR"

# Get previous CID if exists
PREVIOUS_CID=""
if [ -f "$LAST_CHECKPOINT_FILE" ]; then
  PREVIOUS_CID=$(python3 -c "import json; print(json.load(open('$LAST_CHECKPOINT_FILE')).get('cid',''))" 2>/dev/null || echo '')
fi

# Extract secrets from config files
extract_secrets() {
  python3 << 'EOF'
import json
import os

secrets = []

# 1. AMCP config (CRITICAL - Pinata, etc.)
amcp_path = os.path.expanduser("~/.amcp/config.json")
if os.path.exists(amcp_path):
    with open(amcp_path) as f:
        amcp = json.load(f)
    
    # Pinata
    if "pinata" in amcp:
        if amcp["pinata"].get("jwt"):
            secrets.append({
                "key": "PINATA_JWT",
                "value": amcp["pinata"]["jwt"],
                "type": "jwt",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "pinata.jwt"}]
            })
        if amcp["pinata"].get("apiKey"):
            secrets.append({
                "key": "PINATA_API_KEY",
                "value": amcp["pinata"]["apiKey"],
                "type": "api_key",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "pinata.apiKey"}]
            })
        if amcp["pinata"].get("secret"):
            secrets.append({
                "key": "PINATA_SECRET",
                "value": amcp["pinata"]["secret"],
                "type": "credential",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "pinata.secret"}]
            })
    
    # API keys from AMCP config
    if "apiKeys" in amcp:
        if amcp["apiKeys"].get("aclawdemy", {}).get("jwt"):
            secrets.append({
                "key": "ACLAWDEMY_JWT",
                "value": amcp["apiKeys"]["aclawdemy"]["jwt"],
                "type": "jwt",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "apiKeys.aclawdemy.jwt"}]
            })
        if amcp["apiKeys"].get("agentarxiv"):
            secrets.append({
                "key": "AGENTARXIV_API_KEY",
                "value": amcp["apiKeys"]["agentarxiv"],
                "type": "api_key",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "apiKeys.agentarxiv"}]
            })
        if amcp["apiKeys"].get("brave"):
            secrets.append({
                "key": "BRAVE_SEARCH_API_KEY",
                "value": amcp["apiKeys"]["brave"],
                "type": "api_key",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "apiKeys.brave"}]
            })

# 2. OpenClaw config
oc_path = os.path.expanduser("~/.openclaw/openclaw.json")
if os.path.exists(oc_path):
    with open(oc_path) as f:
        oc = json.load(f)
    
    # Skills API keys
    for name, cfg in oc.get("skills", {}).get("entries", {}).items():
        if "apiKey" in cfg:
            secrets.append({
                "key": f"{name.upper()}_API_KEY",
                "value": cfg["apiKey"],
                "type": "api_key",
                "targets": [{"kind": "file", "path": oc_path, "jsonPath": f"skills.entries.{name}.apiKey"}]
            })

# 3. Auth profiles
auth_path = os.path.expanduser("~/.openclaw/auth-profiles.json")
if os.path.exists(auth_path):
    with open(auth_path) as f:
        auth = json.load(f)
    
    for profile, cfg in auth.get("profiles", {}).items():
        if "token" in cfg:
            secrets.append({
                "key": f"{profile.upper()}_TOKEN",
                "value": cfg["token"].get("key", "") if isinstance(cfg["token"], dict) else cfg["token"],
                "type": "token",
                "targets": [{"kind": "file", "path": auth_path, "jsonPath": f"profiles.{profile}.token.key"}]
            })

print(json.dumps(secrets, indent=2))
EOF
}

# Notify start
if [ "$NOTIFY" = "--notify" ]; then
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Starting checkpoint..."
fi

echo "=== AMCP Checkpoint ==="
echo "Content: $CONTENT_DIR"
echo "Identity: $IDENTITY_PATH"
[ -n "$PREVIOUS_CID" ] && echo "Previous CID: $PREVIOUS_CID"

# Extract secrets
echo "Extracting secrets..."
extract_secrets > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
SECRET_COUNT=$(python3 -c "import json; print(len(json.load(open('$SECRETS_FILE'))))")
echo "Found $SECRET_COUNT secrets"

# Pre-validation: scan content for cleartext secrets
scan_for_secrets "$CONTENT_DIR" "$FORCE_CHECKPOINT"

# Smart content selection (--smart flag): use Groq to filter memory files
EFFECTIVE_CONTENT_DIR="$CONTENT_DIR"
SMART_STAGING=""
if [ "$SMART_CHECKPOINT" = true ] && [ -x "$SCRIPT_DIR/smart-checkpoint-filter.sh" ]; then
  echo ""
  echo "=== Smart Content Selection (Groq) ==="
  local_smart_args=("--content-dir" "$CONTENT_DIR")

  SMART_MANIFEST=$("$SCRIPT_DIR/smart-checkpoint-filter.sh" "${local_smart_args[@]}" 2>&1 | tee /dev/stderr | tail -1) || {
    echo "WARN: Smart filter failed, including all files (fallback)" >&2
    SMART_MANIFEST=""
  }

  if [ -n "$SMART_MANIFEST" ]; then
    # Copy content to temp staging, then remove excluded files
    SMART_STAGING=$(mktemp -d)
    rsync -a \
      --exclude='.venv' --exclude='.git' --exclude='node_modules' \
      --exclude='__pycache__' --exclude='*.pyc' --exclude='.pytest_cache' \
      "$CONTENT_DIR/" "$SMART_STAGING/"

    local excluded_count=0
    while IFS= read -r excl_file; do
      local staged_path="$SMART_STAGING/$excl_file"
      if [ -f "$staged_path" ]; then
        rm -f "$staged_path"
        excluded_count=$((excluded_count + 1))
      fi
    done < <(echo "$SMART_MANIFEST" | python3 -c "
import json, sys
try:
    m = json.loads(sys.stdin.read())
    for f in m.get('exclude', []):
        print(f)
except: pass
" 2>/dev/null)
    echo "  Excluded $excluded_count files from checkpoint"
    EFFECTIVE_CONTENT_DIR="$SMART_STAGING"
  fi
elif [ "$SMART_CHECKPOINT" = true ]; then
  echo "WARN: --smart requested but smart-checkpoint-filter.sh not found" >&2
fi

# Cleanup smart staging on exit
cleanup_smart() {
  [ -n "$SMART_STAGING" ] && rm -rf "$SMART_STAGING"
}
trap 'cleanup; cleanup_smart' EXIT

# Create checkpoint
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
CHECKPOINT_PATH="$CHECKPOINT_DIR/checkpoint-$TIMESTAMP.amcp"

echo "Creating checkpoint..."
AMCP_ARGS="checkpoint create --identity $IDENTITY_PATH --content $EFFECTIVE_CONTENT_DIR --secrets $SECRETS_FILE --out $CHECKPOINT_PATH"
[ -n "$PREVIOUS_CID" ] && AMCP_ARGS="$AMCP_ARGS --previous $PREVIOUS_CID"

$AMCP_CLI $AMCP_ARGS

echo "Checkpoint created: $CHECKPOINT_PATH"

# Encrypt checkpoint if requested
if [ "$ENCRYPT" = true ]; then
  echo ""
  echo "=== Encrypting Checkpoint ==="
  ENCRYPT_KEY=$(openssl rand -hex 32)
  ENCRYPTED_PATH="${CHECKPOINT_PATH}.enc"
  openssl enc -aes-256-cbc -salt -pbkdf2 \
    -in "$CHECKPOINT_PATH" \
    -out "$ENCRYPTED_PATH" \
    -pass "pass:${ENCRYPT_KEY}" || {
      echo "FATAL: Encryption failed" >&2
      exit 1
    }
  # Replace plaintext with encrypted version
  mv "$ENCRYPTED_PATH" "$CHECKPOINT_PATH"
  echo "  Encrypted checkpoint: $CHECKPOINT_PATH"

  # Save key — will be associated with CID after pinning
  # Initialize keys file if missing
  if [ ! -f "$CHECKPOINT_KEYS_FILE" ]; then
    echo '{}' > "$CHECKPOINT_KEYS_FILE"
    chmod 600 "$CHECKPOINT_KEYS_FILE"
  fi
  # Store key temporarily under localPath; will be re-keyed under CID after pinning
  ENCRYPT_KEY_SAVED=true
  echo "  Encryption key will be saved after pinning"
fi

# Pin to IPFS
echo "Pinning to IPFS (provider: $PINNING_PROVIDER)..."

CID=""
PINATA_CID=""
SOLVR_CID=""

# Pin to Pinata
pin_to_pinata() {
  if [ -z "$PINATA_JWT" ]; then
    echo "⚠️ No Pinata JWT configured"
    return 1
  fi
  local response
  response=$(curl -s -X POST "https://api.pinata.cloud/pinning/pinFileToIPFS" \
    -H "Authorization: Bearer $PINATA_JWT" \
    -F "file=@$CHECKPOINT_PATH" \
    -F "pinataMetadata={\"name\":\"amcp-$AGENT_NAME-$TIMESTAMP\"}")
  PINATA_CID=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('IpfsHash',''))" 2>/dev/null || echo '')
  if [ -n "$PINATA_CID" ]; then
    echo "  Pinata: $PINATA_CID"
    return 0
  else
    echo "⚠️ Pinata error: $response"
    return 1
  fi
}

# Pin to Solvr
pin_to_solvr() {
  if [ -x "$SCRIPT_DIR/pin-to-solvr.sh" ]; then
    local solvr_output
    solvr_output=$("$SCRIPT_DIR/pin-to-solvr.sh" "$CHECKPOINT_PATH" "amcp-$AGENT_NAME-$TIMESTAMP") || {
      echo "⚠️ Solvr pin failed"
      SOLVR_CID=""
      return 1
    }
    SOLVR_CID="$solvr_output"
    echo "  Solvr: $SOLVR_CID"
    return 0
  else
    echo "⚠️ pin-to-solvr.sh not found"
    return 1
  fi
}

case "$PINNING_PROVIDER" in
  solvr)
    pin_to_solvr
    CID="$SOLVR_CID"
    ;;
  both)
    pin_to_pinata || true
    pin_to_solvr || true
    CID="${PINATA_CID:-$SOLVR_CID}"
    if [ -z "$PINATA_CID" ] && [ -z "$SOLVR_CID" ]; then
      echo "⚠️ Both pinning providers failed"
    fi
    ;;
  pinata|*)
    pin_to_pinata
    CID="$PINATA_CID"
    ;;
esac

if [ -n "$CID" ]; then
  if [ "$ENCRYPT" = true ]; then
    echo "✅ Encrypted checkpoint pinned to IPFS: $CID"
  else
    echo "✅ Pinned to IPFS: $CID"
  fi
fi

# Save encryption key keyed by CID (or localPath if no CID)
if [ "$ENCRYPT" = true ] && [ "${ENCRYPT_KEY_SAVED:-false}" = true ]; then
  local_key_id="${CID:-$CHECKPOINT_PATH}"
  python3 -c "
import json, os, sys
keys_path = os.path.expanduser('$CHECKPOINT_KEYS_FILE')
keys = {}
if os.path.exists(keys_path):
    with open(keys_path) as f:
        keys = json.load(f)
keys['$local_key_id'] = {
    'key': '$ENCRYPT_KEY',
    'created': '$(date -Iseconds)',
    'localPath': '$CHECKPOINT_PATH'
}
with open(keys_path, 'w') as f:
    json.dump(keys, f, indent=2)
os.chmod(keys_path, 0o600)
" 2>/dev/null || echo "WARN: Failed to save encryption key" >&2
  echo "  Encryption key saved to $CHECKPOINT_KEYS_FILE"
fi

# Update last checkpoint file
ENCRYPTED_FLAG="false"
[ "$ENCRYPT" = true ] && ENCRYPTED_FLAG="true"
cat > "$LAST_CHECKPOINT_FILE" << EOJSON
{
  "cid": "$CID",
  "localPath": "$CHECKPOINT_PATH",
  "timestamp": "$(date -Iseconds)",
  "previousCID": "$PREVIOUS_CID",
  "secretCount": $SECRET_COUNT,
  "encrypted": $ENCRYPTED_FLAG
}
EOJSON

echo "Updated: $LAST_CHECKPOINT_FILE"

# Register checkpoint with Solvr unified API (best-effort, non-blocking)
if [ "$NO_SOLVR_METADATA" = false ] && [ -n "$CID" ] && [ -x "$SCRIPT_DIR/register-checkpoint-solvr.sh" ]; then
  "$SCRIPT_DIR/register-checkpoint-solvr.sh" \
    --cid "$CID" \
    --checkpoint-path "$CHECKPOINT_PATH" \
    --name "amcp-quick-$AGENT_NAME-$TIMESTAMP" \
    --content-dir "$CONTENT_DIR" || true
fi

# Rotate old checkpoints
echo "Rotating old checkpoints (keep $KEEP_CHECKPOINTS)..."
ls -1t "$CHECKPOINT_DIR"/checkpoint-*.amcp 2>/dev/null | tail -n +$((KEEP_CHECKPOINTS + 1)) | while read -r f; do
  echo "Removing old: $f"
  rm -f "$f"
done

# Notify end
if [ "$NOTIFY" = "--notify" ]; then
  if [ -n "$CID" ]; then
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Checkpoint complete. CID: $CID"
  else
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Checkpoint complete (local only)"
  fi
fi

echo "=== Done ==="
