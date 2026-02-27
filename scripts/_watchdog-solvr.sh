#!/bin/bash
# _watchdog-solvr.sh — Claude Code CLI + Solvr knowledge compounding for watchdog fixes
#
# Called by watchdog.sh AFTER a successful fix to search/document on Solvr.
# Runs in the background so it doesn't block the watchdog cycle.
#
# Usage:
#   _watchdog-solvr.sh <fix_type> <diagnosis_json> [<fix_details>]
#
# Arguments:
#   fix_type       - session_corrupted | session_stuck | config_semantic | config_stuck | gateway_restart
#   diagnosis_json - JSON output from diagnose.sh (the findings)
#   fix_details    - Optional human-readable description of what the fix did
#
# Requires:
#   - claude CLI (Claude Code)
#   - anthropic.apiKey in ~/.amcp/config.json (agent's own key)
#   - solvr.apiKey in ~/.amcp/config.json (optional but recommended)
#
# Exit codes:
#   0 = documented successfully (or gracefully degraded)
#   1 = prerequisites missing (no claude CLI, no API key)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$HOME/.amcp/config.json}"
SOLVR_SKILL_DIR="${SOLVR_SKILL_DIR:-$HOME/.claude/skills/solvr}"
AGENT_NAME="${AGENT_NAME:-$(hostname -s)}"
LOG_DIR="${HOME}/.amcp/logs"

mkdir -p "$LOG_DIR"

# ============================================================
# Args
# ============================================================
FIX_TYPE="${1:-unknown}"
DIAG_JSON="${2:-{\}}"
FIX_DETAILS="${3:-Fix applied by watchdog}"

# ============================================================
# Helpers
# ============================================================
log_info()  { echo "[watchdog-solvr] $(date -Iseconds) INFO:  $*" | tee -a "$LOG_DIR/watchdog-solvr.log" >&2; }
log_error() { echo "[watchdog-solvr] $(date -Iseconds) ERROR: $*" | tee -a "$LOG_DIR/watchdog-solvr.log" >&2; }

# Read a key from proactive-amcp config (dot-path)
config_get() {
  local key="$1"
  python3 -c "
import json, functools
d = json.load(open('$CONFIG_FILE'))
val = functools.reduce(lambda c, k: c.get(k, {}) if isinstance(c, dict) else '', '$key'.split('.'), d)
print(val if val and val != {} else '')
" 2>/dev/null || echo ""
}

# ============================================================
# Prerequisites
# ============================================================

# Resolve Anthropic API key (agent's own, NOT env)
ANTHROPIC_API_KEY="$(config_get anthropic.apiKey)"
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  log_error "No anthropic.apiKey in config — skipping Solvr documentation"
  exit 1
fi

# Resolve Solvr API key
SOLVR_API_KEY="${SOLVR_API_KEY:-$(config_get solvr.apiKey)}"
if [[ -z "${SOLVR_API_KEY:-}" ]]; then
  SOLVR_API_KEY="$(config_get solvr_api_key)"
fi
export SOLVR_API_KEY="${SOLVR_API_KEY:-}"

# Check claude CLI
if ! command -v claude &>/dev/null; then
  log_error "claude CLI not found — skipping Solvr documentation"
  exit 1
fi

# Locate Solvr skill
SOLVR_CLI="$SOLVR_SKILL_DIR/scripts/solvr.sh"
SOLVR_AVAILABLE=false
if [[ -n "${SOLVR_API_KEY:-}" && -x "$SOLVR_CLI" ]]; then
  SOLVR_AVAILABLE=true
fi

if [[ "$SOLVR_AVAILABLE" != true ]]; then
  log_error "Solvr skill not available (no key or CLI missing) — skipping"
  exit 1
fi

# ============================================================
# Build Claude prompt with explicit Solvr instructions
# ============================================================
build_prompt() {
  cat <<PROMPT_EOF
You are the watchdog for OpenClaw agent "${AGENT_NAME}". A fix was just applied successfully. Your job is to SEARCH Solvr first, then DOCUMENT the fix for future reference — compounding knowledge.

## What Happened

**Fix type:** ${FIX_TYPE}
**Fix details:** ${FIX_DETAILS}
**Timestamp:** $(date -Iseconds)

## Diagnosis Findings (JSON)

\`\`\`json
${DIAG_JSON}
\`\`\`

## Your Task — Use Solvr

You MUST use the Solvr skill for knowledge compounding. Follow this exact workflow:

### Step 1: SEARCH Solvr for this issue
\`\`\`bash
bash ${SOLVR_CLI} search "${FIX_TYPE} openclaw gateway"
\`\`\`

### Step 2: If a matching problem EXISTS with a succeeded approach:
- The fix is already documented. Upvote if the approach matches what we did.
- Output: \`{"action": "found_existing", "post_id": "<id>"}\`

### Step 3: If NO match found, CREATE a new problem + approach:
\`\`\`bash
bash ${SOLVR_CLI} post problem "<short descriptive title about the ${FIX_TYPE} issue>" "<detailed description: what happened, error context, diagnosis findings>" --tags "openclaw,watchdog,${FIX_TYPE},auto-fix,${AGENT_NAME}"
\`\`\`

Then immediately add the approach that succeeded:
\`\`\`bash
bash ${SOLVR_CLI} approach <problem_id> "<description of the fix that worked: ${FIX_DETAILS}>"
\`\`\`

Then mark the approach as succeeded:
\`\`\`bash
curl -s -X PATCH "https://api.solvr.dev/v1/approaches/<approach_id>" \\
  -H "Authorization: Bearer \${SOLVR_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"succeeded"}'
\`\`\`

### Step 4: Output result
Respond with ONLY a JSON object:
{
  "action": "found_existing" | "created_new",
  "solvr_post_id": "<problem id or null>",
  "solvr_approach_id": "<approach id or null>",
  "search_results_count": <number>,
  "summary": "<one line summary>"
}

IMPORTANT: You MUST actually execute the bash commands above. Do not just plan — execute them. The SOLVR_API_KEY environment variable is set.
PROMPT_EOF
}

# ============================================================
# Invoke Claude Code CLI
# ============================================================
log_info "Documenting ${FIX_TYPE} fix on Solvr via Claude Code CLI..."

PROMPT=$(build_prompt)

CLAUDE_OUTPUT=""
CLAUDE_EXIT=0
CLAUDE_OUTPUT=$(ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" SOLVR_API_KEY="${SOLVR_API_KEY:-}" \
  claude --dangerously-skip-permissions --no-session-persistence \
    -p --output-format text \
    "$PROMPT" 2>/dev/null) || CLAUDE_EXIT=$?

if [[ $CLAUDE_EXIT -ne 0 ]]; then
  log_error "Claude CLI exited with $CLAUDE_EXIT"
  echo "$CLAUDE_OUTPUT" >> "$LOG_DIR/watchdog-solvr.log"
  exit 1
fi

log_info "Solvr documentation complete for ${FIX_TYPE}"
echo "$CLAUDE_OUTPUT" >> "$LOG_DIR/watchdog-solvr.log"
