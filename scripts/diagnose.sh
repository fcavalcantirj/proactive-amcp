#!/bin/bash
# diagnose.sh — Comprehensive health diagnostic for OpenClaw agent
#
# Outputs structured JSON with findings. Each finding has:
#   type, severity, message, path (optional), fix_command (optional)
#
# Exit codes:
#   0 = healthy (no findings)
#   1 = issues found
#
# Usage:
#   ./diagnose.sh [--session-dir DIR]
#
# The LLM or watchdog reads the JSON and picks the right fix.

set -euo pipefail

command -v python3 &>/dev/null || { echo "FATAL: python3 required but not found" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_DIR="${SESSION_DIR:-$HOME/.openclaw/agents/main/sessions}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
DISK_THRESHOLD="${DISK_THRESHOLD:-10}"
MEM_THRESHOLD="${MEM_THRESHOLD:-10}"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --session-dir) SESSION_DIR="$2"; shift 2 ;;
    --config) OPENCLAW_CONFIG="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Collect findings as JSON array entries
FINDINGS=()

add_finding() {
  local type="$1"
  local severity="$2"
  local message="$3"
  local path="${4:-}"
  local fix_cmd="${5:-}"

  local entry
  entry=$(python3 -c "
import json
print(json.dumps({
    'type': '$type',
    'severity': '$severity',
    'message': '''$message''',
    'path': '$path',
    'fix_command': '$fix_cmd'
}))
")
  FINDINGS+=("$entry")
}

# ============================================================
# Check 1: Gateway process
# ============================================================
check_gateway_process() {
  if pgrep -f "openclaw-gateway" > /dev/null 2>&1; then
    return 0
  fi
  if pgrep -f "openclaw.*gateway" > /dev/null 2>&1; then
    return 0
  fi
  add_finding "gateway_down" "critical" \
    "Gateway process not running" \
    "" \
    "$SCRIPT_DIR/resuscitate.sh"
  return 1
}

# ============================================================
# Check 2: Gateway health endpoint
# ============================================================
check_gateway_health() {
  # Determine which ports to check: GATEWAY_PORT env > openclaw.json > defaults
  local ports_to_check=()
  if [ -n "${GATEWAY_PORT:-}" ]; then
    ports_to_check=("$GATEWAY_PORT")
  elif [ -f "$OPENCLAW_CONFIG" ]; then
    local cfg_port
    cfg_port=$(python3 -c "import json; print(json.load(open('$OPENCLAW_CONFIG')).get('gateway',{}).get('port',''))" 2>/dev/null || echo '')
    if [ -n "$cfg_port" ]; then
      ports_to_check=("$cfg_port")
    fi
  fi
  # Fall back to default ports if nothing configured
  if [ ${#ports_to_check[@]} -eq 0 ]; then
    ports_to_check=(3141 8080 18789)
  fi

  for port in "${ports_to_check[@]}"; do
    if curl -s --max-time 5 "http://localhost:${port}/health" > /dev/null 2>&1; then
      return 0
    fi
  done
  add_finding "gateway_unresponsive" "warning" \
    "Gateway process exists but health endpoint not responding (checked ports: ${ports_to_check[*]})" \
    "" \
    "systemctl --user restart openclaw-gateway"
  return 1
}

# ============================================================
# Check 3: Session corruption (the 400 error loop)
# ============================================================
check_session_corruption() {
  if [ ! -d "$SESSION_DIR" ]; then
    return 0
  fi

  local sessions_json="$SESSION_DIR/sessions.json"
  if [ ! -f "$sessions_json" ]; then
    return 0
  fi

  # Use Python to find the active session and scan for corruption
  local result
  result=$(SESSION_DIR="$SESSION_DIR" python3 << 'PYEOF'
import json, os, glob

session_dir = os.environ["SESSION_DIR"]
sessions_json = os.path.join(session_dir, "sessions.json")

if not os.path.exists(sessions_json):
    print("no_sessions_json")
    exit(0)

# Find active session IDs
with open(sessions_json) as f:
    sessions = json.load(f)

session_ids = []
for key, val in sessions.items():
    if isinstance(val, dict) and "sessionId" in val:
        session_ids.append(val["sessionId"])

if not session_ids:
    # Fall back to most recent .jsonl files
    files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")),
                   key=os.path.getmtime, reverse=True)[:3]
    session_ids = [os.path.splitext(os.path.basename(f))[0] for f in files]

# Scan each session for the corruption pattern
corrupted = []
for sid in session_ids:
    filepath = os.path.join(session_dir, f"{sid}.jsonl")
    if not os.path.exists(filepath):
        continue

    has_partial = False
    has_400_loop = False
    error_400_count = 0

    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except:
                continue

            msg = obj.get("message", {})

            # Check for partialJson in tool calls
            for block in msg.get("content", []):
                if isinstance(block, dict) and "partialJson" in block:
                    has_partial = True

            # Check for 400 tool_use_id error loop
            err = msg.get("errorMessage", "")
            if "unexpected `tool_use_id` found in `tool_result` blocks" in err:
                error_400_count += 1

    if error_400_count >= 2:
        has_400_loop = True

    if has_partial or has_400_loop:
        corrupted.append({
            "session_id": sid,
            "path": filepath,
            "has_partial_json": has_partial,
            "error_400_count": error_400_count
        })

if corrupted:
    print(json.dumps(corrupted))
else:
    print("clean")
PYEOF
  )

  if [ "$result" = "clean" ] || [ "$result" = "no_sessions_json" ]; then
    return 0
  fi

  # Parse each corrupted session and add findings
  local count
  count=$(echo "$result" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
  local i=0
  while [ "$i" -lt "$count" ]; do
    local session_path
    session_path=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['path'])")
    local session_id
    session_id=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['session_id'])")
    local err_count
    err_count=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin)[$i]['error_400_count'])")

    add_finding "session_corrupted" "critical" \
      "Session $session_id has corrupted tool_use blocks (${err_count} cascading 400 errors)" \
      "$session_path" \
      "$SCRIPT_DIR/session-fix.sh --fix --session-dir $SESSION_DIR --session-id $session_id"

    i=$((i + 1))
  done

  return 1
}

# ============================================================
# Check 4: Config validity
# ============================================================
check_config() {
  if [ ! -f "$OPENCLAW_CONFIG" ]; then
    add_finding "config_missing" "warning" \
      "OpenClaw config not found at $OPENCLAW_CONFIG" \
      "$OPENCLAW_CONFIG" \
      ""
    return 1
  fi

  if ! python3 -c "import json; json.load(open('$OPENCLAW_CONFIG'))" 2>/dev/null; then
    add_finding "config_invalid" "critical" \
      "OpenClaw config is not valid JSON" \
      "$OPENCLAW_CONFIG" \
      "$SCRIPT_DIR/resuscitate.sh"
    return 1
  fi

  return 0
}

# ============================================================
# Check 5: Disk space
# ============================================================
check_disk() {
  local disk_free
  disk_free=$(df -h "$HOME" | awk 'NR==2 {gsub(/%/,""); print 100-$5}') || return 0

  if [ "$disk_free" -lt "$DISK_THRESHOLD" ] 2>/dev/null; then
    add_finding "disk_low" "warning" \
      "Disk space low: ${disk_free}% free (threshold: ${DISK_THRESHOLD}%)" \
      "$HOME" \
      ""
    return 1
  fi
  return 0
}

# ============================================================
# Check 6: Memory
# ============================================================
check_memory() {
  local mem_free
  mem_free=$(free | awk '/Mem:/ {printf "%.0f", $7/$2*100}') || return 0

  if [ "$mem_free" -lt "$MEM_THRESHOLD" ] 2>/dev/null; then
    add_finding "memory_low" "warning" \
      "Memory low: ${mem_free}% available (threshold: ${MEM_THRESHOLD}%)" \
      "" \
      ""
    return 1
  fi
  return 0
}

# ============================================================
# Run all checks
# ============================================================
has_issues=false

check_gateway_process || has_issues=true
# Only check health if gateway process exists
if [ "$has_issues" = false ]; then
  check_gateway_health || has_issues=true
fi
check_session_corruption || has_issues=true
check_config || has_issues=true
check_disk || has_issues=true
check_memory || has_issues=true

# ============================================================
# Output structured JSON
# ============================================================
status="healthy"
if [ "$has_issues" = true ]; then
  status="unhealthy"
fi

# Build JSON output
findings_json="["
first=true
for f in "${FINDINGS[@]}"; do
  if [ "$first" = true ]; then
    first=false
  else
    findings_json+=","
  fi
  findings_json+="$f"
done
findings_json+="]"

python3 -c "
import json, sys
findings = json.loads('''$findings_json''')
result = {
    'status': '$status',
    'findings': findings,
    'checks_run': 6,
    'findings_count': len(findings)
}
print(json.dumps(result, indent=2))
"

if [ "$has_issues" = true ]; then
  exit 1
fi
exit 0
