#!/usr/bin/env bats
# Integration tests for temporal queries — cross-checkpoint entity history
#
# Verifies:
# - Multi-version entity history across checkpoints
# - Time-range filtering
# - Full chronological timeline
# - Single-entry history
# - Non-existent entity graceful handling
# - Missing index graceful degradation
# - Backward compatibility without ontology
# - Date-based snapshot query

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Ontology directory
  export ONTOLOGY_DIR="$CONTENT_DIR/memory/ontology"
  mkdir -p "$ONTOLOGY_DIR"

  # Temporal index
  export TEMPORAL_INDEX_PATH="$AMCP_DIR/memory/temporal-index.jsonl"
  mkdir -p "$(dirname "$TEMPORAL_INDEX_PATH")"

  # Graph path
  export GRAPH_PATH="$ONTOLOGY_DIR/graph.jsonl"

  # openclaw.json
  mkdir -p "$OPENCLAW_DIR"
  python3 -c "
import json
with open('$OPENCLAW_DIR/openclaw.json', 'w') as f:
    json.dump({'agents': {'defaults': {'workspace': '$CONTENT_DIR'}}}, f)
"
}

teardown() {
  teardown_test_env
}

run_temporal() {
  python3 "$REAL_SCRIPT_DIR/temporal-queries.py" "$@"
}

create_entity_v1() {
  cat > "$GRAPH_PATH" << 'EOGRAPH'
{"id": "entity_123", "type": "entity", "entity_type": "Task", "properties": {"name": "Build API", "status": "open", "version": "1.0"}, "created": "2026-02-10T08:00:00Z", "updated": "2026-02-10T08:00:00Z"}
{"id": "entity_456", "type": "entity", "entity_type": "Person", "properties": {"name": "Alice"}, "created": "2026-02-10T08:00:00Z", "updated": "2026-02-10T08:00:00Z"}
EOGRAPH
}

create_entity_v2() {
  cat > "$GRAPH_PATH" << 'EOGRAPH'
{"id": "entity_123", "type": "entity", "entity_type": "Task", "properties": {"name": "Build API", "status": "done", "version": "2.0"}, "created": "2026-02-10T08:00:00Z", "updated": "2026-02-15T10:00:00Z"}
{"id": "entity_456", "type": "entity", "entity_type": "Person", "properties": {"name": "Alice"}, "created": "2026-02-10T08:00:00Z", "updated": "2026-02-10T08:00:00Z"}
EOGRAPH
}

# ============================================================
# Test 1: Two versions across checkpoints
# ============================================================
@test "entity with 2 versions across checkpoints returns both" {
  # Checkpoint 1: entity_123 v1
  create_entity_v1
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"

  # Checkpoint 2: entity_123 v2 (modified)
  create_entity_v2
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint2" --timestamp "2026-02-15T10:00:00Z"

  # Query full range covering both
  run run_temporal query entity_123 --start "2026-02-01" --end "2026-02-28"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should return 2 versions
  local count
  count=$(echo "$output" | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
  [ "$count" -eq 2 ]
}

# ============================================================
# Test 2: Time filtering — start after checkpoint-1
# ============================================================
@test "time-range filter returns only matching versions" {
  # Build two checkpoint indexes
  create_entity_v1
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"

  create_entity_v2
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint2" --timestamp "2026-02-15T10:00:00Z"

  # Query starting AFTER checkpoint-1
  run run_temporal query entity_123 --start "2026-02-12"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should return only checkpoint-2 version
  local count
  count=$(echo "$output" | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
  [ "$count" -eq 1 ]

  # Verify it's the v2 version
  local cid
  cid=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['checkpoint_cid'])")
  [ "$cid" = "bafkreiCheckpoint2" ]
}

# ============================================================
# Test 3: Full history ordered chronologically
# ============================================================
@test "history returns full timeline ordered by timestamp" {
  # Build two checkpoint indexes
  create_entity_v1
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"

  create_entity_v2
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint2" --timestamp "2026-02-15T10:00:00Z"

  run run_temporal history entity_123
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should return 2 entries
  local count
  count=$(echo "$output" | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
  [ "$count" -eq 2 ]

  # First entry should be older (checkpoint-1)
  local first_ts second_ts
  first_ts=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['timestamp'])")
  second_ts=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)[1]['timestamp'])")
  [[ "$first_ts" < "$second_ts" ]]
}

# ============================================================
# Test 4: Single entry for unmodified entity
# ============================================================
@test "entity created once shows single history entry" {
  create_entity_v1
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"

  # Don't modify — build same index again (should skip unchanged)
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint2" --timestamp "2026-02-15T10:00:00Z"

  run run_temporal history entity_456
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # entity_456 was never modified, so only 1 entry
  local count
  count=$(echo "$output" | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
  [ "$count" -eq 1 ]
}

# ============================================================
# Test 5: Non-existent entity returns empty (no error)
# ============================================================
@test "non-existent entity returns empty result" {
  create_entity_v1
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"

  run run_temporal history nonexistent_entity_999
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Output should indicate no history, not error
  [[ "$output" == *"No history"* ]]
}

# ============================================================
# Test 6: Missing temporal index — graceful degradation
# ============================================================
@test "missing temporal index degrades to current graph only" {
  # No temporal index built — but graph exists
  create_entity_v1
  rm -f "$TEMPORAL_INDEX_PATH"

  run run_temporal history entity_123
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should still return the current entity from graph.jsonl (Level 1)
  local count
  count=$(echo "$output" | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
  [ "$count" -eq 1 ]

  # Should be tagged as "current"
  local cid
  cid=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['checkpoint_cid'])")
  [ "$cid" = "current" ]
}

# ============================================================
# Test 7: No ontology — backward compatible
# ============================================================
@test "build-index with no ontology does not break" {
  # No graph.jsonl exists
  rm -f "$GRAPH_PATH"

  run run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should report no graph found
  [[ "$output" == *"No graph"* ]]

  # Temporal index should not be created
  [ ! -f "$TEMPORAL_INDEX_PATH" ] || [ ! -s "$TEMPORAL_INDEX_PATH" ]
}

# ============================================================
# Test 8: Date-based snapshot query
# ============================================================
@test "query entities that existed on 2026-02-15" {
  # entity_123 created 2026-02-10, modified 2026-02-15
  create_entity_v1
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint1" --timestamp "2026-02-10T08:00:00Z"

  create_entity_v2
  run_temporal build-index --graph "$GRAPH_PATH" --cid "bafkreiCheckpoint2" --timestamp "2026-02-15T10:00:00Z"

  # Query for entities on exactly 2026-02-15
  run run_temporal query entity_123 --start "2026-02-15" --end "2026-02-15"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Should return the v2 snapshot from that date
  local count
  count=$(echo "$output" | python3 -c "import json,sys; data=json.load(sys.stdin); print(len(data))")
  [ "$count" -eq 1 ]

  # Verify the snapshot is from checkpoint-2
  local cid
  cid=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['checkpoint_cid'])")
  [ "$cid" = "bafkreiCheckpoint2" ]
}
