#!/bin/bash
# groq.sh — GroqEvaluator adapter for AMCP memory evaluation
#
# Implements the MemoryEvaluator interface (PROTOCOL.md Layer 3) using
# Groq's API with GPT-OSS-20B and strict JSON schema output.
#
# Required by evaluator.sh adapter pattern:
#   _adapter_evaluate <file_path> <content> <criteria_json>
#   _adapter_metadata
#
# Config (in ~/.amcp/config.json):
#   groq.apiKey   — Groq API key (or GROQ_API_KEY env)
#   groq.model    — Model name (default: openai/gpt-oss-20b)
#
# Evaluator-specific config (evaluators array):
#   evaluators[i].model   — Override model for this evaluator instance
#   evaluators[i].apiKey  — Override API key for this evaluator instance
#
# Environment:
#   GROQ_API_KEY          Override Groq API key
#   GROQ_API_URL          Override API endpoint (default: https://api.groq.com/openai/v1/chat/completions)
#   GROQ_USAGE_FILE       Override usage tracking file (default: ~/.amcp/groq-usage.json)

# Guard against double-source
[ -n "${_GROQ_ADAPTER_LOADED:-}" ] && return 0
_GROQ_ADAPTER_LOADED=1

_GROQ_API_URL="${GROQ_API_URL:-https://api.groq.com/openai/v1/chat/completions}"
_GROQ_USAGE_FILE="${GROQ_USAGE_FILE:-$HOME/.amcp/groq-usage.json}"
_GROQ_DEFAULT_MODEL="openai/gpt-oss-20b"
_GROQ_MAX_RETRIES=2
_GROQ_RETRY_DELAY=2

# --- Internal helpers ---

# Resolve Groq API key from multiple sources
_groq_get_api_key() {
  local key="${GROQ_API_KEY:-}"
  [ -n "$key" ] && { echo "$key"; return 0; }

  # Try evaluator-specific config
  if type -t get_evaluator_config &>/dev/null; then
    key=$(get_evaluator_config "groq" "apiKey")
    [ -n "$key" ] && { echo "$key"; return 0; }
  fi

  # Try global groq config
  if type -t eval_read_config &>/dev/null; then
    key=$(eval_read_config "groq.apiKey")
    [ -n "$key" ] && { echo "$key"; return 0; }
  fi

  echo "ERROR: No Groq API key found. Set GROQ_API_KEY env, groq.apiKey in config, or evaluators[].apiKey" >&2
  return 1
}

# Resolve model from evaluator config or global config
_groq_get_model() {
  local model=""

  # Try evaluator-specific config
  if type -t get_evaluator_config &>/dev/null; then
    model=$(get_evaluator_config "groq" "model")
  fi

  # Try global groq.model
  if [ -z "$model" ] && type -t eval_read_config &>/dev/null; then
    model=$(eval_read_config "groq.model")
  fi

  echo "${model:-$_GROQ_DEFAULT_MODEL}"
}

# Track token usage in groq-usage.json
_groq_track_usage() {
  local prompt_tokens="$1"
  local completion_tokens="$2"
  local total_tokens="$3"
  local model="$4"

  python3 << PYEOF 2>/dev/null || true
import json, os
from datetime import datetime, timezone

usage_file = os.path.expanduser("$_GROQ_USAGE_FILE")
os.makedirs(os.path.dirname(usage_file), exist_ok=True)

try:
    with open(usage_file) as f:
        usage = json.load(f)
except (IOError, json.JSONDecodeError):
    usage = {"total_prompt_tokens": 0, "total_completion_tokens": 0, "total_tokens": 0, "evaluations": 0, "sessions": []}

usage["total_prompt_tokens"] += $prompt_tokens
usage["total_completion_tokens"] += $completion_tokens
usage["total_tokens"] += $total_tokens
usage["evaluations"] += 1
usage["last_model"] = "$model"
usage["last_used"] = datetime.now(timezone.utc).isoformat()

usage["sessions"] = usage.get("sessions", [])[-49:] + [{
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "prompt_tokens": $prompt_tokens,
    "completion_tokens": $completion_tokens,
    "total_tokens": $total_tokens,
    "model": "$model",
    "source": "evaluator-groq"
}]

with open(usage_file, "w") as f:
    json.dump(usage, f, indent=2)
PYEOF
}

# Build the Groq API request body as JSON
# Args: $1=file_path, $2=content (stdin), $3=criteria_json, $4=model
_groq_build_request() {
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

Consider:
- How relevant is this to the agent's identity and goals?
- Would losing this hurt the agent's ability to function?
- Is this a lesson learned from failure (high value)?
- Is this routine/ephemeral (low value)?

---
{content}"""

body = {
    "model": model,
    "messages": [
        {
            "role": "system",
            "content": "You are a memory importance evaluator for an AI agent. Score memories 0-100 for retention value. Be precise and justify your score."
        },
        {"role": "user", "content": prompt}
    ],
    "temperature": 0.1,
    "response_format": {
        "type": "json_schema",
        "json_schema": {
            "name": "evaluation_response",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "score": {
                        "type": "integer",
                        "description": "Retention value 0-100"
                    },
                    "keep": {
                        "type": "boolean",
                        "description": "Whether to keep this memory"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Brief explanation of the score"
                    },
                    "confidence": {
                        "type": "number",
                        "description": "Evaluator confidence 0.0-1.0"
                    },
                    "categories": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Memory categories (e.g., identity, lesson, decision, routine, debug)"
                    },
                    "suggestedTTL": {
                        "type": "integer",
                        "description": "Suggested days to keep before re-evaluation, 0 for archive now, -1 for permanent"
                    }
                },
                "required": ["score", "keep", "reason", "confidence", "categories", "suggestedTTL"],
                "additionalProperties": False
            }
        }
    }
}

print(json.dumps(body))
PYEOF
}

# Call Groq API with retry on rate limits (429)
# Args: $1=request_json_file, $2=api_key
# Returns: raw API response on stdout
_groq_api_call() {
  local request_file="$1"
  local api_key="$2"
  local attempt=0
  local response=""
  local http_code=""

  while [ $attempt -le $_GROQ_MAX_RETRIES ]; do
    # Use -w to capture HTTP code separately
    local tmpout
    tmpout=$(mktemp)

    http_code=$(curl -s -w "%{http_code}" -o "$tmpout" \
      --max-time 60 \
      -H "Authorization: Bearer $api_key" \
      -H "Content-Type: application/json" \
      -d "@$request_file" \
      "$_GROQ_API_URL" 2>/dev/null) || http_code="000"

    response=$(cat "$tmpout" 2>/dev/null || true)
    rm -f "$tmpout"

    case "$http_code" in
      200) echo "$response"; return 0 ;;
      429)
        # Rate limited — retry with backoff
        attempt=$((attempt + 1))
        if [ $attempt -le $_GROQ_MAX_RETRIES ]; then
          local delay=$(( _GROQ_RETRY_DELAY * attempt ))
          echo "WARN: Groq rate limited (429), retrying in ${delay}s (attempt $attempt/$_GROQ_MAX_RETRIES)" >&2
          sleep "$delay"
        fi
        ;;
      401|403)
        echo "ERROR: Groq authentication failed (HTTP $http_code). Check API key." >&2
        return 1
        ;;
      500|502|503)
        # Server error — retry
        attempt=$((attempt + 1))
        if [ $attempt -le $_GROQ_MAX_RETRIES ]; then
          echo "WARN: Groq server error ($http_code), retrying (attempt $attempt/$_GROQ_MAX_RETRIES)" >&2
          sleep "$_GROQ_RETRY_DELAY"
        fi
        ;;
      000)
        echo "ERROR: Groq API unreachable (network error or timeout)" >&2
        return 1
        ;;
      *)
        echo "ERROR: Groq API returned HTTP $http_code" >&2
        return 1
        ;;
    esac
  done

  echo "ERROR: Groq API failed after $_GROQ_MAX_RETRIES retries (last HTTP $http_code)" >&2
  return 1
}

# Parse Groq API response into EvaluationResponse
# Reads raw API response from stdin, outputs EvaluationResponse JSON
_groq_parse_response() {
  python3 << 'PYEOF'
import json, sys

try:
    resp = json.loads(sys.stdin.read())
except json.JSONDecodeError as e:
    print(json.dumps({
        "score": 50, "keep": True,
        "reason": f"Failed to parse Groq response: {e}",
        "confidence": 0.0, "categories": ["error"], "suggestedTTL": 7
    }))
    sys.exit(0)

# Extract content from chat completion
try:
    content_str = resp["choices"][0]["message"]["content"]
    evaluation = json.loads(content_str)
except (KeyError, IndexError, json.JSONDecodeError) as e:
    print(json.dumps({
        "score": 50, "keep": True,
        "reason": f"Failed to extract evaluation from Groq response: {e}",
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
result["keep"] = bool(evaluation.get("keep", True))

# reason: string
result["reason"] = str(evaluation.get("reason", "No reason provided"))

# confidence: 0-1 float
conf = evaluation.get("confidence", 0.5)
result["confidence"] = max(0.0, min(1.0, float(conf)))

# categories: string[]
cats = evaluation.get("categories", [])
if isinstance(cats, list):
    result["categories"] = [str(c) for c in cats]
else:
    result["categories"] = ["uncategorized"]

# suggestedTTL: integer (days, -1 for permanent, 0 for archive now)
ttl = evaluation.get("suggestedTTL", 30)
result["suggestedTTL"] = int(ttl) if ttl is not None else 30

# Extract usage for tracking (internal, not part of EvaluationResponse)
usage = resp.get("usage", {})
result["_usage"] = {
    "prompt_tokens": usage.get("prompt_tokens", 0),
    "completion_tokens": usage.get("completion_tokens", 0),
    "total_tokens": usage.get("total_tokens", 0)
}

print(json.dumps(result))
PYEOF
}

# --- Adapter interface implementation ---

# Evaluate a memory file using Groq
# Args: $1=file_path, $2=content (truncated), $3=criteria_json
# Returns: JSON EvaluationResponse on stdout
_adapter_evaluate() {
  local file_path="$1"
  local content="$2"
  local criteria_json="$3"

  # Get API key and model
  local api_key
  api_key=$(_groq_get_api_key) || return 1
  local model
  model=$(_groq_get_model)

  # Build request JSON
  local request_json
  request_json=$(_groq_build_request "$file_path" "$criteria_json" "$model" <<< "$content") || {
    echo '{"score":50,"keep":true,"reason":"Failed to build Groq request","confidence":0.0,"categories":["error"],"suggestedTTL":7}'
    return 0
  }

  # Write request to temp file (safe for curl -d @file)
  local tmpfile
  tmpfile=$(mktemp)
  echo "$request_json" > "$tmpfile"

  # Call API with retry
  local raw_response
  raw_response=$(_groq_api_call "$tmpfile" "$api_key")
  local api_exit=$?
  rm -f "$tmpfile"

  if [ $api_exit -ne 0 ]; then
    # Graceful fallback: keep the memory on error (don't lose data)
    echo '{"score":50,"keep":true,"reason":"Groq API error - defaulting to keep","confidence":0.0,"categories":["error"],"suggestedTTL":7}'
    return 0
  fi

  # Parse response into EvaluationResponse
  local result
  result=$(echo "$raw_response" | _groq_parse_response)

  # Track token usage (non-blocking)
  local prompt_tokens completion_tokens total_tokens
  prompt_tokens=$(python3 -c "import json; print(json.loads('$result').get('_usage',{}).get('prompt_tokens',0))" 2>/dev/null || echo 0)
  completion_tokens=$(python3 -c "import json; print(json.loads('$result').get('_usage',{}).get('completion_tokens',0))" 2>/dev/null || echo 0)
  total_tokens=$(python3 -c "import json; print(json.loads('$result').get('_usage',{}).get('total_tokens',0))" 2>/dev/null || echo 0)
  _groq_track_usage "$prompt_tokens" "$completion_tokens" "$total_tokens" "$model"

  # Strip internal _usage field from output (not part of EvaluationResponse)
  python3 -c "
import json, sys
r = json.loads(sys.stdin.read())
r.pop('_usage', None)
print(json.dumps(r))
" <<< "$result"
}

# Return evaluator metadata
# Returns: JSON EvaluatorMetadata on stdout
_adapter_metadata() {
  local model
  model=$(_groq_get_model)

  python3 -c "
import json
print(json.dumps({
    'id': 'groq',
    'name': 'GroqEvaluator',
    'version': '1.0.0',
    'model': '$model',
    'capabilities': ['structured_output', 'reasoning', 'fast_inference']
}))
"
}
