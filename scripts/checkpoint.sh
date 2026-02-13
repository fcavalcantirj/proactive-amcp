#!/bin/bash
# checkpoint.sh - Create AMCP checkpoint and pin to IPFS
# Usage: ./checkpoint.sh [--notify]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$HOME/bin/amcp}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"

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
NOTIFY="${1:-}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

# Pinata config - read from ~/.amcp/config.json (AMCP's own config, not openclaw.json)
PINATA_JWT="${PINATA_JWT:-$(python3 -c "import json; d=json.load(open('$HOME/.amcp/config.json')); print(d.get('pinata',{}).get('jwt',''))" 2>/dev/null || echo '')}"

# Cleanup secrets on exit (normal or error) to prevent plaintext secrets on disk
cleanup() {
  rm -f "$SECRETS_FILE"
}
trap cleanup EXIT

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

# Create checkpoint
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
CHECKPOINT_PATH="$CHECKPOINT_DIR/checkpoint-$TIMESTAMP.amcp"

echo "Creating checkpoint..."
AMCP_ARGS="checkpoint create --identity $IDENTITY_PATH --content $CONTENT_DIR --secrets $SECRETS_FILE --out $CHECKPOINT_PATH"
[ -n "$PREVIOUS_CID" ] && AMCP_ARGS="$AMCP_ARGS --previous $PREVIOUS_CID"

$AMCP_CLI $AMCP_ARGS

echo "Checkpoint created: $CHECKPOINT_PATH"

# Pin to IPFS via Pinata
CID=""
if [ -n "$PINATA_JWT" ]; then
  echo "Pinning to IPFS via Pinata..."
  
  RESPONSE=$(curl -s -X POST "https://api.pinata.cloud/pinning/pinFileToIPFS" \
    -H "Authorization: Bearer $PINATA_JWT" \
    -F "file=@$CHECKPOINT_PATH" \
    -F "pinataMetadata={\"name\":\"amcp-$AGENT_NAME-$TIMESTAMP\"}")
  
  CID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('IpfsHash',''))" 2>/dev/null || echo '')
  
  if [ -n "$CID" ]; then
    echo "✅ Pinned to IPFS: $CID"
    echo "Gateway: https://gateway.pinata.cloud/ipfs/$CID"
  else
    echo "⚠️ Pinata response: $RESPONSE"
  fi
else
  echo "⚠️ No Pinata JWT configured, skipping IPFS pin"
fi

# Update last checkpoint file
cat > "$LAST_CHECKPOINT_FILE" << EOJSON
{
  "cid": "$CID",
  "localPath": "$CHECKPOINT_PATH",
  "timestamp": "$(date -Iseconds)",
  "previousCID": "$PREVIOUS_CID",
  "secretCount": $SECRET_COUNT
}
EOJSON

echo "Updated: $LAST_CHECKPOINT_FILE"

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
