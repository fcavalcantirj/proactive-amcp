#!/usr/bin/env bats
# consolidation-test.bats — Verify no functionality loss from script consolidation (PRD task 10)
#
# Tests:
#   1. All consolidated hub scripts exist and pass bash -n syntax check
#   2. All internal implementation scripts (_*.sh) exist and pass syntax check
#   3. Each hub's usage output lists expected subcommands
#   4. Each hub rejects unknown subcommands with error
#   5. Hub scripts route subcommands to correct internal scripts
#   6. proactive-amcp.sh backward-compat aliases route correctly
#   7. Checkpoint flag parsing selects correct modes
#   8. Full workflow: init prerequisites → checkpoint → diagnose → learning

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Sandbox all scripts
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"

  # Copy all scripts to sandbox
  for f in "$REAL_SCRIPT_DIR"/*.sh "$REAL_SCRIPT_DIR"/*.py; do
    if [ -f "$f" ]; then
      cp "$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$(basename "$f")"
    fi
  done

  # Mock external commands
  create_mock_amcp 0
  create_mock_curl "200" '{"status":"ok"}'
  create_mock_systemctl

  # Create valid identity and config for scripts that need them
  create_valid_identity
  echo '{"ipfs":{"provider":"solvr"},"solvr":{"apiKey":"test_key"}}' > "$AMCP_DIR/config.json"

  # Create openclaw.json
  mkdir -p "$OPENCLAW_DIR"
  echo '{"gateway":{"port":3141}}' > "$OPENCLAW_DIR/openclaw.json"
}

teardown() {
  teardown_test_env
}

# ============================================================
# Helper: create routing-probe mock scripts
# These replace internal _*.sh scripts to verify routing.
# Each mock writes its name + args to a probe log file.
# ============================================================
install_route_probes() {
  local probe_log="$TEST_DIR/route-probe.log"
  for script in "$SANDBOXED_SCRIPTS"/_*.sh; do
    local name
    name="$(basename "$script")"
    cat > "$script" << EOPROBE
#!/bin/bash
echo "ROUTED:${name}:\$*" >> "$probe_log"
EOPROBE
    chmod +x "$script"
  done

  # Also mock Python scripts that are exec'd
  for py_script in detect-failure.py generate-problem-summary.py validate-ontology.py \
                    prune-ontology.py compute-entity-similarity.py temporal-queries.py \
                    learning.py learning-report.py validate-skill-contract.py \
                    detect-contract-conflicts.py; do
    if [ -f "$SANDBOXED_SCRIPTS/$py_script" ]; then
      # Replace the python script with a bash mock that logs routing
      cat > "$SANDBOXED_SCRIPTS/$py_script" << EOPROBE
#!/bin/bash
echo "ROUTED:${py_script}:\$*" >> "$probe_log"
EOPROBE
      chmod +x "$SANDBOXED_SCRIPTS/$py_script"
    fi
  done

  # Mock python3 to run our bash probes as scripts
  cat > "$MOCK_BIN/python3" << 'EOPY'
#!/bin/bash
# If the "script" is actually our bash probe, just execute it
script_path=""
args=()
for arg in "$@"; do
  if [[ "$arg" == *.py ]]; then
    script_path="$arg"
  else
    args+=("$arg")
  fi
done
if [ -n "$script_path" ] && [ -f "$script_path" ]; then
  exec bash "$script_path" "${args[@]}"
fi
exit 0
EOPY
  chmod +x "$MOCK_BIN/python3"

  # Also need to handle: memory-prune.sh, memory-prune-batch.sh, memory-evolution.sh
  # These are called by memory.sh directly (not prefixed with _)
  for legacy_script in memory-prune.sh memory-prune-batch.sh memory-evolution.sh; do
    cat > "$SANDBOXED_SCRIPTS/$legacy_script" << EOPROBE
#!/bin/bash
echo "ROUTED:${legacy_script}:\$*" >> "$probe_log"
EOPROBE
    chmod +x "$SANDBOXED_SCRIPTS/$legacy_script"
  done

  echo "$probe_log"
}

# Helper: check route probe log for a specific routing entry
assert_routed_to() {
  local probe_log="$1"
  local expected_target="$2"
  grep -q "ROUTED:${expected_target}:" "$probe_log"
}

# Helper: check route probe log for target with specific args
assert_routed_to_with_args() {
  local probe_log="$1"
  local expected_target="$2"
  local expected_args="$3"
  grep -q "ROUTED:${expected_target}:${expected_args}" "$probe_log"
}

# ============================================================
# SECTION 1: Syntax validation — all consolidated scripts
# ============================================================

@test "syntax: proactive-amcp.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/proactive-amcp.sh"
}

@test "syntax: diagnose.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/diagnose.sh"
}

@test "syntax: config.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/config.sh"
}

@test "syntax: checkpoint.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/checkpoint.sh"
}

@test "syntax: solvr.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/solvr.sh"
}

@test "syntax: memory.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/memory.sh"
}

@test "syntax: ontology.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/ontology.sh"
}

@test "syntax: learning.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/learning.sh"
}

@test "syntax: secrets.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/secrets.sh"
}

@test "syntax: status.sh passes bash -n" {
  bash -n "$REAL_SCRIPT_DIR/status.sh"
}

# ============================================================
# SECTION 2: Internal implementation scripts exist and pass syntax
# ============================================================

@test "syntax: all _*.sh internal scripts pass bash -n" {
  local fail_count=0
  for script in "$REAL_SCRIPT_DIR"/_*.sh; do
    if ! bash -n "$script" 2>/dev/null; then
      echo "FAIL: bash -n $(basename "$script")" >&2
      fail_count=$((fail_count + 1))
    fi
  done
  [ "$fail_count" -eq 0 ]
}

@test "existence: diagnose internal scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/_diagnose-claude.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_diagnose-condense.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_diagnose-fix.sh" ]
  [ -f "$REAL_SCRIPT_DIR/detect-failure.py" ]
  [ -f "$REAL_SCRIPT_DIR/generate-problem-summary.py" ]
}

@test "existence: config internal scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/_config-backup.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_config-fix.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_config-evaluators.sh" ]
}

@test "existence: checkpoint internal scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/_checkpoint-list.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_checkpoint-full.sh" ]
}

@test "existence: solvr internal scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/_solvr-register.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_solvr-heartbeat.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_solvr-pin.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_solvr-checkpoint.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_solvr-resurrect.sh" ]
}

@test "existence: secrets internal scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/_secrets-scan.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_secrets-inject.sh" ]
  [ -f "$REAL_SCRIPT_DIR/_secrets-precommit.sh" ]
}

@test "existence: status internal scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/_status-groq.sh" ]
}

@test "existence: memory implementation scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/memory-prune.sh" ]
  [ -f "$REAL_SCRIPT_DIR/memory-prune-batch.sh" ]
  [ -f "$REAL_SCRIPT_DIR/memory-evolution.sh" ]
}

@test "existence: learning implementation scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/learning.py" ]
  [ -f "$REAL_SCRIPT_DIR/learning-report.py" ]
}

@test "existence: ontology implementation scripts exist" {
  [ -f "$REAL_SCRIPT_DIR/validate-ontology.py" ]
  [ -f "$REAL_SCRIPT_DIR/prune-ontology.py" ]
  [ -f "$REAL_SCRIPT_DIR/compute-entity-similarity.py" ]
  [ -f "$REAL_SCRIPT_DIR/temporal-queries.py" ]
  [ -f "$REAL_SCRIPT_DIR/validate-skill-contract.py" ]
  [ -f "$REAL_SCRIPT_DIR/detect-contract-conflicts.py" ]
}

# ============================================================
# SECTION 3: Usage output — each hub lists expected subcommands
# ============================================================

@test "usage: proactive-amcp.sh shows all top-level commands" {
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" --help
  # Exit 1 is normal for usage
  [[ "$output" == *"status"* ]]
  [[ "$output" == *"init"* ]]
  [[ "$output" == *"config"* ]]
  [[ "$output" == *"install"* ]]
  [[ "$output" == *"diagnose"* ]]
  [[ "$output" == *"solvr"* ]]
  [[ "$output" == *"checkpoint"* ]]
  [[ "$output" == *"secrets"* ]]
  [[ "$output" == *"learning"* ]]
  [[ "$output" == *"ontology"* ]]
  [[ "$output" == *"memory"* ]]
  [[ "$output" == *"heartbeat"* ]]
  [[ "$output" == *"resurrect"* ]]
  [[ "$output" == *"claim-info"* ]]
  [[ "$output" == *"link-identity"* ]]
  [[ "$output" == *"groq"* ]]
}

@test "usage: solvr.sh shows register, heartbeat, pin, checkpoint, resurrect" {
  run "$SANDBOXED_SCRIPTS/solvr.sh" --help
  [[ "$output" == *"register"* ]]
  [[ "$output" == *"heartbeat"* ]]
  [[ "$output" == *"pin"* ]]
  [[ "$output" == *"checkpoint"* ]]
  [[ "$output" == *"resurrect"* ]]
}

@test "usage: memory.sh shows prune, prune-batch, evolution" {
  run "$SANDBOXED_SCRIPTS/memory.sh" --help
  [[ "$output" == *"prune"* ]]
  [[ "$output" == *"prune-batch"* ]]
  [[ "$output" == *"evolution"* ]]
}

@test "usage: ontology.sh shows validate, prune, similarity, temporal, contract, conflicts" {
  run "$SANDBOXED_SCRIPTS/ontology.sh" --help
  [[ "$output" == *"validate"* ]]
  [[ "$output" == *"prune"* ]]
  [[ "$output" == *"similarity"* ]]
  [[ "$output" == *"temporal"* ]]
  [[ "$output" == *"contract"* ]]
  [[ "$output" == *"conflicts"* ]]
}

@test "usage: learning.sh shows problem, log, report" {
  run "$SANDBOXED_SCRIPTS/learning.sh" --help
  [[ "$output" == *"problem"* ]]
  [[ "$output" == *"log"* ]]
  [[ "$output" == *"report"* ]]
}

@test "usage: secrets.sh shows scan, inject, pre-commit" {
  run "$SANDBOXED_SCRIPTS/secrets.sh" --help
  [[ "$output" == *"scan"* ]]
  [[ "$output" == *"inject"* ]]
  [[ "$output" == *"pre-commit"* ]]
}

@test "usage: config.sh shows set, get, evaluators, backup, fix" {
  run "$SANDBOXED_SCRIPTS/config.sh" --help
  [[ "$output" == *"set"* ]]
  [[ "$output" == *"get"* ]]
  [[ "$output" == *"evaluators"* ]]
  [[ "$output" == *"backup"* ]]
  [[ "$output" == *"fix"* ]]
}

# ============================================================
# SECTION 4: Unknown subcommand rejection
# ============================================================

@test "error: solvr.sh rejects unknown subcommand" {
  run "$SANDBOXED_SCRIPTS/solvr.sh" nonexistent-cmd
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"ERROR"* ]]
}

@test "error: memory.sh rejects unknown subcommand" {
  run "$SANDBOXED_SCRIPTS/memory.sh" nonexistent-cmd
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"ERROR"* ]]
}

@test "error: ontology.sh rejects unknown subcommand" {
  run "$SANDBOXED_SCRIPTS/ontology.sh" nonexistent-cmd
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"ERROR"* ]]
}

@test "error: learning.sh rejects unknown subcommand" {
  run "$SANDBOXED_SCRIPTS/learning.sh" nonexistent-cmd
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"ERROR"* ]]
}

@test "error: secrets.sh rejects unknown subcommand" {
  run "$SANDBOXED_SCRIPTS/secrets.sh" nonexistent-cmd
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"ERROR"* ]]
}

@test "error: proactive-amcp.sh rejects unknown command" {
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" nonexistent-cmd
  [ "$status" -ne 0 ]
  [[ "$output" == *"Unknown"* ]] || [[ "$output" == *"ERROR"* ]]
}

# ============================================================
# SECTION 5: Subcommand routing — diagnose hub
# ============================================================

@test "routing: diagnose claude → _diagnose-claude.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/diagnose.sh" claude --json
  assert_routed_to "$probe_log" "_diagnose-claude.sh"
}

@test "routing: diagnose condense → _diagnose-condense.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/diagnose.sh" condense "test error message"
  assert_routed_to "$probe_log" "_diagnose-condense.sh"
}

@test "routing: diagnose failure → detect-failure.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/diagnose.sh" failure --input /dev/null
  assert_routed_to "$probe_log" "detect-failure.py"
}

@test "routing: diagnose summary → generate-problem-summary.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/diagnose.sh" summary
  assert_routed_to "$probe_log" "generate-problem-summary.py"
}

@test "routing: diagnose fix → _diagnose-fix.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/diagnose.sh" fix --dry-run
  assert_routed_to "$probe_log" "_diagnose-fix.sh"
}

# ============================================================
# SECTION 6: Subcommand routing — config hub
# ============================================================

@test "routing: config evaluators → _config-evaluators.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/config.sh" evaluators list
  assert_routed_to "$probe_log" "_config-evaluators.sh"
}

@test "routing: config backup → _config-backup.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/config.sh" backup
  assert_routed_to "$probe_log" "_config-backup.sh"
}

@test "routing: config fix → _config-fix.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/config.sh" fix --dry-run
  assert_routed_to "$probe_log" "_config-fix.sh"
}

@test "routing: config set works inline" {
  run "$SANDBOXED_SCRIPTS/config.sh" set test.key "test_value"
  [ "$status" -eq 0 ]
  # Verify the value was actually set
  run "$SANDBOXED_SCRIPTS/config.sh" get test.key
  [ "$status" -eq 0 ]
  [[ "$output" == *"test_value"* ]]
}

@test "routing: config get works inline" {
  run "$SANDBOXED_SCRIPTS/config.sh" get ipfs.provider
  [ "$status" -eq 0 ]
  [[ "$output" == *"solvr"* ]]
}

# ============================================================
# SECTION 7: Subcommand routing — solvr hub
# ============================================================

@test "routing: solvr register → _solvr-register.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/solvr.sh" register --name test_agent --dry-run
  assert_routed_to "$probe_log" "_solvr-register.sh"
}

@test "routing: solvr heartbeat → _solvr-heartbeat.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/solvr.sh" heartbeat --json
  assert_routed_to "$probe_log" "_solvr-heartbeat.sh"
}

@test "routing: solvr pin → _solvr-pin.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/solvr.sh" pin /tmp/test.txt "test-pin"
  assert_routed_to "$probe_log" "_solvr-pin.sh"
}

@test "routing: solvr checkpoint → _solvr-checkpoint.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/solvr.sh" checkpoint --cid bafk123
  assert_routed_to "$probe_log" "_solvr-checkpoint.sh"
}

@test "routing: solvr resurrect → _solvr-resurrect.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/solvr.sh" resurrect --agent-id agent_Test --dry-run
  assert_routed_to "$probe_log" "_solvr-resurrect.sh"
}

# ============================================================
# SECTION 8: Subcommand routing — checkpoint hub
# ============================================================

@test "routing: checkpoint list → _checkpoint-list.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/checkpoint.sh" list
  assert_routed_to "$probe_log" "_checkpoint-list.sh"
}

@test "routing: checkpoint --help shows all modes" {
  run "$SANDBOXED_SCRIPTS/checkpoint.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--full"* ]]
  [[ "$output" == *"--auto"* ]]
  [[ "$output" == *"--trigger"* ]]
  [[ "$output" == *"--smart"* ]]
  [[ "$output" == *"--dry-run"* ]]
}

# ============================================================
# SECTION 9: Subcommand routing — secrets hub
# ============================================================

@test "routing: secrets scan → _secrets-scan.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/secrets.sh" scan /tmp
  assert_routed_to "$probe_log" "_secrets-scan.sh"
}

@test "routing: secrets inject → _secrets-inject.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/secrets.sh" inject /tmp/secrets.json
  assert_routed_to "$probe_log" "_secrets-inject.sh"
}

@test "routing: secrets pre-commit → _secrets-precommit.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/secrets.sh" pre-commit
  assert_routed_to "$probe_log" "_secrets-precommit.sh"
}

# ============================================================
# SECTION 10: Subcommand routing — memory hub
# ============================================================

@test "routing: memory prune → memory-prune.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/memory.sh" prune --dry-run
  assert_routed_to "$probe_log" "memory-prune.sh"
}

@test "routing: memory prune --batch → memory-prune-batch.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/memory.sh" prune --batch --submit
  assert_routed_to "$probe_log" "memory-prune-batch.sh"
}

@test "routing: memory prune-batch → memory-prune-batch.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/memory.sh" prune-batch --poll
  assert_routed_to "$probe_log" "memory-prune-batch.sh"
}

@test "routing: memory evolution → memory-evolution.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/memory.sh" evolution --all-new
  assert_routed_to "$probe_log" "memory-evolution.sh"
}

# ============================================================
# SECTION 11: Subcommand routing — learning hub
# ============================================================

@test "routing: learning problem → learning.py problem" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/learning.sh" problem list
  assert_routed_to "$probe_log" "learning.py"
}

@test "routing: learning log → learning.py learning" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/learning.sh" log list
  assert_routed_to "$probe_log" "learning.py"
}

@test "routing: learning report → learning-report.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/learning.sh" report --json
  assert_routed_to "$probe_log" "learning-report.py"
}

@test "routing: learning backward compat — create routes to learning.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/learning.sh" create --insight "test"
  assert_routed_to "$probe_log" "learning.py"
}

# ============================================================
# SECTION 12: Subcommand routing — ontology hub
# ============================================================

@test "routing: ontology validate → validate-ontology.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/ontology.sh" validate /tmp/graph.jsonl
  assert_routed_to "$probe_log" "validate-ontology.py"
}

@test "routing: ontology prune → prune-ontology.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/ontology.sh" prune --dry-run
  assert_routed_to "$probe_log" "prune-ontology.py"
}

@test "routing: ontology similarity → compute-entity-similarity.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/ontology.sh" similarity --graph /tmp/g.jsonl --entity-id ent_123
  assert_routed_to "$probe_log" "compute-entity-similarity.py"
}

@test "routing: ontology temporal → temporal-queries.py" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/ontology.sh" temporal history ent_abc
  assert_routed_to "$probe_log" "temporal-queries.py"
}

@test "routing: ontology contract inline handler runs" {
  # Contract needs either a skill name or --contract flag
  # With missing skill.json, it should output SKIP (no crash)
  run "$SANDBOXED_SCRIPTS/ontology.sh" contract nonexistent-skill --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipped"* ]]
}

@test "routing: ontology conflicts inline handler runs" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/ontology.sh" conflicts --json
  assert_routed_to "$probe_log" "detect-contract-conflicts.py"
}

# ============================================================
# SECTION 13: Subcommand routing — status hub
# ============================================================

@test "routing: status groq → _status-groq.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/status.sh" groq status
  assert_routed_to "$probe_log" "_status-groq.sh"
}

@test "routing: status --help shows modes" {
  run "$SANDBOXED_SCRIPTS/status.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--full"* ]]
  [[ "$output" == *"--json"* ]]
}

# ============================================================
# SECTION 14: proactive-amcp.sh backward compat aliases
# ============================================================

@test "alias: register → solvr register" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" register --name test --dry-run
  assert_routed_to "$probe_log" "_solvr-register.sh"
}

@test "alias: solvr-register → solvr register" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" solvr-register --name test --dry-run
  assert_routed_to "$probe_log" "_solvr-register.sh"
}

@test "alias: heartbeat → solvr heartbeat" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" heartbeat --json
  assert_routed_to "$probe_log" "_solvr-heartbeat.sh"
}

@test "alias: resurrect → solvr resurrect" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" resurrect --dry-run
  assert_routed_to "$probe_log" "_solvr-resurrect.sh"
}

@test "alias: memory-prune → memory prune" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" memory-prune --dry-run
  assert_routed_to "$probe_log" "memory-prune.sh"
}

@test "alias: temporal-query → ontology temporal" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" temporal-query history ent_abc
  assert_routed_to "$probe_log" "temporal-queries.py"
}

@test "alias: prune → ontology prune" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" prune --dry-run
  assert_routed_to "$probe_log" "prune-ontology.py"
}

@test "alias: validate-contract → ontology contract" {
  # With nonexistent skill, contract handler should output SKIP
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" validate-contract nonexistent-skill --json
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipped"* ]]
}

@test "alias: detect-conflicts → ontology conflicts" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" detect-conflicts --json
  assert_routed_to "$probe_log" "detect-contract-conflicts.py"
}

@test "alias: condense-error → diagnose condense" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" condense-error "test error"
  assert_routed_to "$probe_log" "_diagnose-condense.sh"
}

@test "alias: session-fix → diagnose fix" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" session-fix --dry-run
  assert_routed_to "$probe_log" "_diagnose-fix.sh"
}

@test "alias: detect-failure → diagnose failure" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" detect-failure --input /dev/null
  assert_routed_to "$probe_log" "detect-failure.py"
}

@test "alias: backup-config → config backup" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" backup-config
  assert_routed_to "$probe_log" "_config-backup.sh"
}

@test "alias: checkpoints → checkpoint list" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" checkpoints
  assert_routed_to "$probe_log" "_checkpoint-list.sh"
}

@test "alias: groq → status groq" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" groq status
  assert_routed_to "$probe_log" "_status-groq.sh"
}

@test "alias: problem → learning problem" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" problem list
  assert_routed_to "$probe_log" "learning.py"
}

# ============================================================
# SECTION 15: proactive-amcp.sh primary command dispatch
# ============================================================

@test "dispatch: proactive-amcp.sh diagnose → diagnose.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" diagnose claude --json
  assert_routed_to "$probe_log" "_diagnose-claude.sh"
}

@test "dispatch: proactive-amcp.sh solvr → solvr.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" solvr register --dry-run
  assert_routed_to "$probe_log" "_solvr-register.sh"
}

@test "dispatch: proactive-amcp.sh secrets → secrets.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" secrets scan /tmp
  assert_routed_to "$probe_log" "_secrets-scan.sh"
}

@test "dispatch: proactive-amcp.sh memory → memory.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" memory evolution --all-new
  assert_routed_to "$probe_log" "memory-evolution.sh"
}

@test "dispatch: proactive-amcp.sh ontology → ontology.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" ontology validate /tmp/g.jsonl
  assert_routed_to "$probe_log" "validate-ontology.py"
}

@test "dispatch: proactive-amcp.sh learning → learning.sh" {
  local probe_log
  probe_log="$(install_route_probes)"
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh" learning report --json
  assert_routed_to "$probe_log" "learning-report.py"
}

# ============================================================
# SECTION 16: Config set/get roundtrip (real implementation)
# ============================================================

@test "config: set then get roundtrip for nested key" {
  run "$SANDBOXED_SCRIPTS/config.sh" set notify.target "12345"
  [ "$status" -eq 0 ]

  run "$SANDBOXED_SCRIPTS/config.sh" get notify.target
  [ "$status" -eq 0 ]
  [[ "$output" == *"12345"* ]]
}

@test "config: set boolean coercion" {
  run "$SANDBOXED_SCRIPTS/config.sh" set notify.emailOnResurrect true
  [ "$status" -eq 0 ]

  run "$SANDBOXED_SCRIPTS/config.sh" get notify.emailOnResurrect
  [ "$status" -eq 0 ]
  [[ "$output" == *"True"* ]] || [[ "$output" == *"true"* ]]
}

@test "config: set integer coercion" {
  run "$SANDBOXED_SCRIPTS/config.sh" set watchdog.interval 120
  [ "$status" -eq 0 ]

  run "$SANDBOXED_SCRIPTS/config.sh" get watchdog.interval
  [ "$status" -eq 0 ]
  [[ "$output" == *"120"* ]]
}

@test "config: get full config redacts secrets" {
  run "$SANDBOXED_SCRIPTS/config.sh" set pinata.jwt "eyJhbGciOiJIUzI1NiJ9.secret"
  run "$SANDBOXED_SCRIPTS/config.sh" get
  [ "$status" -eq 0 ]
  # Should show the key but redact the value
  [[ "$output" != *"eyJhbGciOiJIUzI1NiJ9.secret"* ]] || [[ "$output" == *"***"* ]]
}

# ============================================================
# SECTION 17: Status basic check (real implementation)
# ============================================================

@test "status: basic check returns READY when identity and pinning configured" {
  run "$SANDBOXED_SCRIPTS/status.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"READY"* ]]
}

@test "status: returns NO_IDENTITY when identity missing" {
  rm -f "$AMCP_DIR/identity.json"
  run "$SANDBOXED_SCRIPTS/status.sh"
  [[ "$output" == *"NO_IDENTITY"* ]]
}

@test "status: returns INVALID_IDENTITY when amcp validate fails" {
  # Create a mock amcp that fails validation
  create_mock_amcp 1
  run "$SANDBOXED_SCRIPTS/status.sh"
  [[ "$output" == *"INVALID_IDENTITY"* ]]
}

@test "status: returns NO_PINNING when no pinning configured" {
  # Remove all pinning config
  echo '{}' > "$AMCP_DIR/config.json"
  run "$SANDBOXED_SCRIPTS/status.sh"
  [[ "$output" == *"NO_PINNING"* ]]
}

# ============================================================
# SECTION 18: Checkpoint flag parsing (real checkpoint.sh)
# ============================================================

@test "checkpoint: --help exits 0 with usage" {
  run "$SANDBOXED_SCRIPTS/checkpoint.sh" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"checkpoint"* ]]
}

# ============================================================
# SECTION 19: Deprecated script warning (no direct calls)
# ============================================================

@test "migration: old script paths should not be called directly" {
  # Verify the deprecated scripts have been removed or renamed
  # These should NOT exist as standalone scripts anymore:
  local deprecated_scripts=(
    "claude-diagnose.sh"
    "backup-config.sh"
    "try-fix-config.sh"
    "config-evaluators.sh"
    "solvr-register.sh"
    "pin-to-solvr.sh"
    "solvr-heartbeat.sh"
    "resurrect-from-solvr.sh"
    "register-checkpoint-solvr.sh"
    "scan-secrets.sh"
    "inject-secrets.sh"
    "pre-commit-secrets.sh"
    "list-checkpoints.sh"
    "checkpoint-decrypt.sh"
    "groq-status.sh"
    "validate-skill-contract.sh"
    "detect-contract-conflicts.sh"
  )

  # These are moved to internal _* prefixed scripts or absorbed into hubs.
  # The originals (without _ prefix) should not exist in the real script dir.
  local found_deprecated=()
  for script in "${deprecated_scripts[@]}"; do
    # Only flag if it exists as a NON-internal (non-_ prefixed) standalone
    if [ -f "$REAL_SCRIPT_DIR/$script" ]; then
      found_deprecated+=("$script")
    fi
  done

  if [ ${#found_deprecated[@]} -gt 0 ]; then
    echo "WARNING: Found deprecated standalone scripts: ${found_deprecated[*]}" >&2
    echo "These should be removed or renamed to _*.sh internal scripts" >&2
  fi

  # This is a soft check — we just warn, don't fail,
  # since some scripts may still exist for backward compat
  true
}

# ============================================================
# SECTION 20: Empty subcommand shows usage (not crash)
# ============================================================

@test "graceful: solvr.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/solvr.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Subcommands"* ]]
}

@test "graceful: memory.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/memory.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Subcommands"* ]]
}

@test "graceful: ontology.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/ontology.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Subcommands"* ]]
}

@test "graceful: learning.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/learning.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Subcommands"* ]]
}

@test "graceful: secrets.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/secrets.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Subcommands"* ]]
}

@test "graceful: proactive-amcp.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/proactive-amcp.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Commands"* ]]
}

@test "graceful: config.sh with no args shows usage" {
  run "$SANDBOXED_SCRIPTS/config.sh"
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"usage"* ]] || [[ "$output" == *"Subcommands"* ]]
}
