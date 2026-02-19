#!/usr/bin/env bats
# skill-contract.bats — Integration tests for ontology contract validation
# Tests: precondition checking, conflict detection, backward compatibility

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env
  create_mock_amcp 0
  create_valid_identity
  export AMCP_CLI="$MOCK_BIN/amcp"

  # Create skills directory and ontology directory
  export SKILLS_DIR="$TEST_DIR/skills"
  export GRAPH_DIR="$CONTENT_DIR/memory/ontology"
  mkdir -p "$SKILLS_DIR" "$GRAPH_DIR"
}

teardown() {
  source "$HELPER"
  teardown_test_env
}

# Helper: create a skill.json with ontologyContract
create_skill_with_contract() {
  local skill_name="$1"
  local contract_json="$2"
  mkdir -p "$SKILLS_DIR/$skill_name"
  cat > "$SKILLS_DIR/$skill_name/skill.json" << EOSKILL
{
  "name": "$skill_name",
  "ontologyContract": $contract_json
}
EOSKILL
}

# Helper: create a skill.json WITHOUT ontologyContract
create_skill_without_contract() {
  local skill_name="$1"
  mkdir -p "$SKILLS_DIR/$skill_name"
  cat > "$SKILLS_DIR/$skill_name/skill.json" << 'EOSKILL'
{
  "name": "plain-skill",
  "description": "A skill with no ontology contract"
}
EOSKILL
}

# Test 1: Precondition satisfied — all Tasks have assignee
@test "precondition satisfied: all Tasks have assignee property" {
  cat > "$GRAPH_DIR/graph.jsonl" << 'EOF'
{"type": "Task", "id": "task-1", "properties": {"assignee": "alice", "status": "open"}}
{"type": "Task", "id": "task-2", "properties": {"assignee": "bob", "status": "done"}}
{"type": "Person", "id": "person-1", "properties": {"name": "alice"}}
EOF

  create_skill_with_contract "task-manager" '{
    "skill_name": "task-manager",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task", "Person"],
      "writes": ["Task", "Action"],
      "preconditions": ["Task.assignee exists"],
      "postconditions": ["Task.status is valid enum"]
    }
  }'

  run bash "$REAL_SCRIPT_DIR/validate-skill-contract.sh" task-manager \
    --graph "$GRAPH_DIR/graph.jsonl" --skills-dir "$SKILLS_DIR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"PASS"* ]]
  [[ "$output" == *"task-manager"* ]]
}

# Test 2: Precondition violated — some Tasks missing assignee
@test "precondition violated: Tasks missing assignee fails with error" {
  cat > "$GRAPH_DIR/graph.jsonl" << 'EOF'
{"type": "Task", "id": "task-1", "properties": {"assignee": "alice", "status": "open"}}
{"type": "Task", "id": "task-bad", "properties": {"status": "open"}}
{"type": "Person", "id": "person-1", "properties": {"name": "alice"}}
EOF

  create_skill_with_contract "task-manager" '{
    "skill_name": "task-manager",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task", "Person"],
      "writes": ["Task"],
      "preconditions": ["Task.assignee exists"],
      "postconditions": []
    }
  }'

  run bash "$REAL_SCRIPT_DIR/validate-skill-contract.sh" task-manager \
    --graph "$GRAPH_DIR/graph.jsonl" --skills-dir "$SKILLS_DIR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"task-bad"* ]]
  [[ "$output" == *"assignee"* ]]
}

# Test 3: reads declares Task but graph has no Task entities
@test "reads check: no Task entities in graph fails validation" {
  cat > "$GRAPH_DIR/graph.jsonl" << 'EOF'
{"type": "Person", "id": "person-1", "properties": {"name": "alice"}}
EOF

  create_skill_with_contract "task-reader" '{
    "skill_name": "task-reader",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task"],
      "writes": [],
      "preconditions": [],
      "postconditions": []
    }
  }'

  run bash "$REAL_SCRIPT_DIR/validate-skill-contract.sh" task-reader \
    --graph "$GRAPH_DIR/graph.jsonl" --skills-dir "$SKILLS_DIR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]]
  [[ "$output" == *"Task"* ]]
  [[ "$output" == *"no entities"* ]]
}

# Test 4: Postcondition verification via JSON output (writes: Action, graph has Action)
@test "writes declared: Action type present, verified via JSON output" {
  cat > "$GRAPH_DIR/graph.jsonl" << 'EOF'
{"type": "Task", "id": "task-1", "properties": {"assignee": "alice", "status": "done"}}
{"type": "Action", "id": "action-1", "properties": {"type": "complete", "target": "task-1"}}
EOF

  create_skill_with_contract "action-writer" '{
    "skill_name": "action-writer",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task"],
      "writes": ["Action"],
      "preconditions": [],
      "postconditions": ["Task.status is valid enum"]
    }
  }'

  run bash "$REAL_SCRIPT_DIR/validate-skill-contract.sh" action-writer \
    --graph "$GRAPH_DIR/graph.jsonl" --skills-dir "$SKILLS_DIR" --json

  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data['valid'] == True, f'Expected valid=True, got {data}'
assert 'Action' in data['writes'], f'Action not in writes: {data}'
assert 'Action' in data['entity_types_found'], f'Action not in entity_types_found: {data}'
"
}

# Test 5: Conflicting postconditions detected
@test "conflict detection: == vs != on same field detected" {
  create_skill_with_contract "skill-a" '{
    "skill_name": "skill-a",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task"],
      "writes": ["Task"],
      "preconditions": [],
      "postconditions": ["Task.priority == high"]
    }
  }'

  create_skill_with_contract "skill-b" '{
    "skill_name": "skill-b",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task"],
      "writes": ["Task"],
      "preconditions": [],
      "postconditions": ["Task.priority != high"]
    }
  }'

  run bash "$REAL_SCRIPT_DIR/detect-contract-conflicts.sh" --skills-dir "$SKILLS_DIR"

  [ "$status" -eq 1 ]
  [[ "$output" == *"CONFLICTS FOUND"* ]]
  [[ "$output" == *"skill-a"* ]]
  [[ "$output" == *"skill-b"* ]]
  [[ "$output" == *"priority"* ]]
}

# Test 6: Invalid contract JSON rejected
@test "invalid contract JSON rejected with error" {
  echo "not valid json {{{" > "$TEST_DIR/bad-contract.json"

  run bash "$REAL_SCRIPT_DIR/validate-skill-contract.sh" \
    --contract "$TEST_DIR/bad-contract.json" \
    --graph "$GRAPH_DIR/graph.jsonl"

  [ "$status" -eq 1 ]
}

# Test 7: Skill without ontologyContract — backward compatible skip
@test "no ontologyContract field: validation skipped gracefully" {
  create_skill_without_contract "plain-skill"

  run bash "$REAL_SCRIPT_DIR/validate-skill-contract.sh" plain-skill \
    --graph "$GRAPH_DIR/graph.jsonl" --skills-dir "$SKILLS_DIR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP"* ]] || [[ "$output" == *"skip"* ]] || [[ "$output" == *"no ontology contract"* ]]
}

# Test 8: Compatible reads/writes — no conflict
@test "compatible reads/writes: no conflict between writer and reader" {
  create_skill_with_contract "writer-skill" '{
    "skill_name": "writer-skill",
    "version": "1.0.0",
    "ontology": {
      "reads": [],
      "writes": ["Task"],
      "preconditions": [],
      "postconditions": ["Task.status == open"]
    }
  }'

  create_skill_with_contract "reader-skill" '{
    "skill_name": "reader-skill",
    "version": "1.0.0",
    "ontology": {
      "reads": ["Task"],
      "writes": [],
      "preconditions": [],
      "postconditions": []
    }
  }'

  run bash "$REAL_SCRIPT_DIR/detect-contract-conflicts.sh" --skills-dir "$SKILLS_DIR"

  [ "$status" -eq 0 ]
  [[ "$output" == *"No conflicts"* ]]
}
