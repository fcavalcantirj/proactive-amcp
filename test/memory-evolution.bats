#!/usr/bin/env bats
# Integration tests for memory evolution — verify automatic relation inference
#
# Verifies:
# - Similar entities get related_to relations added
# - Evolution log records similarity scores
# - Threshold filtering works
# - Max relations limit respected
# - --dry-run flag prevents updates
# - Evolution chains are traced

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Create ontology directory
  export ONTOLOGY_DIR="$CONTENT_DIR/memory/ontology"
  mkdir -p "$ONTOLOGY_DIR"

  # Evolution log
  export EVOLUTION_LOG="$AMCP_DIR/memory/evolution.jsonl"
  mkdir -p "$(dirname "$EVOLUTION_LOG")"

  # Create valid identity + mock amcp CLI
  create_valid_identity
  create_mock_amcp 0

  # Set env vars for memory-evolution.sh
  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export GRAPH_FILE="$ONTOLOGY_DIR/graph.jsonl"

  # openclaw.json for workspace resolution
  mkdir -p "$OPENCLAW_DIR"
  cat > "$OPENCLAW_DIR/openclaw.json" << EOOC
{"agents": {"defaults": {"workspace": "$CONTENT_DIR"}}}
EOOC
}

teardown() {
  teardown_test_env
}

run_evolution() {
  bash "$REAL_SCRIPT_DIR/memory-evolution.sh" "$@"
}

# Entities with high keyword overlap (combined similarity ~0.88)
create_similar_entities() {
  cat > "$GRAPH_FILE" << 'EOGRAPH'
{"id": "entity_A", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints", "description": "Design patterns for RESTful API endpoints and best practices guide", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}
{"id": "entity_B", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints review", "description": "Design patterns for RESTful API endpoints and best practices review", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}
EOGRAPH
}

# One entity with very different domain (cooking vs API)
create_unrelated_entities() {
  cat > "$GRAPH_FILE" << 'EOGRAPH'
{"id": "entity_A", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints", "description": "Design patterns for RESTful API endpoints and best practices guide", "labels": ["api", "design", "patterns"]}}
{"id": "entity_Z", "type": "entity", "entity_type": "Person", "properties": {"name": "John the Baker", "description": "Expert in baking sourdough bread and pastries on weekends", "labels": ["baking", "cooking", "food"]}}
EOGRAPH
}

# Many similar entities for max-relations testing
create_many_similar_entities() {
  cat > "$GRAPH_FILE" << 'EOGRAPH'
{"id": "entity_target", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints", "description": "Design patterns for RESTful API endpoints and best practices guide", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}
{"id": "entity_1", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints review", "description": "Design patterns for RESTful API endpoints and best practices review", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}
{"id": "entity_2", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints analysis", "description": "Design patterns for RESTful API endpoints and best practices analysis", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}
{"id": "entity_3", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints testing", "description": "Design patterns for RESTful API endpoints and best practices testing", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}
EOGRAPH
}

# ============================================================
# Test 1: Similar entities get related_to relation in graph.jsonl
# ============================================================
@test "evolution adds related_to relation between similar entities" {
  create_similar_entities

  run run_evolution --entity-id entity_B
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # graph.jsonl should have new relations
  local relation_count
  relation_count=$(python3 -c "
import json
count = 0
with open('$GRAPH_FILE') as f:
    for line in f:
        r = json.loads(line.strip())
        if r.get('type') == 'relation' and r.get('relation_type') == 'related_to':
            count += 1
print(count)
")
  # Bidirectional: A->B and B->A
  [ "$relation_count" -ge 2 ]
}

# ============================================================
# Test 2: Evolution log records similarity score >= 0.75
# ============================================================
@test "evolution log contains entry with similarity_score >= 0.75" {
  create_similar_entities

  run run_evolution --entity-id entity_B
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # evolution.jsonl should exist and have entries with good scores
  [ -f "$EVOLUTION_LOG" ]

  local has_good_score
  has_good_score=$(python3 -c "
import json
with open('$EVOLUTION_LOG') as f:
    for line in f:
        entry = json.loads(line.strip())
        if entry.get('similarity_score', 0) >= 0.75:
            print('yes')
            break
" 2>/dev/null || echo 'no')
  [ "$has_good_score" = "yes" ]
}

# ============================================================
# Test 3: Unrelated entity gets no relations added
# ============================================================
@test "no relations added when entities below threshold" {
  create_unrelated_entities

  run run_evolution --entity-id entity_Z
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # No new relations should be added
  local relation_count
  relation_count=$(python3 -c "
import json
count = 0
with open('$GRAPH_FILE') as f:
    for line in f:
        r = json.loads(line.strip())
        if r.get('type') == 'relation':
            count += 1
print(count)
")
  [ "$relation_count" -eq 0 ]

  # Output should mention no similar entities
  [[ "$output" == *"No similar entities above threshold"* ]]
}

# ============================================================
# Test 4: EVOLUTION_THRESHOLD=0.95 prevents moderate matches
# ============================================================
@test "high threshold prevents moderate similarity matches" {
  create_similar_entities

  run run_evolution --entity-id entity_B --threshold 0.95
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # With threshold 0.95, even quite similar entities won't match
  local relation_count
  relation_count=$(python3 -c "
import json
count = 0
with open('$GRAPH_FILE') as f:
    for line in f:
        r = json.loads(line.strip())
        if r.get('type') == 'relation':
            count += 1
print(count)
")
  [ "$relation_count" -eq 0 ]
}

# ============================================================
# Test 5: EVOLUTION_MAX_RELATIONS=1 limits to top-1 match
# ============================================================
@test "max-relations=1 limits to top-1 relation only" {
  create_many_similar_entities

  run run_evolution --entity-id entity_target --max-relations 1
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should add at most 2 relations (1 forward + 1 backward for 1 match)
  local relation_count
  relation_count=$(python3 -c "
import json
count = 0
with open('$GRAPH_FILE') as f:
    for line in f:
        r = json.loads(line.strip())
        if r.get('type') == 'relation' and r.get('relation_type') == 'related_to':
            count += 1
print(count)
")
  # Bidirectional: 1 match = 2 relation lines
  [ "$relation_count" -eq 2 ]
}

# ============================================================
# Test 6: --dry-run prevents evolution.jsonl updates
# ============================================================
@test "dry-run shows what would be linked without modifying files" {
  create_similar_entities

  # Remove evolution log if exists
  rm -f "$EVOLUTION_LOG"

  run run_evolution --entity-id entity_B --dry-run
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Output should mention DRY RUN
  [[ "$output" == *"DRY RUN"* ]]

  # evolution.jsonl should NOT exist or be empty (no modifications)
  if [ -f "$EVOLUTION_LOG" ]; then
    [ ! -s "$EVOLUTION_LOG" ]
  fi

  # graph.jsonl should have NO new relations
  local relation_count
  relation_count=$(python3 -c "
import json
count = 0
with open('$GRAPH_FILE') as f:
    for line in f:
        r = json.loads(line.strip())
        if r.get('type') == 'relation':
            count += 1
print(count)
")
  [ "$relation_count" -eq 0 ]
}

# ============================================================
# Test 7: Evolution chain — C similar to B similar to A
# ============================================================
@test "evolution chain traces entity relationships across runs" {
  create_similar_entities

  # Evolve B — should link to A
  run run_evolution --entity-id entity_B
  [ "$status" -eq 0 ]

  # Verify evolution log has B
  [ -f "$EVOLUTION_LOG" ]

  # Add entity C (similar to both A and B)
  echo '{"id": "entity_C", "type": "entity", "entity_type": "Task", "properties": {"name": "API design patterns for endpoints summary", "description": "Design patterns for RESTful API endpoints and best practices summary", "labels": ["api", "design", "patterns", "rest", "endpoints"]}}' >> "$GRAPH_FILE"

  # Evolve C — should link to existing entities
  run run_evolution --entity-id entity_C
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Evolution log should have entries from both runs
  local chain_count
  chain_count=$(wc -l < "$EVOLUTION_LOG")
  [ "$chain_count" -ge 2 ]

  # Should have both entity_B and entity_C as trigger entities
  local has_b has_c
  has_b=$(python3 -c "
import json
with open('$EVOLUTION_LOG') as f:
    for line in f:
        entry = json.loads(line.strip())
        if entry.get('trigger_entity_id') == 'entity_B':
            print('yes')
            break
" 2>/dev/null || echo 'no')
  has_c=$(python3 -c "
import json
with open('$EVOLUTION_LOG') as f:
    for line in f:
        entry = json.loads(line.strip())
        if entry.get('trigger_entity_id') == 'entity_C':
            print('yes')
            break
" 2>/dev/null || echo 'no')
  [ "$has_b" = "yes" ]
  [ "$has_c" = "yes" ]
}
