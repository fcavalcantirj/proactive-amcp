#!/usr/bin/env bats
# Integration tests for ontology checkpoint — verify graph.jsonl roundtrip
#
# Verifies:
# - Staging includes ontology directory
# - last-checkpoint.json has ontologyGraphCID
# - validate-ontology.py called on resurrection
# - Corrupt graph logged but resurrection completes
# - Missing ontology — backward compatible
# - CID computation is deterministic

REAL_SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/scripts"
HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"

setup() {
  source "$HELPER"
  setup_test_env

  # Sandbox scripts
  export SANDBOXED_SCRIPTS="$TEST_DIR/scripts"
  mkdir -p "$SANDBOXED_SCRIPTS"
  for f in checkpoint.sh _checkpoint-full.sh _secrets-scan.sh validate-ontology.py; do
    if [ -f "$REAL_SCRIPT_DIR/$f" ]; then
      cp "$REAL_SCRIPT_DIR/$f" "$SANDBOXED_SCRIPTS/"
      chmod +x "$SANDBOXED_SCRIPTS/$f"
    fi
  done

  # Mock notify.sh
  cat > "$SANDBOXED_SCRIPTS/notify.sh" << 'EONOTIFY'
#!/bin/bash
echo "[NOTIFY] $*" >> "${HOME}/.amcp/notifications.log"
EONOTIFY
  chmod +x "$SANDBOXED_SCRIPTS/notify.sh"

  # Mock amcp CLI
  cat > "$MOCK_BIN/amcp" << 'EOAMCP'
#!/bin/bash
if [ "$1" = "identity" ] && [ "$2" = "validate" ]; then
  exit 0
fi
if [ "$1" = "checkpoint" ] && [ "$2" = "create" ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = "--out" ]; then
      echo '{"checkpoint":"mock"}' > "$2"
      break
    fi
    shift
  done
  exit 0
fi
exit 0
EOAMCP
  chmod +x "$MOCK_BIN/amcp"

  # Mock curl (Pinata upload)
  cat > "$MOCK_BIN/curl" << 'EOCURL'
#!/bin/bash
echo '{"IpfsHash":"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"}'
exit 0
EOCURL
  chmod +x "$MOCK_BIN/curl"

  # Mock rsync
  cat > "$MOCK_BIN/rsync" << 'EORSYNC'
#!/bin/bash
SRC=""
DEST=""
for arg in "$@"; do
  case "$arg" in
    --exclude=*|-a|--info=*) ;;
    *)
      if [ -z "$SRC" ]; then
        SRC="$arg"
      else
        DEST="$arg"
      fi
      ;;
  esac
done
if [ -n "$SRC" ] && [ -n "$DEST" ]; then
  mkdir -p "$DEST"
  if [ -d "${SRC%/}" ]; then
    cp -a "${SRC%/}/." "$DEST/" 2>/dev/null || true
  fi
fi
exit 0
EORSYNC
  chmod +x "$MOCK_BIN/rsync"

  # Valid identity
  create_valid_identity

  # AMCP config
  cat > "$AMCP_DIR/config.json" << 'EOCONFIG'
{
  "pinata": {
    "jwt": "eyJhbGciOiJIUzI1NiJ9.test.pinata_jwt_value"
  }
}
EOCONFIG
  chmod 600 "$AMCP_DIR/config.json"

  # openclaw.json
  mkdir -p "$OPENCLAW_DIR"
  python3 -c "
import json
cfg = {
  'gateway': {'port': 18789},
  'agents': {'defaults': {'workspace': '$CONTENT_DIR'}}
}
with open('$OPENCLAW_DIR/openclaw.json', 'w') as f:
    json.dump(cfg, f)
"

  # Create clean workspace
  mkdir -p "$CONTENT_DIR"
  echo "# Hello" > "$CONTENT_DIR/README.md"

  # Set env vars
  export AMCP_CLI="$MOCK_BIN/amcp"
  export IDENTITY_PATH="$AMCP_DIR/identity.json"
  export CHECKPOINT_DIR="$AMCP_DIR/checkpoints"
  export KEEP_CHECKPOINTS=5
}

teardown() {
  teardown_test_env
}

run_checkpoint() {
  bash "$SANDBOXED_SCRIPTS/checkpoint.sh" --full "$@"
}

create_sample_graph() {
  mkdir -p "$CONTENT_DIR/memory/ontology"
  cat > "$CONTENT_DIR/memory/ontology/graph.jsonl" << 'EOGRAPH'
{"id": "person_1", "type": "entity", "entity_type": "Person", "properties": {"name": "Alice"}, "created": "2026-01-01T00:00:00Z", "updated": "2026-01-01T00:00:00Z"}
{"id": "person_2", "type": "entity", "entity_type": "Person", "properties": {"name": "Bob"}, "created": "2026-01-01T00:00:00Z", "updated": "2026-01-01T00:00:00Z"}
{"id": "task_1", "type": "entity", "entity_type": "Task", "properties": {"name": "Build API"}, "created": "2026-01-01T00:00:00Z", "updated": "2026-01-01T00:00:00Z"}
{"type": "relation", "from_id": "person_1", "relation_type": "assigned_to", "to_id": "task_1"}
EOGRAPH
}

# ============================================================
# Test 1: Staging includes ontology directory
# ============================================================
@test "checkpoint with ontology includes memory/ontology/ in staging" {
  create_sample_graph

  run run_checkpoint
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Output should mention ontology
  [[ "$output" == *"ontology"* ]] || [[ "$output" == *"Ontology"* ]] || [[ "$output" == *"JSONL"* ]]
}

# ============================================================
# Test 2: last-checkpoint.json includes ontologyGraphCID
# ============================================================
@test "last-checkpoint.json includes ontologyGraphCID when ontology present" {
  create_sample_graph

  run run_checkpoint
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # last-checkpoint.json should have ontologyGraphCID
  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  local ontology_cid
  ontology_cid=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print(d.get('ontologyGraphCID',''))")
  [ -n "$ontology_cid" ]

  # CID should start with 'b' (base32 multibase prefix)
  [[ "$ontology_cid" == b* ]]
}

# ============================================================
# Test 3: validate-ontology.py validates graph correctly
# ============================================================
@test "validate-ontology.py validates valid graph successfully" {
  create_sample_graph

  run python3 "$SANDBOXED_SCRIPTS/validate-ontology.py" "$CONTENT_DIR/memory/ontology/graph.jsonl"
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # Output should indicate valid
  local valid
  valid=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)['valid'])")
  [ "$valid" = "True" ]

  # Should report correct counts
  local entity_count
  entity_count=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)['entity_count'])")
  [ "$entity_count" -eq 3 ]

  local relation_count
  relation_count=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)['relation_count'])")
  [ "$relation_count" -eq 1 ]
}

# ============================================================
# Test 4: Corrupt graph logs warning but validation completes
# ============================================================
@test "corrupt graph reports errors but does not crash" {
  mkdir -p "$CONTENT_DIR/memory/ontology"
  cat > "$CONTENT_DIR/memory/ontology/graph.jsonl" << 'EOGRAPH'
{"id": "person_1", "type": "entity", "entity_type": "Person", "properties": {"name": "Alice"}}
{"id": "task_1", "type": "entity", "entity_type": "Task", "properties": {"name": "Build API"}}
this is not valid json on line 3
{"type": "relation", "from_id": "person_1", "relation_type": "assigned_to", "to_id": "nonexistent_entity"}
EOGRAPH

  run python3 "$SANDBOXED_SCRIPTS/validate-ontology.py" "$CONTENT_DIR/memory/ontology/graph.jsonl"
  echo "OUTPUT: $output"
  # Should exit 1 (invalid) but not crash
  [ "$status" -eq 1 ]

  # Should report errors
  local valid
  valid=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)['valid'])")
  [ "$valid" = "False" ]

  # Should have error about invalid JSON
  [[ "$output" == *"invalid JSON"* ]]
}

# ============================================================
# Test 5: No ontology — backward compatible
# ============================================================
@test "checkpoint without ontology has no ontologyGraphCID" {
  # No ontology directory created — just workspace with README.md

  run run_checkpoint
  echo "OUTPUT: $output"
  [ "$status" -eq 0 ]

  # last-checkpoint.json should exist but WITHOUT ontologyGraphCID
  [ -f "$AMCP_DIR/last-checkpoint.json" ]
  local ontology_cid
  ontology_cid=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print(d.get('ontologyGraphCID',''))")
  [ -z "$ontology_cid" ]
}

# ============================================================
# Test 6: CID computation is deterministic
# ============================================================
@test "same graph content produces identical CID across runs" {
  create_sample_graph

  # First checkpoint
  run run_checkpoint
  [ "$status" -eq 0 ]
  local cid1
  cid1=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print(d.get('ontologyGraphCID',''))")

  # Second checkpoint (same graph, unchanged)
  run run_checkpoint
  [ "$status" -eq 0 ]
  local cid2
  cid2=$(python3 -c "import json; d=json.load(open('$AMCP_DIR/last-checkpoint.json')); print(d.get('ontologyGraphCID',''))")

  # CIDs should be identical
  [ "$cid1" = "$cid2" ]
  [ -n "$cid1" ]
}
