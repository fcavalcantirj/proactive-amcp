#!/bin/bash
# ontology.sh — Consolidated ontology management tool (Advanced)
#
# Subcommands:
#   validate     Schema validation for JSONL ontology graph
#   prune        Typed pruning policies per entity type
#   similarity   Compute entity similarity for relation inference
#   temporal     Cross-checkpoint entity history queries
#   contract     Validate skill ontology contracts against graph.jsonl
#   conflicts    Detect cross-skill ontology contract conflicts
#
# Usage:
#   ontology.sh validate [--graph <path>]
#   ontology.sh prune [--dry-run] [--config FILE] [--graph FILE]
#   ontology.sh similarity --graph FILE --entity-id ID [--threshold 0.75] [--max-relations 3]
#   ontology.sh temporal history|query|build-index [args...]
#   ontology.sh contract <skill-name> [--graph <path>] [--skills-dir <path>] [--json]
#   ontology.sh contract --contract <file.json> [--graph <path>] [--json]
#   ontology.sh conflicts [--skills-dir <path>] [--json]
#
# Advanced: These commands provide semantic validation, temporal queries, and
# knowledge graph management for the AMCP ontology layer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"

# Shared defaults
CONTENT_DIR="${CONTENT_DIR:-$HOME/.openclaw/workspace}"
GRAPH_PATH="${GRAPH_PATH:-$CONTENT_DIR/memory/ontology/graph.jsonl}"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.openclaw/skills}"

usage() {
  cat <<EOF
ontology — AMCP ontology management (Advanced)

Usage: $(basename "$0") <subcommand> [args...]

Subcommands:
  validate     Schema validation for JSONL ontology graph
  prune        Typed pruning policies per entity type
  similarity   Compute entity similarity for relation inference
  temporal     Cross-checkpoint entity history queries
  contract     Validate skill ontology contracts against graph.jsonl
  conflicts    Detect cross-skill ontology contract conflicts

Options:
  -h, --help   Show this help

Validate options:
  <graph.jsonl>          Path to graph file (positional)
  --graph <path>         Path to graph file (flag)

Prune options:
  --dry-run              Preview without changes
  --config FILE          Override config path
  --graph FILE           Override graph path

Similarity options:
  --graph FILE           Path to graph.jsonl (required)
  --entity-id ID         Target entity ID (required)
  --threshold FLOAT      Similarity threshold (default: 0.75)
  --max-relations N      Max relations to infer (default: 3)

Temporal subcommands:
  history <entity_id>
  query <entity_id> --start YYYY-MM-DD --end YYYY-MM-DD
  build-index --graph <path> --cid <checkpoint_cid>

Contract options:
  <skill-name>           Skill to validate
  --contract <file>      Direct contract JSON file
  --graph <path>         Override graph path
  --skills-dir <path>    Override skills directory
  --json                 JSON output

Conflicts options:
  --skills-dir <path>    Override skills directory
  --json                 JSON output

Examples:
  $(basename "$0") validate ~/.openclaw/workspace/memory/ontology/graph.jsonl
  $(basename "$0") prune --dry-run
  $(basename "$0") similarity --graph graph.jsonl --entity-id ent_123
  $(basename "$0") temporal history entity_abc
  $(basename "$0") contract my-skill --json
  $(basename "$0") conflicts --json

Run '$(basename "$0") <subcommand> --help' for details.
EOF
  exit 1
}

# ============================================================
# Subcommand: contract
# Absorbed from validate-skill-contract.sh
# ============================================================
do_contract() {
  local graph_path="$GRAPH_PATH"
  local skills_dir="$SKILLS_DIR"
  local json_output=false
  local contract_file=""
  local skill_name=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --graph) graph_path="$2"; shift 2 ;;
      --skills-dir) skills_dir="$2"; shift 2 ;;
      --contract) contract_file="$2"; shift 2 ;;
      --json) json_output=true; shift ;;
      -h|--help)
        cat <<EOF
ontology contract — Validate skill ontology contracts against graph.jsonl

Usage:
  $(basename "$0") contract <skill-name> [options]
  $(basename "$0") contract --contract <contract.json> [options]

Options:
  --graph <path>       Path to graph.jsonl (default: \$CONTENT_DIR/memory/ontology/graph.jsonl)
  --skills-dir <path>  Path to skills directory (default: ~/.openclaw/skills)
  --contract <path>    Direct contract JSON file (bypasses skill lookup)
  --json               Output results as JSON
  -h, --help           Show this help
EOF
        exit 0
        ;;
      -*) echo "ERROR: Unknown option '$1'" >&2; exit 1 ;;
      *)
        if [ -z "$skill_name" ]; then
          skill_name="$1"
        fi
        shift
        ;;
    esac
  done

  if [ -z "$skill_name" ] && [ -z "$contract_file" ]; then
    echo "ERROR: Provide a skill name or --contract <file>" >&2
    exit 1
  fi

  # Resolve contract source
  local contract_source=""
  if [ -n "$contract_file" ]; then
    if [ ! -f "$contract_file" ]; then
      echo "ERROR: Contract file not found: $contract_file" >&2
      exit 1
    fi
    contract_source="$contract_file"
  elif [ -f "$skills_dir/$skill_name/skill.json" ]; then
    contract_source="$skills_dir/$skill_name/skill.json"
  else
    # No skill.json — backward compatible, skip
    if $json_output; then
      echo '{"valid": true, "skipped": true, "reason": "no skill.json found"}'
    else
      echo "SKIP: ${skill_name} has no skill.json — validation skipped"
    fi
    exit 0
  fi

  # Run validation via python3 with env vars
  export _CONTRACT_SOURCE="$contract_source"
  export _GRAPH_PATH="$graph_path"
  export _JSON_OUTPUT="$json_output"
  export _SKILL_NAME="${skill_name:-}"
  export _IS_DIRECT_CONTRACT="${contract_file:+true}"

  exec python3 "$SCRIPT_DIR/validate-skill-contract.py"
}

# ============================================================
# Subcommand: conflicts
# Absorbed from detect-contract-conflicts.sh
# ============================================================
do_conflicts() {
  local skills_dir="$SKILLS_DIR"
  local json_output=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --skills-dir) skills_dir="$2"; shift 2 ;;
      --json) json_output=true; shift ;;
      -h|--help)
        cat <<EOF
ontology conflicts — Detect cross-skill ontology contract conflicts

Usage:
  $(basename "$0") conflicts [options]

Options:
  --skills-dir <path>  Path to skills directory (default: ~/.openclaw/skills)
  --json               Output results as JSON
  -h, --help           Show this help
EOF
        exit 0
        ;;
      -*) echo "ERROR: Unknown option '$1'" >&2; exit 1 ;;
      *) shift ;;
    esac
  done

  export _SKILLS_DIR="$skills_dir"
  export _JSON_OUTPUT="$json_output"

  exec python3 "$SCRIPT_DIR/detect-contract-conflicts.py"
}

# ============================================================
# Dispatch
# ============================================================
case "${1:-}" in
  validate)
    shift
    exec python3 "$SCRIPT_DIR/validate-ontology.py" "$@"
    ;;
  prune)
    shift
    exec python3 "$SCRIPT_DIR/prune-ontology.py" "$@"
    ;;
  similarity)
    shift
    exec python3 "$SCRIPT_DIR/compute-entity-similarity.py" "$@"
    ;;
  temporal)
    shift
    exec python3 "$SCRIPT_DIR/temporal-queries.py" "$@"
    ;;
  contract)
    shift
    do_contract "$@"
    ;;
  conflicts)
    shift
    do_conflicts "$@"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    echo "ERROR: Unknown subcommand '${1}'" >&2
    echo "" >&2
    usage
    ;;
esac
