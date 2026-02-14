#!/bin/bash
# full-checkpoint.sh - Create FULL AMCP checkpoint with ALL content and secrets
# Usage: ./full-checkpoint.sh [--dry-run] [--notify]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$HOME/bin/amcp}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
CHECKPOINT_DIR="${CHECKPOINT_DIR:-$HOME/.amcp/checkpoints}"
STAGING_DIR="$HOME/.amcp/staging-$$"
LAST_CHECKPOINT_FILE="$HOME/.amcp/last-checkpoint.json"
SECRETS_FILE="$HOME/.amcp/secrets-full.json"
KEEP_CHECKPOINTS="${KEEP_CHECKPOINTS:-5}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

DRY_RUN=false
NOTIFY=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --notify) NOTIFY=true ;;
  esac
done

# Pinata config
PINATA_JWT="${PINATA_JWT:-$(python3 -c "import json; d=json.load(open('$HOME/.amcp/config.json')); print(d.get('pinata',{}).get('jwt',''))" 2>/dev/null || echo '')}"

# Cleanup staging dir and secrets on exit (normal or error)
cleanup() {
  rm -rf "$STAGING_DIR"
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

mkdir -p "$CHECKPOINT_DIR"

# Get previous CID if exists
PREVIOUS_CID=""
if [ -f "$LAST_CHECKPOINT_FILE" ]; then
  PREVIOUS_CID=$(python3 -c "import json; print(json.load(open('$LAST_CHECKPOINT_FILE')).get('cid',''))" 2>/dev/null || echo '')
fi

echo "=============================================="
echo "  AMCP FULL CHECKPOINT"
echo "=============================================="
echo "Agent: $AGENT_NAME"
echo "Identity: $IDENTITY_PATH"
[ -n "$PREVIOUS_CID" ] && echo "Previous CID: $PREVIOUS_CID"
echo ""

# ===========================================
# STAGE 1: Extract ALL secrets
# ===========================================
echo "=== STAGE 1: Extracting ALL secrets ==="

extract_all_secrets() {
  python3 << 'PYEOF'
import json
import os

secrets = []

# 1. AMCP config (CRITICAL - Pinata, recovery, API keys)
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
    
    # AgentMemory credentials (for vault access)
    if "agentmemory" in amcp:
        if amcp["agentmemory"].get("email"):
            secrets.append({
                "key": "AGENTMEMORY_EMAIL",
                "value": amcp["agentmemory"]["email"],
                "type": "credential",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "agentmemory.email"}]
            })
        if amcp["agentmemory"].get("password"):
            secrets.append({
                "key": "AGENTMEMORY_PASSWORD",
                "value": amcp["agentmemory"]["password"],
                "type": "credential",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "agentmemory.password"}]
            })
    
    # Recovery mnemonic (CRITICAL)
    if "recovery" in amcp:
        if amcp["recovery"].get("mnemonic"):
            secrets.append({
                "key": "AMCP_MNEMONIC",
                "value": amcp["recovery"]["mnemonic"],
                "type": "mnemonic",
                "targets": [{"kind": "file", "path": amcp_path, "jsonPath": "recovery.mnemonic"}]
            })

# 2. OpenClaw config (skills API keys)
oc_path = os.path.expanduser("~/.openclaw/openclaw.json")
if os.path.exists(oc_path):
    with open(oc_path) as f:
        oc = json.load(f)
    
    # Skills API keys
    skills = oc.get("skills", {}).get("entries", {})
    for name, cfg in skills.items():
        if isinstance(cfg, dict) and "apiKey" in cfg:
            key_name = name.upper().replace("-", "_") + "_API_KEY"
            secrets.append({
                "key": key_name,
                "value": cfg["apiKey"],
                "type": "api_key",
                "targets": [{"kind": "file", "path": oc_path, "jsonPath": f"skills.entries.{name}.apiKey"}]
            })
    
    # Google Keyring Password (if present)
    gog_cfg = skills.get("gog", {})
    if gog_cfg.get("keyringPassword"):
        secrets.append({
            "key": "GOG_KEYRING_PASSWORD",
            "value": gog_cfg["keyringPassword"],
            "type": "credential",
            "targets": [{"kind": "file", "path": oc_path, "jsonPath": "skills.entries.gog.keyringPassword"}]
        })
    
    # Web search API key
    web_search = oc.get("tools", {}).get("web", {}).get("search", {})
    if web_search.get("apiKey"):
        # Check if not already added
        existing = [s["key"] for s in secrets]
        if "BRAVE_SEARCH_API_KEY" not in existing:
            secrets.append({
                "key": "BRAVE_SEARCH_API_KEY",
                "value": web_search["apiKey"],
                "type": "api_key",
                "targets": [{"kind": "file", "path": oc_path, "jsonPath": "tools.web.search.apiKey"}]
            })

# 3. Auth profiles (tokens)
auth_path = os.path.expanduser("~/.openclaw/auth-profiles.json")
if os.path.exists(auth_path):
    with open(auth_path) as f:
        auth = json.load(f)
    
    for profile, cfg in auth.get("profiles", {}).items():
        if "token" in cfg:
            token_val = cfg["token"].get("key", "") if isinstance(cfg["token"], dict) else cfg["token"]
            if token_val:
                secrets.append({
                    "key": f"{profile.upper()}_TOKEN",
                    "value": token_val,
                    "type": "token",
                    "targets": [{"kind": "file", "path": auth_path, "jsonPath": f"profiles.{profile}.token.key"}]
                })

# 4. Check TOOLS.md for any mentioned but not found
# MOLTBOOK_TOKEN, CLAWDHUB_TOKEN might be in AgentMemory vault
# We'll add placeholders if not found
existing_keys = [s["key"] for s in secrets]
expected_keys = [
    ("MOLTBOOK_TOKEN", "token"),
    ("CLAWDHUB_TOKEN", "api_key"),
]
for key, key_type in expected_keys:
    if key not in existing_keys:
        # Try to get from AgentMemory via agentmemory CLI
        import subprocess
        try:
            result = subprocess.run(
                ["agentmemory", "secret", "get", key, "--show"],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                value = result.stdout.strip()
                if value and not value.startswith("Error"):
                    secrets.append({
                        "key": key,
                        "value": value,
                        "type": key_type,
                        "targets": [{"kind": "env", "name": key}]
                    })
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass

# Deduplicate by key
seen = set()
unique_secrets = []
for s in secrets:
    if s["key"] not in seen:
        seen.add(s["key"])
        unique_secrets.append(s)

print(json.dumps(unique_secrets, indent=2))
PYEOF
}

extract_all_secrets > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
SECRET_COUNT=$(python3 -c "import json; print(len(json.load(open('$SECRETS_FILE'))))")
echo "Found $SECRET_COUNT secrets"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "Secrets found:"
  python3 -c "import json; [print(f'  - {s[\"key\"]} ({s[\"type\"]})') for s in json.load(open('$SECRETS_FILE'))]"
fi

# ===========================================
# STAGE 2: Prepare content staging
# ===========================================
echo ""
echo "=== STAGE 2: Preparing content staging ==="

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Get workspace from OpenClaw config
get_workspace() {
  local ws
  ws=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.openclaw/openclaw.json'))); print(d.get('agents',{}).get('defaults',{}).get('workspace','~/.openclaw/workspace'))" 2>/dev/null || echo '~/.openclaw/workspace')
  echo "${ws/#\~/$HOME}"
}
WORKSPACE_DIR=$(get_workspace)

# Copy workspace (excluding .venv, .git, node_modules, __pycache__)
echo "Copying workspace: $WORKSPACE_DIR ..."
rsync -a --info=progress2 \
  --exclude='.venv' \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache' \
  "$WORKSPACE_DIR/" "$STAGING_DIR/workspace/"

# Copy ~/.amcp (full - identity, config, etc.)
echo "Copying ~/.amcp..."
rsync -a ~/.amcp/ "$STAGING_DIR/amcp/" --exclude='staging-*' --exclude='checkpoints'

# Copy ~/.openclaw essentials (config only, not media)
echo "Copying ~/.openclaw essentials..."
mkdir -p "$STAGING_DIR/openclaw"
cp ~/.openclaw/openclaw.json "$STAGING_DIR/openclaw/" 2>/dev/null || true
cp ~/.openclaw/auth-profiles.json "$STAGING_DIR/openclaw/" 2>/dev/null || true

# Calculate sizes
echo ""
echo "Staging directory contents:"
du -sh "$STAGING_DIR"/* 2>/dev/null | sort -h

TOTAL_SIZE=$(du -sh "$STAGING_DIR" | cut -f1)
echo ""
echo "Total staging size: $TOTAL_SIZE"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "=== DRY RUN COMPLETE ==="
  echo "Would checkpoint $SECRET_COUNT secrets and $TOTAL_SIZE of content"
  rm -rf "$STAGING_DIR"
  rm -f "$SECRETS_FILE"
  exit 0
fi

# ===========================================
# STAGE 3: Create checkpoint
# ===========================================
echo ""
echo "=== STAGE 3: Creating encrypted checkpoint ==="

# Notify start
if [ "$NOTIFY" = true ]; then
  "$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Starting FULL checkpoint ($TOTAL_SIZE, $SECRET_COUNT secrets)..."
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
CHECKPOINT_PATH="$CHECKPOINT_DIR/full-checkpoint-$TIMESTAMP.amcp"

AMCP_ARGS="checkpoint create --identity $IDENTITY_PATH --content $STAGING_DIR --secrets $SECRETS_FILE --out $CHECKPOINT_PATH"
[ -n "$PREVIOUS_CID" ] && AMCP_ARGS="$AMCP_ARGS --previous $PREVIOUS_CID"

echo "Running: $AMCP_CLI $AMCP_ARGS"
$AMCP_CLI $AMCP_ARGS

CHECKPOINT_SIZE=$(du -sh "$CHECKPOINT_PATH" | cut -f1)
echo "Checkpoint created: $CHECKPOINT_PATH ($CHECKPOINT_SIZE)"

# ===========================================
# STAGE 4: Pin to IPFS
# ===========================================
echo ""
echo "=== STAGE 4: Pinning to IPFS ==="

CID=""
if [ -n "$PINATA_JWT" ]; then
  echo "Uploading to Pinata..."
  
  RESPONSE=$(curl -s -X POST "https://api.pinata.cloud/pinning/pinFileToIPFS" \
    -H "Authorization: Bearer $PINATA_JWT" \
    -F "file=@$CHECKPOINT_PATH" \
    -F "pinataMetadata={\"name\":\"amcp-full-$AGENT_NAME-$TIMESTAMP\"}")
  
  CID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('IpfsHash',''))" 2>/dev/null || echo '')
  
  if [ -n "$CID" ]; then
    echo "✅ Pinned to IPFS!"
    echo "   CID: $CID"
    echo "   Gateway: https://gateway.pinata.cloud/ipfs/$CID"
  else
    echo "⚠️ Pinata error: $RESPONSE"
  fi
else
  echo "⚠️ No Pinata JWT configured"
fi

# ===========================================
# STAGE 5: Cleanup and record
# ===========================================
echo ""
echo "=== STAGE 5: Cleanup ==="

# Update last checkpoint file
cat > "$LAST_CHECKPOINT_FILE" << EOJSON
{
  "cid": "$CID",
  "localPath": "$CHECKPOINT_PATH",
  "timestamp": "$(date -Iseconds)",
  "previousCID": "$PREVIOUS_CID",
  "secretCount": $SECRET_COUNT,
  "contentSize": "$TOTAL_SIZE",
  "checkpointSize": "$CHECKPOINT_SIZE",
  "type": "full"
}
EOJSON

# Rotate old checkpoints
echo "Rotating old checkpoints (keep $KEEP_CHECKPOINTS)..."
ls -1t "$CHECKPOINT_DIR"/full-checkpoint-*.amcp 2>/dev/null | tail -n +$((KEEP_CHECKPOINTS + 1)) | while read -r f; do
  echo "Removing old: $f"
  rm -f "$f"
done

# Notify end
if [ "$NOTIFY" = true ]; then
  if [ -n "$CID" ]; then
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] FULL checkpoint complete!
📦 Size: $CHECKPOINT_SIZE ($TOTAL_SIZE content)
🔐 Secrets: $SECRET_COUNT
📍 CID: $CID
🔗 https://gateway.pinata.cloud/ipfs/$CID"
  else
    "$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] FULL checkpoint complete (local only)
📦 Size: $CHECKPOINT_SIZE
🔐 Secrets: $SECRET_COUNT"
  fi
fi

echo ""
echo "=============================================="
echo "  FULL CHECKPOINT COMPLETE"
echo "=============================================="
echo "CID: ${CID:-'(local only)'}"
echo "Path: $CHECKPOINT_PATH"
echo "Secrets: $SECRET_COUNT"
echo "Size: $CHECKPOINT_SIZE"
echo "=============================================="
