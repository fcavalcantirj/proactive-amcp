#!/bin/bash
# full-checkpoint.sh - Create FULL AMCP checkpoint with ALL content and secrets
# Usage: ./full-checkpoint.sh [--dry-run] [--notify] [--force]

set -euo pipefail

command -v python3 &>/dev/null || { echo "FATAL: python3 required but not found" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AMCP_CLI="${AMCP_CLI:-$(command -v amcp 2>/dev/null || echo "$HOME/bin/amcp")}"
IDENTITY_PATH="${IDENTITY_PATH:-$HOME/.amcp/identity.json}"
CHECKPOINT_DIR="${CHECKPOINT_DIR:-$HOME/.amcp/checkpoints}"
STAGING_DIR="$HOME/.amcp/staging-$$"
LAST_CHECKPOINT_FILE="$HOME/.amcp/last-checkpoint.json"
SECRETS_FILE="$HOME/.amcp/secrets-full.json"
KEEP_CHECKPOINTS="${KEEP_CHECKPOINTS:-5}"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

DRY_RUN=false
NOTIFY=false
FORCE_CHECKPOINT=""
SKIP_EVOLUTION=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --notify) NOTIFY=true ;;
    --force)  FORCE_CHECKPOINT="force" ;;
    --skip-evolution) SKIP_EVOLUTION=true ;;
  esac
done

# Source secret scanner
source "$SCRIPT_DIR/scan-secrets.sh"

# Pinata config
PINATA_JWT="${PINATA_JWT:-$(python3 -c "import json; d=json.load(open('$HOME/.amcp/config.json')); print(d.get('pinata',{}).get('jwt',''))" 2>/dev/null || echo '')}"

# Pinning provider: 'pinata' (default) | 'solvr' | 'both'
PINNING_PROVIDER="${PINNING_PROVIDER:-$(python3 -c "import json; d=json.load(open('$HOME/.amcp/config.json')); print(d.get('pinning',{}).get('provider','pinata'))" 2>/dev/null || echo 'pinata')}"

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
# Compute ontology graph CID (if exists)
# ===========================================
ONTOLOGY_GRAPH_CID=""

compute_ontology_cid() {
  local graph_path="$CONTENT_DIR/memory/ontology/graph.jsonl"
  if [ ! -f "$graph_path" ]; then
    return 0
  fi

  ONTOLOGY_GRAPH_CID=$(python3 -c "
import hashlib, base64, sys, os

graph_path = os.path.expanduser('$graph_path')
with open(graph_path, 'rb') as f:
    content = f.read()

# SHA-256 digest
digest = hashlib.sha256(content).digest()

# CIDv1 raw format: version(1) + codec(raw=0x55) + multihash(sha256=0x12, len=0x20, digest)
# Then base32lower encode with 'b' multibase prefix
cid_bytes = bytes([0x01, 0x55, 0x12, 0x20]) + digest
cid_b32 = base64.b32encode(cid_bytes).decode('ascii').lower().rstrip('=')
print('b' + cid_b32)
" 2>/dev/null || echo '')

  if [ -n "$ONTOLOGY_GRAPH_CID" ]; then
    echo "Ontology graph CID: $ONTOLOGY_GRAPH_CID"
  fi
}

compute_ontology_cid

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

# Extract redacted config metadata (structural info only, no secrets)
extract_config_metadata() {
  mkdir -p "$STAGING_DIR/openclaw"
  local oc_config="$HOME/.openclaw/openclaw.json"
  if [ ! -f "$oc_config" ]; then
    echo "  No openclaw.json found, skipping config-metadata"
    return 0
  fi

  STAGING_DIR="$STAGING_DIR" python3 << 'PYEOF'
import json, os, re

oc_path = os.path.expanduser("~/.openclaw/openclaw.json")
staging_dir = os.environ["STAGING_DIR"]

with open(oc_path) as f:
    data = json.load(f)

# Patterns that identify secret values
SECRET_PATTERNS = [
    r'eyJ[a-zA-Z0-9_-]*\.eyJ',  # JWT
    r'sk-[a-zA-Z0-9]{20,}',     # API keys
    r'ghp_[a-zA-Z0-9]{30,}',    # GitHub PAT
    r'solvr_[a-zA-Z0-9_-]{20,}', # Solvr key
    r'am_[a-zA-Z0-9]{40,}',     # AgentMail key
    r'[0-9]{8,10}:AA[a-zA-Z0-9_-]{33,}',  # Telegram bot token
    r'AKIA[0-9A-Z]{16}',        # AWS key
]

SECRET_KEY_NAMES = {
    'apikey', 'api_key', 'apiKey', 'secret', 'password',
    'jwt', 'token', 'botToken', 'bot_token', 'mnemonic',
    'keyringPassword', 'key', 'private_key', 'privateKey',
}

def is_secret_key(key_name):
    return key_name.lower().replace('-', '').replace('_', '') in {
        k.lower().replace('-', '').replace('_', '') for k in SECRET_KEY_NAMES
    }

def is_secret_value(val):
    if not isinstance(val, str):
        return False
    for pat in SECRET_PATTERNS:
        if re.search(pat, val):
            return True
    return False

def redact(obj, key_name=""):
    if isinstance(obj, dict):
        return {k: redact(v, k) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [redact(v, key_name) for v in obj]
    elif isinstance(obj, str):
        if is_secret_key(key_name) or is_secret_value(obj):
            return "[REDACTED]"
        return obj
    return obj

metadata = redact(data)
out_path = os.path.join(staging_dir, "openclaw", "config-metadata.json")
with open(out_path, "w") as f:
    json.dump(metadata, f, indent=2)
    f.write("\n")
PYEOF
  echo "  Created openclaw/config-metadata.json"
}

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

# Copy ~/.amcp — identity ONLY (secrets are handled via extract_all_secrets)
echo "Copying ~/.amcp/identity.json..."
mkdir -p "$STAGING_DIR/amcp"
cp "$IDENTITY_PATH" "$STAGING_DIR/amcp/identity.json" 2>/dev/null || true

# Extract redacted config metadata from openclaw.json (structural info, no secrets)
echo "Extracting config metadata..."
extract_config_metadata

# Log included optional directories
if [ -d "$STAGING_DIR/workspace/memory/ontology" ]; then
  echo "  Included ontology graph ($(find "$STAGING_DIR/workspace/memory/ontology" -name '*.jsonl' 2>/dev/null | wc -l) JSONL files)"
fi
if [ -d "$STAGING_DIR/workspace/memory/learning" ]; then
  echo "  Included learning storage (problems + learnings)"
fi

# Run memory evolution engine (if graph exists and not skipped)
if [ "$SKIP_EVOLUTION" = false ] && [ -f "$CONTENT_DIR/memory/ontology/graph.jsonl" ] && [ -x "$SCRIPT_DIR/memory-evolution.sh" ]; then
  echo ""
  echo "Running memory evolution engine..."
  if [ "$DRY_RUN" = true ]; then
    "$SCRIPT_DIR/memory-evolution.sh" --all-new --graph "$CONTENT_DIR/memory/ontology/graph.jsonl" --dry-run || true
  else
    "$SCRIPT_DIR/memory-evolution.sh" --all-new --graph "$CONTENT_DIR/memory/ontology/graph.jsonl" || true
  fi
elif [ "$SKIP_EVOLUTION" = true ]; then
  echo "  Skipping memory evolution (--skip-evolution)"
fi

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

# Pre-validation: scan staged content for cleartext secrets
echo ""
echo "=== PRE-VALIDATION: Scanning for cleartext secrets ==="
scan_for_secrets "$STAGING_DIR" "$FORCE_CHECKPOINT"

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
echo "=== STAGE 4: Pinning to IPFS (provider: $PINNING_PROVIDER) ==="

CID=""
PINATA_CID=""
SOLVR_CID=""

# Pin to Pinata
pin_to_pinata() {
  if [ -z "$PINATA_JWT" ]; then
    echo "⚠️ No Pinata JWT configured"
    return 1
  fi
  echo "Uploading to Pinata..."
  local response
  response=$(curl -s -X POST "https://api.pinata.cloud/pinning/pinFileToIPFS" \
    -H "Authorization: Bearer $PINATA_JWT" \
    -F "file=@$CHECKPOINT_PATH" \
    -F "pinataMetadata={\"name\":\"amcp-full-$AGENT_NAME-$TIMESTAMP\"}")
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
    echo "Uploading to Solvr..."
    local solvr_output
    solvr_output=$("$SCRIPT_DIR/pin-to-solvr.sh" "$CHECKPOINT_PATH" "amcp-full-$AGENT_NAME-$TIMESTAMP") || {
      echo "⚠️ Solvr pin failed"
      SOLVR_CID=""
      return 1
    }
    SOLVR_CID="$solvr_output"
    echo "  Solvr: $SOLVR_CID"
    return 0
  else
    echo "⚠️ pin-to-solvr.sh not found at $SCRIPT_DIR/pin-to-solvr.sh"
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
    # Prefer Pinata CID (established), fall back to Solvr
    CID="${PINATA_CID:-$SOLVR_CID}"
    if [ -z "$PINATA_CID" ] && [ -z "$SOLVR_CID" ]; then
      echo "⚠️ Both pinning providers failed"
    elif [ -n "$PINATA_CID" ] && [ -n "$SOLVR_CID" ] && [ "$PINATA_CID" != "$SOLVR_CID" ]; then
      echo "⚠️ CID mismatch: Pinata=$PINATA_CID Solvr=$SOLVR_CID (same content should produce same CID)"
    fi
    ;;
  pinata|*)
    pin_to_pinata
    CID="$PINATA_CID"
    ;;
esac

if [ -n "$CID" ]; then
  echo "✅ Pinned to IPFS!"
  echo "   CID: $CID"
fi

# ===========================================
# STAGE 5: Cleanup and record
# ===========================================
echo ""
echo "=== STAGE 5: Cleanup ==="

# Update last checkpoint file
python3 -c "
import json
data = {
    'cid': '''$CID''',
    'localPath': '''$CHECKPOINT_PATH''',
    'timestamp': '$(date -Iseconds)',
    'previousCID': '''$PREVIOUS_CID''',
    'secretCount': $SECRET_COUNT,
    'contentSize': '''$TOTAL_SIZE''',
    'checkpointSize': '''$CHECKPOINT_SIZE''',
    'type': 'full',
    'pinningProvider': '''$PINNING_PROVIDER'''
}
pinata_cid = '''$PINATA_CID'''
solvr_cid = '''$SOLVR_CID'''
if pinata_cid:
    data['pinataCid'] = pinata_cid
if solvr_cid:
    data['solvrCid'] = solvr_cid
ontology_cid = '''$ONTOLOGY_GRAPH_CID'''
if ontology_cid:
    data['ontologyGraphCID'] = ontology_cid
with open('$LAST_CHECKPOINT_FILE', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"

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
📍 CID: $CID (provider: $PINNING_PROVIDER)"
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
