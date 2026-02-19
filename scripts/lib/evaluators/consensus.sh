#!/bin/bash
# consensus.sh — ConsensusEvaluator adapter for AMCP memory evaluation
#
# Orchestrates multiple evaluator judges and combines their results using
# configurable consensus strategies per PROTOCOL.md Section 6.2.
#
# This adapter is special: it loads OTHER adapters (groq, ollama, etc.)
# and combines their results rather than calling an external API directly.
#
# Required by evaluator.sh adapter pattern:
#   _adapter_evaluate <file_path> <content> <criteria_json>
#   _adapter_metadata
#
# Config (in ~/.amcp/config.json):
#   evaluators[]          — Array of evaluator configs (type, model, weight, apiKey)
#   consensus.strategy    — weighted_average | majority | unanimous | quorum (default: weighted_average)
#   consensus.minJudges   — Minimum evaluators required (default: 2)
#   consensus.quorumThreshold — For quorum strategy (0-1, default: 0.66)
#   consensus.tieBreaker  — keep | discard | escalate (default: keep)
#   consensus.disagreementThreshold — Variance that triggers escalation (0-1, default: 0.3)
#
# Environment:
#   CONSENSUS_STRATEGY    Override consensus strategy
#   CONSENSUS_MIN_JUDGES  Override minimum judges required

# Guard against double-source
[ -n "${_CONSENSUS_ADAPTER_LOADED:-}" ] && return 0
_CONSENSUS_ADAPTER_LOADED=1

# Locate evaluator lib dir (parent of evaluators/)
_CONSENSUS_LIB_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)/lib"
_CONSENSUS_CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"

# --- Config helpers ---

# Read consensus config value
_consensus_read_config() {
  local key="$1"
  local default="$2"
  local val=""
  if type -t eval_read_config &>/dev/null; then
    val=$(eval_read_config "consensus.$key")
  fi
  echo "${val:-$default}"
}

# Get list of configured evaluators as JSON array
_consensus_get_evaluators() {
  python3 -c "
import json, os
try:
    with open(os.path.expanduser('$_CONSENSUS_CONFIG_FILE')) as f:
        cfg = json.load(f)
    evaluators = cfg.get('evaluators', [])
    if isinstance(evaluators, list) and len(evaluators) > 0:
        print(json.dumps(evaluators))
    else:
        print('[]')
except (IOError, json.JSONDecodeError, KeyError, TypeError):
    print('[]')
" 2>/dev/null || echo "[]"
}

# Get evaluator count
_consensus_evaluator_count() {
  local evaluators_json="$1"
  python3 -c "
import json
evaluators = json.loads('$evaluators_json')
print(len(evaluators))
" 2>/dev/null || echo "0"
}

# Get evaluator type at index
_consensus_evaluator_type_at() {
  local evaluators_json="$1"
  local index="$2"
  python3 -c "
import json
evaluators = json.loads('''$evaluators_json''')
if $index < len(evaluators):
    print(evaluators[$index].get('type', 'groq'))
else:
    print('')
" 2>/dev/null || echo ""
}

# Get evaluator weight at index (default 1.0)
_consensus_evaluator_weight_at() {
  local evaluators_json="$1"
  local index="$2"
  python3 -c "
import json
evaluators = json.loads('''$evaluators_json''')
if $index < len(evaluators):
    print(evaluators[$index].get('weight', 1.0))
else:
    print('1.0')
" 2>/dev/null || echo "1.0"
}

# --- Evaluator invocation ---

# Run a single evaluator adapter and capture its result
# Args: $1=evaluator_type, $2=file_path, $3=content, $4=criteria_json, $5=index
# Returns: JSON EvaluationResponse on stdout
_consensus_run_evaluator() {
  local eval_type="$1"
  local file_path="$2"
  local content="$3"
  local criteria_json="$4"
  local eval_index="$5"

  local adapter_path="$_CONSENSUS_LIB_DIR/evaluators/${eval_type}.sh"

  if [ ! -f "$adapter_path" ]; then
    echo "WARN: Evaluator adapter '$eval_type' not found, skipping" >&2
    return 1
  fi

  # Skip self-referencing (prevent infinite recursion)
  if [ "$eval_type" = "consensus" ]; then
    echo "WARN: Skipping consensus evaluator to prevent recursion" >&2
    return 1
  fi

  # Run evaluator in subshell to isolate state (each adapter has load guards)
  (
    # Reset load guards so adapter can be sourced fresh
    unset _GROQ_ADAPTER_LOADED _OLLAMA_ADAPTER_LOADED _EVALUATOR_BASE_LOADED

    # Set evaluator-specific config via environment for the subshell
    # Export index so adapters can find their config
    export _CONSENSUS_EVAL_INDEX="$eval_index"

    # Source the base evaluator (needed for helper functions)
    if [ -f "$_CONSENSUS_LIB_DIR/evaluator.sh" ]; then
      source "$_CONSENSUS_LIB_DIR/evaluator.sh"
    fi

    # Source the adapter
    source "$adapter_path"

    # Call the adapter's evaluate function
    _adapter_evaluate "$file_path" "$content" "$criteria_json"
  ) 2>/dev/null
}

# --- Consensus strategies ---

# Compute consensus from individual results
# Args: $1=results_json (array of EvaluationResponses)
#        $2=weights_json (array of weights, same length)
#        $3=strategy
#        $4=tie_breaker
#        $5=quorum_threshold
#        $6=disagreement_threshold
# Returns: JSON ConsensusResult on stdout
_consensus_compute() {
  local results_json="$1"
  local weights_json="$2"
  local strategy="$3"
  local tie_breaker="$4"
  local quorum_threshold="$5"
  local disagreement_threshold="$6"

  _CC_RESULTS="$results_json" \
  _CC_WEIGHTS="$weights_json" \
  _CC_STRATEGY="$strategy" \
  _CC_TIEBREAKER="$tie_breaker" \
  _CC_QUORUM="$quorum_threshold" \
  _CC_DISAGREEMENT="$disagreement_threshold" \
  python3 << 'PYEOF'
import json, os, math

results_raw = os.environ["_CC_RESULTS"]
weights_raw = os.environ["_CC_WEIGHTS"]
strategy = os.environ["_CC_STRATEGY"]
tie_breaker = os.environ["_CC_TIEBREAKER"]
quorum_threshold = float(os.environ["_CC_QUORUM"])
disagreement_threshold = float(os.environ["_CC_DISAGREEMENT"])

results = json.loads(results_raw)
weights = json.loads(weights_raw)

if not results:
    print(json.dumps({
        "finalScore": 50,
        "finalKeep": True,
        "individualResults": [],
        "consensusReached": False,
        "disagreementLevel": 0.0
    }))
    sys.exit(0)

n = len(results)
scores = [r.get("score", 50) for r in results]
keeps = [r.get("keep", True) for r in results]

# Normalize weights to sum to 1.0
total_weight = sum(weights[:n]) if weights else n
if total_weight == 0:
    total_weight = n
    weights = [1.0] * n
norm_weights = [w / total_weight for w in weights[:n]]

# Calculate disagreement level (normalized standard deviation of scores, 0-1)
mean_score = sum(s * w for s, w in zip(scores, norm_weights))
variance = sum(w * (s - mean_score) ** 2 for s, w in zip(scores, norm_weights))
std_dev = math.sqrt(variance)
# Normalize: max possible std_dev for 0-100 range is 50
disagreement_level = min(1.0, std_dev / 50.0)

# Apply strategy
final_score = 50
final_keep = True
consensus_reached = True

if strategy == "weighted_average":
    final_score = round(sum(s * w for s, w in zip(scores, norm_weights)))
    # Keep if weighted average of keep votes > 0.5
    keep_vote = sum((1.0 if k else 0.0) * w for k, w in zip(keeps, norm_weights))
    final_keep = keep_vote > 0.5

elif strategy == "majority":
    # Simple majority of keep votes
    keep_count = sum(1 for k in keeps if k)
    discard_count = n - keep_count
    final_keep = keep_count > discard_count
    # Score is mean of scores (unweighted for majority)
    final_score = round(sum(scores) / n) if n > 0 else 50
    # Tie handling
    if keep_count == discard_count:
        if tie_breaker == "keep":
            final_keep = True
        elif tie_breaker == "discard":
            final_keep = False
        else:
            # escalate: flag as no consensus
            consensus_reached = False

elif strategy == "unanimous":
    # All must agree on keep/discard
    all_keep = all(keeps)
    all_discard = all(not k for k in keeps)
    if all_keep:
        final_keep = True
    elif all_discard:
        final_keep = False
    else:
        # No unanimity — use tie_breaker
        consensus_reached = False
        if tie_breaker == "keep":
            final_keep = True
        elif tie_breaker == "discard":
            final_keep = False
        else:
            final_keep = True  # safe default on escalate
    final_score = round(sum(s * w for s, w in zip(scores, norm_weights)))

elif strategy == "quorum":
    # Threshold fraction must agree
    keep_count = sum(1 for k in keeps if k)
    keep_ratio = keep_count / n if n > 0 else 0
    discard_ratio = 1.0 - keep_ratio

    if keep_ratio >= quorum_threshold:
        final_keep = True
    elif discard_ratio >= quorum_threshold:
        final_keep = False
    else:
        # No quorum reached
        consensus_reached = False
        if tie_breaker == "keep":
            final_keep = True
        elif tie_breaker == "discard":
            final_keep = False
        else:
            final_keep = True  # safe default
    final_score = round(sum(s * w for s, w in zip(scores, norm_weights)))

else:
    # Unknown strategy — fall back to weighted average
    final_score = round(sum(s * w for s, w in zip(scores, norm_weights)))
    keep_vote = sum((1.0 if k else 0.0) * w for k, w in zip(keeps, norm_weights))
    final_keep = keep_vote > 0.5

# Clamp score
final_score = max(0, min(100, final_score))

# Check if disagreement exceeds threshold
if disagreement_level > disagreement_threshold:
    consensus_reached = False

result = {
    "finalScore": final_score,
    "finalKeep": final_keep,
    "individualResults": results,
    "consensusReached": consensus_reached,
    "disagreementLevel": round(disagreement_level, 4)
}

print(json.dumps(result))
PYEOF
}

# --- Adapter interface implementation ---

# Evaluate a memory file using multiple judges and consensus
# Args: $1=file_path, $2=content, $3=criteria_json
# Returns: JSON EvaluationResponse on stdout (augmented with consensus metadata)
_adapter_evaluate() {
  local file_path="$1"
  local content="$2"
  local criteria_json="$3"

  # Read consensus config
  local strategy
  strategy="${CONSENSUS_STRATEGY:-$(_consensus_read_config "strategy" "weighted_average")}"
  local min_judges
  min_judges="${CONSENSUS_MIN_JUDGES:-$(_consensus_read_config "minJudges" "2")}"
  local quorum_threshold
  quorum_threshold=$(_consensus_read_config "quorumThreshold" "0.66")
  local tie_breaker
  tie_breaker=$(_consensus_read_config "tieBreaker" "keep")
  local disagreement_threshold
  disagreement_threshold=$(_consensus_read_config "disagreementThreshold" "0.3")

  # Get configured evaluators
  local evaluators_json
  evaluators_json=$(_consensus_get_evaluators)

  local eval_count
  eval_count=$(_consensus_evaluator_count "$evaluators_json")

  if [ "$eval_count" -eq 0 ]; then
    echo "WARN: No evaluators configured, using default groq" >&2
    evaluators_json='[{"type":"groq","weight":1.0}]'
    eval_count=1
  fi

  # Collect results from each evaluator
  local results=()
  local weights=()
  local successful=0
  local tmpdir
  tmpdir=$(mktemp -d)

  # Run evaluators sequentially (parallel would require background jobs + wait)
  local i=0
  while [ $i -lt "$eval_count" ]; do
    local eval_type
    eval_type=$(_consensus_evaluator_type_at "$evaluators_json" "$i")
    local weight
    weight=$(_consensus_evaluator_weight_at "$evaluators_json" "$i")

    if [ -z "$eval_type" ]; then
      i=$((i + 1))
      continue
    fi

    echo "Consensus: evaluating with $eval_type (weight=$weight)..." >&2

    local result_file="$tmpdir/result_${i}.json"
    if _consensus_run_evaluator "$eval_type" "$file_path" "$content" "$criteria_json" "$i" > "$result_file" 2>/dev/null; then
      local result_content
      result_content=$(cat "$result_file" 2>/dev/null)
      if [ -n "$result_content" ] && python3 -c "import json; json.loads('''$result_content''')" 2>/dev/null; then
        results+=("$result_content")
        weights+=("$weight")
        successful=$((successful + 1))
      else
        echo "WARN: Invalid response from $eval_type evaluator, skipping" >&2
      fi
    else
      echo "WARN: $eval_type evaluator failed, skipping" >&2
    fi

    i=$((i + 1))
  done

  rm -rf "$tmpdir"

  # Check minimum judges threshold
  if [ "$successful" -lt "$min_judges" ]; then
    echo "WARN: Only $successful of $min_judges required judges responded" >&2
    # If we have at least one result, use it; otherwise return safe default
    if [ "$successful" -eq 0 ]; then
      python3 -c "
import json
print(json.dumps({
    'score': 50,
    'keep': True,
    'reason': 'No evaluators responded — defaulting to keep',
    'confidence': 0.0,
    'categories': ['consensus_failure'],
    'suggestedTTL': 7,
    'consensus': {
        'strategy': '$strategy',
        'judgesResponded': 0,
        'judgesRequired': $min_judges,
        'consensusReached': False,
        'disagreementLevel': 0.0
    }
}))
"
      return 0
    fi
  fi

  # Build JSON arrays for computation
  local results_json weights_json
  results_json=$(python3 -c "
import json, sys
results = []
for line in sys.stdin:
    line = line.strip()
    if line:
        try:
            results.append(json.loads(line))
        except json.JSONDecodeError:
            pass
print(json.dumps(results))
" <<< "$(printf '%s\n' "${results[@]}")")

  weights_json=$(python3 -c "
import json
weights = [$(IFS=,; echo "${weights[*]}")]
print(json.dumps(weights))
")

  # Compute consensus
  local consensus_result
  consensus_result=$(_consensus_compute "$results_json" "$weights_json" "$strategy" "$tie_breaker" "$quorum_threshold" "$disagreement_threshold")

  # Convert ConsensusResult to EvaluationResponse format (adapter contract)
  python3 << PYEOF
import json, sys

consensus = json.loads('''$consensus_result''')
individual = consensus.get("individualResults", [])

# Aggregate reasons from individual results
reasons = [r.get("reason", "") for r in individual if r.get("reason")]
combined_reason = "; ".join(reasons[:3])  # Top 3 reasons
if not combined_reason:
    combined_reason = "Consensus evaluation"

# Aggregate categories
all_cats = set()
for r in individual:
    for c in r.get("categories", []):
        all_cats.add(c)

# Average confidence weighted by scores
confidences = [r.get("confidence", 0.5) for r in individual]
avg_confidence = sum(confidences) / len(confidences) if confidences else 0.5

# Average suggestedTTL
ttls = [r.get("suggestedTTL", 7) for r in individual if r.get("suggestedTTL") is not None]
avg_ttl = round(sum(ttls) / len(ttls)) if ttls else 7

response = {
    "score": consensus["finalScore"],
    "keep": consensus["finalKeep"],
    "reason": combined_reason,
    "confidence": round(avg_confidence, 2),
    "categories": sorted(list(all_cats)),
    "suggestedTTL": avg_ttl,
    "consensus": {
        "strategy": "$strategy",
        "judgesResponded": len(individual),
        "judgesRequired": $min_judges,
        "consensusReached": consensus["consensusReached"],
        "disagreementLevel": consensus["disagreementLevel"],
        "individualScores": [r.get("score", 50) for r in individual]
    }
}

print(json.dumps(response))
PYEOF
}

# Return evaluator metadata
# Returns: JSON EvaluatorMetadata on stdout
_adapter_metadata() {
  local strategy
  strategy="${CONSENSUS_STRATEGY:-$(_consensus_read_config "strategy" "weighted_average")}"
  local min_judges
  min_judges="${CONSENSUS_MIN_JUDGES:-$(_consensus_read_config "minJudges" "2")}"

  local evaluators_json
  evaluators_json=$(_consensus_get_evaluators)
  local eval_count
  eval_count=$(_consensus_evaluator_count "$evaluators_json")

  # Collect evaluator types
  local types=()
  local i=0
  while [ $i -lt "$eval_count" ]; do
    local t
    t=$(_consensus_evaluator_type_at "$evaluators_json" "$i")
    [ -n "$t" ] && types+=("$t")
    i=$((i + 1))
  done

  local types_json
  types_json=$(python3 -c "
import json
types = '$(IFS=,; echo "${types[*]}")'.split(',')
types = [t.strip() for t in types if t.strip()]
print(json.dumps(types))
" 2>/dev/null || echo '[]')

  python3 -c "
import json
print(json.dumps({
    'id': 'consensus',
    'name': 'ConsensusEvaluator',
    'version': '1.0.0',
    'model': 'multi-judge ($strategy)',
    'capabilities': ['multi_evaluator', 'consensus', '$strategy', 'disagreement_detection'],
    'evaluatorCount': $eval_count,
    'evaluatorTypes': $types_json,
    'minJudges': $min_judges
}))
"
}
