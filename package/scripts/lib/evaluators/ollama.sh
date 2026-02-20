#!/bin/bash
# ollama.sh — OllamaEvaluator adapter for AMCP memory evaluation
#
# Implements the MemoryEvaluator interface (PROTOCOL.md Layer 3) using
# a local Ollama instance for offline/privacy-sensitive evaluation.
#
# Required by evaluator.sh adapter pattern:
#   _adapter_evaluate <file_path> <content> <criteria_json>
#   _adapter_metadata
#
# Config (in ~/.amcp/config.json):
#   ollama.model  — Model name (default: llama3.2)
#   ollama.url    — Ollama API endpoint (default: http://localhost:11434)
#
# Evaluator-specific config (evaluators array):
#   evaluators[i].model   — Override model for this evaluator instance
#   evaluators[i].url     — Override API endpoint for this evaluator instance
#
# Environment:
#   OLLAMA_MODEL          Override model name
#   OLLAMA_API_URL        Override API endpoint
#   OLLAMA_TIMEOUT        Override request timeout in seconds (default: 120)

# Guard against double-source
[ -n "${_OLLAMA_ADAPTER_LOADED:-}" ] && return 0
_OLLAMA_ADAPTER_LOADED=1

_OLLAMA_DEFAULT_MODEL="llama3.2"
_OLLAMA_DEFAULT_URL="http://localhost:11434"
_OLLAMA_TIMEOUT="${OLLAMA_TIMEOUT:-120}"
_OLLAMA_MAX_RETRIES=1
_OLLAMA_RETRY_DELAY=2

# --- Internal helpers ---

# Resolve Ollama model from multiple sources
_ollama_get_model() {
  local model="${OLLAMA_MODEL:-}"
  [ -n "$model" ] && { echo "$model"; return 0; }

  # Try evaluator-specific config
  if type -t get_evaluator_config &>/dev/null; then
    model=$(get_evaluator_config "ollama" "model")
    [ -n "$model" ] && { echo "$model"; return 0; }
  fi

  # Try global ollama.model config
  if type -t eval_read_config &>/dev/null; then
    model=$(eval_read_config "ollama.model")
    [ -n "$model" ] && { echo "$model"; return 0; }
  fi

  echo "$_OLLAMA_DEFAULT_MODEL"
}

# Resolve Ollama API URL from multiple sources
_ollama_get_url() {
  local url="${OLLAMA_API_URL:-}"
  [ -n "$url" ] && { echo "$url"; return 0; }

  # Try evaluator-specific config
  if type -t get_evaluator_config &>/dev/null; then
    url=$(get_evaluator_config "ollama" "url")
    [ -n "$url" ] && { echo "$url"; return 0; }
  fi

  # Try global ollama.url config
  if type -t eval_read_config &>/dev/null; then
    url=$(eval_read_config "ollama.url")
    [ -n "$url" ] && { echo "$url"; return 0; }
  fi

  echo "$_OLLAMA_DEFAULT_URL"
}

# Check if Ollama is running and reachable
_ollama_check_health() {
  local base_url="$1"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$base_url" 2>/dev/null) || http_code="000"

  if [ "$http_code" = "200" ]; then
    return 0
  fi
  return 1
}

# Check if the requested model is available locally
_ollama_check_model() {
  local base_url="$1"
  local model="$2"

  local response
  response=$(curl -sf --max-time 10 "$base_url/api/tags" 2>/dev/null) || return 1

  python3 -c "
import json, sys
try:
    data = json.loads('''$response''')
    models = [m.get('name','') for m in data.get('models', [])]
    # Match model name with or without tag
    target = '$model'
    for m in models:
        if m == target or m.startswith(target + ':'):
            sys.exit(0)
    sys.exit(1)
except (json.JSONDecodeError, KeyError):
    sys.exit(1)
" 2>/dev/null
}

# Build the Ollama API request body
# Args: $1=file_path, $2=criteria_json, $3=model
# Content read from stdin
_ollama_build_request() {
  local file_path="$1"
  local criteria_json="$2"
  local model="$3"

  _EVAL_FILEPATH="$file_path" \
  _EVAL_MODEL="$model" \
  _EVAL_CRITERIA="$criteria_json" \
  python3 << 'PYEOF'
import json, sys, os

file_path = os.environ["_EVAL_FILEPATH"]
model = os.environ["_EVAL_MODEL"]
criteria_raw = os.environ["_EVAL_CRITERIA"]
content = sys.stdin.read()

filename = os.path.basename(file_path)

try:
    criteria = json.loads(criteria_raw)
except (json.JSONDecodeError, TypeError):
    criteria = {"agentIdentity": "general", "retentionGoals": ["technical_learning"]}

agent_identity = criteria.get("agentIdentity", "general")
retention_goals = ", ".join(criteria.get("retentionGoals", ["general"]))

prompt = f"""Evaluate this agent memory file for retention value.

Agent identity: {agent_identity}
Retention goals: {retention_goals}
File: {filename}

Scoring guide (0-100):
- 90-100: Core identity, critical failure lessons, user preferences
- 70-89: Architectural decisions, project context, key relationships
- 40-69: Routine task logs, status updates, session notes
- 10-39: Debug output, temporary scratch, stale context
- 0-9: Empty or completely irrelevant

You MUST respond with ONLY a valid JSON object. No other text, no markdown fences.

JSON format:
{{"score": <int 0-100>, "keep": <true|false>, "reason": "<brief explanation>", "confidence": <float 0.0-1.0>, "categories": ["<category>", ...], "suggestedTTL": <int days, -1 for permanent, 0 for archive now>}}

---
{content}"""

body = {
    "model": model,
    "messages": [
        {
            "role": "system",
            "content": "You are a memory importance evaluator for an AI agent. Score memories 0-100 for retention value. You MUST respond with ONLY valid JSON, no other text."
        },
        {"role": "user", "content": prompt}
    ],
    "stream": False,
    "format": "json",
    "options": {
        "temperature": 0.1,
        "num_predict": 256
    }
}

print(json.dumps(body))
PYEOF
}

# Call Ollama API with retry
# Args: $1=request_json_file, $2=base_url
# Returns: raw API response on stdout
_ollama_api_call() {
  local request_file="$1"
  local base_url="$2"
  local api_url="$base_url/api/chat"
  local attempt=0
  local response=""
  local http_code=""

  while [ $attempt -le $_OLLAMA_MAX_RETRIES ]; do
    local tmpout
    tmpout=$(mktemp)

    http_code=$(curl -s -w "%{http_code}" -o "$tmpout" \
      --max-time "$_OLLAMA_TIMEOUT" \
      -H "Content-Type: application/json" \
      -d "@$request_file" \
      "$api_url" 2>/dev/null) || http_code="000"

    response=$(cat "$tmpout" 2>/dev/null || true)
    rm -f "$tmpout"

    case "$http_code" in
      200) echo "$response"; return 0 ;;
      404)
        echo "ERROR: Ollama model not found. Pull it with: ollama pull <model>" >&2
        return 1
        ;;
      500|502|503)
        # Server error — retry
        attempt=$((attempt + 1))
        if [ $attempt -le $_OLLAMA_MAX_RETRIES ]; then
          echo "WARN: Ollama server error ($http_code), retrying (attempt $attempt/$_OLLAMA_MAX_RETRIES)" >&2
          sleep "$_OLLAMA_RETRY_DELAY"
        fi
        ;;
      000)
        echo "ERROR: Ollama not reachable at $base_url. Is Ollama running? Start with: ollama serve" >&2
        return 1
        ;;
      *)
        echo "ERROR: Ollama API returned HTTP $http_code" >&2
        return 1
        ;;
    esac
  done

  echo "ERROR: Ollama API failed after $_OLLAMA_MAX_RETRIES retries (last HTTP $http_code)" >&2
  return 1
}

# Parse Ollama API response into EvaluationResponse
# Reads raw API response from stdin, outputs EvaluationResponse JSON
_ollama_parse_response() {
  python3 << 'PYEOF'
import json, sys, re

try:
    resp = json.loads(sys.stdin.read())
except json.JSONDecodeError as e:
    print(json.dumps({
        "score": 50, "keep": True,
        "reason": f"Failed to parse Ollama response: {e}",
        "confidence": 0.0, "categories": ["error"], "suggestedTTL": 7
    }))
    sys.exit(0)

# Extract content from chat completion
try:
    content_str = resp.get("message", {}).get("content", "")
    if not content_str:
        raise ValueError("Empty response content")

    # Try to extract JSON from response — models may wrap in markdown fences
    json_match = re.search(r'\{[\s\S]*\}', content_str)
    if json_match:
        evaluation = json.loads(json_match.group(0))
    else:
        evaluation = json.loads(content_str)
except (KeyError, json.JSONDecodeError, ValueError) as e:
    print(json.dumps({
        "score": 50, "keep": True,
        "reason": f"Failed to extract evaluation from Ollama response: {e}",
        "confidence": 0.0, "categories": ["error"], "suggestedTTL": 7
    }))
    sys.exit(0)

# Validate and normalize fields per PROTOCOL.md EvaluationResponse
result = {}

# score: 0-100 integer
score = evaluation.get("score", 50)
if isinstance(score, float) and score <= 1.0:
    score = int(round(score * 100))
result["score"] = max(0, min(100, int(score)))

# keep: boolean
keep_val = evaluation.get("keep", True)
if isinstance(keep_val, str):
    result["keep"] = keep_val.lower() in ("true", "yes", "1")
else:
    result["keep"] = bool(keep_val)

# reason: string
result["reason"] = str(evaluation.get("reason", "No reason provided"))[:500]

# confidence: 0-1 float
conf = evaluation.get("confidence", 0.5)
try:
    result["confidence"] = max(0.0, min(1.0, float(conf)))
except (ValueError, TypeError):
    result["confidence"] = 0.5

# categories: string[]
cats = evaluation.get("categories", [])
if isinstance(cats, list):
    result["categories"] = [str(c) for c in cats[:10]]
elif isinstance(cats, str):
    result["categories"] = [cats]
else:
    result["categories"] = ["uncategorized"]

# suggestedTTL: integer (days, -1 for permanent, 0 for archive now)
ttl = evaluation.get("suggestedTTL", evaluation.get("suggested_ttl", 30))
try:
    result["suggestedTTL"] = int(ttl) if ttl is not None else 30
except (ValueError, TypeError):
    result["suggestedTTL"] = 30

print(json.dumps(result))
PYEOF
}

# --- Adapter interface implementation ---

# Evaluate a memory file using local Ollama
# Args: $1=file_path, $2=content (truncated), $3=criteria_json
# Returns: JSON EvaluationResponse on stdout
_adapter_evaluate() {
  local file_path="$1"
  local content="$2"
  local criteria_json="$3"

  # Get model and URL
  local model
  model=$(_ollama_get_model)
  local base_url
  base_url=$(_ollama_get_url)

  # Check if Ollama is running
  if ! _ollama_check_health "$base_url"; then
    echo "WARN: Ollama not running at $base_url — returning fallback score" >&2
    echo '{"score":50,"keep":true,"reason":"Ollama not running - defaulting to keep","confidence":0.0,"categories":["offline"],"suggestedTTL":7}'
    return 0
  fi

  # Build request JSON
  local request_json
  request_json=$(_ollama_build_request "$file_path" "$criteria_json" "$model" <<< "$content") || {
    echo '{"score":50,"keep":true,"reason":"Failed to build Ollama request","confidence":0.0,"categories":["error"],"suggestedTTL":7}'
    return 0
  }

  # Write request to temp file (safe for curl -d @file)
  local tmpfile
  tmpfile=$(mktemp)
  echo "$request_json" > "$tmpfile"

  # Call API with retry
  local raw_response
  raw_response=$(_ollama_api_call "$tmpfile" "$base_url")
  local api_exit=$?
  rm -f "$tmpfile"

  if [ $api_exit -ne 0 ]; then
    # Graceful fallback: keep the memory on error (don't lose data)
    echo '{"score":50,"keep":true,"reason":"Ollama API error - defaulting to keep","confidence":0.0,"categories":["error"],"suggestedTTL":7}'
    return 0
  fi

  # Parse response into EvaluationResponse
  echo "$raw_response" | _ollama_parse_response
}

# Return evaluator metadata
# Returns: JSON EvaluatorMetadata on stdout
_adapter_metadata() {
  local model
  model=$(_ollama_get_model)
  local base_url
  base_url=$(_ollama_get_url)

  # Check if Ollama is available (non-blocking)
  local status="offline"
  if _ollama_check_health "$base_url" 2>/dev/null; then
    status="online"
  fi

  python3 -c "
import json
print(json.dumps({
    'id': 'ollama',
    'name': 'OllamaEvaluator',
    'version': '1.0.0',
    'model': '$model',
    'capabilities': ['local_inference', 'offline', 'privacy'],
    'status': '$status',
    'endpoint': '$base_url'
}))
"
}
