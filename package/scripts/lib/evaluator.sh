#!/bin/bash
# evaluator.sh — Base evaluator and adapter pattern for AMCP memory evaluation
#
# Implements the MemoryEvaluator interface from PROTOCOL.md (Layer 3).
# Adapters in scripts/lib/evaluators/ implement the actual evaluation logic.
#
# Usage (sourced by other scripts):
#   source "$SCRIPT_DIR/lib/evaluator.sh"
#   load_evaluator "groq"   # or "ollama", etc.
#   result=$(evaluate_memory "$file_path" "$content" "$criteria_json")
#   metadata=$(get_evaluator_metadata)
#
# Environment:
#   CONFIG_FILE   Override config path (default: ~/.amcp/config.json)
#   EVALUATOR_TYPE  Override evaluator type (default: from config or "groq")

# Guard against double-source
[ -n "${_EVALUATOR_BASE_LOADED:-}" ] && return 0
_EVALUATOR_BASE_LOADED=1

_EVAL_LIB_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)/lib"

# --- Config helpers (reusable) ---

_eval_config_file="${CONFIG_FILE:-$HOME/.amcp/config.json}"

# Read a dot-path key from config.json
eval_read_config() {
  local key="$1"
  local cfg_path="$_eval_config_file"
  python3 -c "
import json, os, functools, operator
try:
    with open(os.path.expanduser('$cfg_path')) as f:
        cfg = json.load(f)
    keys = '$key'.split('.')
    val = functools.reduce(operator.getitem, keys, cfg)
    if isinstance(val, (dict, list)):
        import json as j
        print(j.dumps(val))
    else:
        print(val)
except (KeyError, TypeError, IOError, json.JSONDecodeError):
    pass
" 2>/dev/null || true
}

# --- Adapter registry ---

# Currently loaded adapter type
_CURRENT_EVALUATOR_TYPE=""

# Adapter function pointers (set by adapter on load)
# Each adapter defines these functions:
#   _adapter_evaluate <file_path> <content_truncated> <criteria_json>
#     Returns: JSON EvaluationResponse per PROTOCOL.md
#   _adapter_metadata
#     Returns: JSON EvaluatorMetadata per PROTOCOL.md

# Resolve evaluator type from config or environment
_resolve_evaluator_type() {
  local eval_type="${EVALUATOR_TYPE:-}"
  if [ -n "$eval_type" ]; then
    echo "$eval_type"
    return
  fi

  # Check config: evaluators[0].type (first configured evaluator)
  eval_type=$(python3 -c "
import json, os
try:
    with open(os.path.expanduser('$_eval_config_file')) as f:
        cfg = json.load(f)
    evaluators = cfg.get('evaluators', [])
    if evaluators and isinstance(evaluators, list):
        print(evaluators[0].get('type', 'groq'))
    else:
        # Fallback: check if groq.apiKey exists
        if cfg.get('groq', {}).get('apiKey'):
            print('groq')
        else:
            print('groq')
except (IOError, json.JSONDecodeError, KeyError, TypeError):
    print('groq')
" 2>/dev/null || echo "groq")

  echo "$eval_type"
}

# Load an evaluator adapter by type
# Usage: load_evaluator "groq" or load_evaluator "ollama"
load_evaluator() {
  local eval_type="${1:-}"

  if [ -z "$eval_type" ]; then
    eval_type=$(_resolve_evaluator_type)
  fi

  local adapter_path="$_EVAL_LIB_DIR/evaluators/${eval_type}.sh"

  if [ ! -f "$adapter_path" ]; then
    echo "ERROR: No evaluator adapter found at $adapter_path" >&2
    echo "Available adapters:" >&2
    for f in "$_EVAL_LIB_DIR"/evaluators/*.sh; do
      [ -f "$f" ] && echo "  - $(basename "${f%.sh}")" >&2
    done
    return 1
  fi

  # shellcheck source=/dev/null
  source "$adapter_path"

  # Verify adapter implements required functions
  if ! type -t _adapter_evaluate &>/dev/null; then
    echo "ERROR: Adapter '$eval_type' does not implement _adapter_evaluate()" >&2
    return 1
  fi
  if ! type -t _adapter_metadata &>/dev/null; then
    echo "ERROR: Adapter '$eval_type' does not implement _adapter_metadata()" >&2
    return 1
  fi

  _CURRENT_EVALUATOR_TYPE="$eval_type"
  return 0
}

# --- Public API (MemoryEvaluator interface) ---

# Evaluate a memory file for retention value
# Args:
#   $1 - file_path: path to the memory file
#   $2 - criteria_json (optional): JSON string with agentIdentity, retentionGoals, maxAge
#        Defaults to generic criteria if not provided
#
# Returns: JSON EvaluationResponse on stdout
#   { score, keep, reason, confidence, categories, suggestedTTL }
#
# Exit code: 0 on success, 1 on error
evaluate_memory() {
  local file_path="$1"
  local criteria_json="${2:-}"

  if [ -z "$_CURRENT_EVALUATOR_TYPE" ]; then
    load_evaluator || return 1
  fi

  if [ ! -f "$file_path" ]; then
    echo "ERROR: File not found: $file_path" >&2
    return 1
  fi

  # Build default criteria if not provided
  if [ -z "$criteria_json" ]; then
    criteria_json='{"agentIdentity":"general","retentionGoals":["technical_learning","identity","relationship_context"]}'
  fi

  # Read and truncate content (8000 chars max for API efficiency)
  local content
  content=$(head -c 8000 "$file_path" 2>/dev/null || true)

  if [ -z "$content" ]; then
    # Empty file — return low score without calling API
    python3 -c "
import json
print(json.dumps({
    'score': 0,
    'keep': False,
    'reason': 'Empty file',
    'confidence': 1.0,
    'categories': ['empty'],
    'suggestedTTL': 0
}))
"
    return 0
  fi

  # Delegate to adapter
  _adapter_evaluate "$file_path" "$content" "$criteria_json"
}

# Get metadata for the currently loaded evaluator
# Returns: JSON EvaluatorMetadata on stdout
#   { id, name, version, model, capabilities }
get_evaluator_metadata() {
  if [ -z "$_CURRENT_EVALUATOR_TYPE" ]; then
    load_evaluator || return 1
  fi

  _adapter_metadata
}

# List available evaluator adapter types
list_evaluator_types() {
  local -a types=()
  for f in "$_EVAL_LIB_DIR"/evaluators/*.sh; do
    [ -f "$f" ] && types+=("$(basename "${f%.sh}")")
  done
  printf '%s\n' "${types[@]}"
}

# Get the currently loaded evaluator type
current_evaluator_type() {
  echo "${_CURRENT_EVALUATOR_TYPE:-none}"
}

# --- Evaluator configuration helpers ---

# Read evaluator-specific config from the evaluators array
# Usage: get_evaluator_config "groq" "model"
get_evaluator_config() {
  local eval_type="$1"
  local key="$2"
  python3 -c "
import json, os
try:
    with open(os.path.expanduser('$_eval_config_file')) as f:
        cfg = json.load(f)
    for ev in cfg.get('evaluators', []):
        if ev.get('type') == '$eval_type':
            val = ev.get('$key', '')
            if isinstance(val, (dict, list)):
                print(json.dumps(val))
            else:
                print(val)
            break
except (IOError, json.JSONDecodeError, KeyError, TypeError):
    pass
" 2>/dev/null || true
}

# Build an EvaluationRequest JSON for an adapter
# Args: $1=file_path, $2=content, $3=criteria_json
# Returns: JSON EvaluationRequest on stdout
build_evaluation_request() {
  local file_path="$1"
  local content="$2"
  local criteria_json="$3"

  python3 << PYEOF
import json, os, sys
from datetime import datetime, timezone

file_path = "$file_path"
try:
    mtime = os.path.getmtime(file_path)
    timestamp = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
except OSError:
    timestamp = datetime.now(timezone.utc).isoformat()

content = sys.stdin.read()
criteria = json.loads('''$criteria_json''')

request = {
    "memory": {
        "content": content,
        "path": file_path,
        "timestamp": timestamp
    },
    "criteria": criteria
}
print(json.dumps(request))
PYEOF
  <<< "$content"
}

# Validate an EvaluationResponse JSON
# Returns 0 if valid, 1 if invalid (prints errors to stderr)
validate_evaluation_response() {
  local response_json="$1"
  python3 -c "
import json, sys

try:
    r = json.loads('''$response_json''')
except json.JSONDecodeError as e:
    print(f'Invalid JSON: {e}', file=sys.stderr)
    sys.exit(1)

errors = []
if 'score' not in r:
    errors.append('missing score')
elif not isinstance(r['score'], (int, float)):
    errors.append('score must be a number')
elif r['score'] < 0 or r['score'] > 100:
    errors.append('score must be 0-100')

if 'keep' not in r:
    errors.append('missing keep')
elif not isinstance(r['keep'], bool):
    errors.append('keep must be boolean')

if 'reason' not in r:
    errors.append('missing reason')
elif not isinstance(r['reason'], str):
    errors.append('reason must be string')

if 'confidence' not in r:
    errors.append('missing confidence')
elif not isinstance(r['confidence'], (int, float)):
    errors.append('confidence must be a number')

if 'categories' not in r:
    errors.append('missing categories')
elif not isinstance(r['categories'], list):
    errors.append('categories must be array')

if errors:
    for e in errors:
        print(f'EvaluationResponse validation: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1
}

# Normalize a 0-1 score to 0-100 (PROTOCOL.md uses 0-100)
# Some adapters may return 0-1 (like existing Groq code); this normalizes
normalize_score() {
  local score="$1"
  python3 -c "
s = float('$score')
if s <= 1.0 and s >= 0.0:
    # Looks like 0-1 scale, convert to 0-100
    if s < 1.01:
        print(int(round(s * 100)))
    else:
        print(int(round(s)))
else:
    print(int(round(min(100, max(0, s)))))
"
}
