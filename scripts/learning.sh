#!/bin/bash
# learning.sh — Consolidated learning and problem management wrapper
#
# Subcommands:
#   problem        Problem CRUD: create, update, get, list, close
#   log            Learning CRUD: create, verify, get, list, check-unverified
#   report         Generate human-readable learning metrics report
#
# Usage:
#   learning.sh problem create --description "..." [--blocker] [--source SOURCE]
#   learning.sh problem update --id ID [--field KEY=VALUE ...]
#   learning.sh problem get --id ID
#   learning.sh problem list [--status STATUS]
#   learning.sh problem close --id ID --status STATUS [--solution "..."]
#
#   learning.sh log create --insight "..." [--source-problem ID] [--tags TAG,TAG]
#   learning.sh log verify --id ID [--human-verified]
#   learning.sh log get --id ID
#   learning.sh log list [--confidence LEVEL] [--tag TAG]
#   learning.sh log check-unverified [--days N]
#
#   learning.sh report [--output FILE] [--learning-dir DIR] [--json]
#
# Backward compat: direct learning actions (create, verify, get, list)
# are passed through to learning.py learning.
#
# Python files (learning.py, learning-report.py) are kept as the
# implementation — this script is a thin dispatcher.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")" && pwd)"

usage() {
  cat <<EOF
proactive-amcp learning — Problem and learning management

Usage: $(basename "$0") <subcommand> [args...]

Subcommands:
  problem        Problem CRUD: create, update, get, list, close
  log            Learning CRUD: create, verify, get, list, check-unverified
  report         Generate human-readable learning metrics report

Options:
  -h, --help     Show this help

Problem actions:
  create         Create a new problem (--description, --blocker, --source)
  update         Update a problem (--id, --field KEY=VALUE)
  get            Get a problem by ID (--id)
  list           List problems (--status open|stuck|solved|abandoned)
  close          Close a problem (--id, --status solved|abandoned, --solution)

Learning (log) actions:
  create         Create a new learning (--insight, --source-problem, --tags)
  verify         Verify a learning (--id, --human-verified)
  get            Get a learning by ID (--id)
  list           List learnings (--confidence tentative|verified, --tag)
  check-unverified  Check for stale unverified learnings (--days N)

Report options:
  --output FILE       Write report to file (default: stdout)
  --learning-dir DIR  Override learning directory
  --json              Output raw JSON metrics

Examples:
  $(basename "$0") problem create --description "Auth fails on retry"
  $(basename "$0") problem close --id prob_abc123 --status solved --solution "Need cookie auth"
  $(basename "$0") log create --insight "AgentMail uses v0 API not v1"
  $(basename "$0") log create --insight "Need cookie auth" --source-problem prob_abc123
  $(basename "$0") log list --confidence verified
  $(basename "$0") report --json

Run '$(basename "$0") <subcommand> --help' for details.
EOF
  exit 1
}

case "${1:-}" in
  problem)
    shift
    exec python3 "$SCRIPT_DIR/learning.py" problem "$@"
    ;;
  log)
    shift
    exec python3 "$SCRIPT_DIR/learning.py" learning "$@"
    ;;
  report)
    shift
    exec python3 "$SCRIPT_DIR/learning-report.py" "$@"
    ;;
  # Backward compat: direct learning actions pass through to learning.py learning
  create|verify|get|list|check-unverified)
    exec python3 "$SCRIPT_DIR/learning.py" learning "$@"
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
