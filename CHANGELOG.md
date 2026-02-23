# Changelog

## [0.9.0] - 2026-02-23

### Breaking Changes

- **Script consolidation**: Individual scripts have been consolidated into hub commands with subcommands. Direct script paths (e.g., `scripts/full-checkpoint.sh`, `scripts/claude-diagnose.sh`) are deprecated. Use `proactive-amcp.sh <command> [subcommand]` instead.
- See the [Migration from v0.7.x](#migration) section in SKILL.md for the full mapping of old script paths to new commands.

### Consolidated Commands

| New Command | Replaces |
|-------------|----------|
| `checkpoint` (with `--full`, `--auto`, `--smart`, `--trigger` flags) | `checkpoint.sh`, `full-checkpoint.sh`, `auto-checkpoint.sh`, `smart-checkpoint-filter.sh`, `smart-checkpoint-trigger.sh` |
| `diagnose claude\|condense\|failure\|summary\|fix` | `claude-diagnose.sh`, `condense-error.sh`, `detect-failure.py`, `generate-problem-summary.py`, `session-fix.sh` |
| `config backup\|fix\|evaluators` | `backup-config.sh`, `try-fix-config.sh`, `config-evaluators.sh` |
| `solvr register\|heartbeat\|pin\|checkpoint\|resurrect` | `solvr-register.sh`, `solvr-heartbeat.sh`, `pin-to-solvr.sh`, `register-checkpoint-solvr.sh`, `resurrect-from-solvr.sh` |
| `memory prune\|prune-batch\|evolution` | `memory-prune.sh`, `memory-prune-batch.sh`, `memory-evolution.sh` |
| `learning log\|problem\|report` | `learning.py`, `learning-report.py` |
| `ontology validate\|prune\|similarity\|temporal\|contract\|conflicts` | `validate-ontology.py`, `prune-ontology.py`, `compute-entity-similarity.py`, `temporal-queries.py`, `validate-skill-contract.sh`, `detect-contract-conflicts.sh` |
| `secrets scan\|inject\|pre-commit` | `scan-secrets.sh`, `inject-secrets.sh`, `pre-commit-secrets.sh` |

### Backward Compatibility

- Top-level CLI aliases still route to consolidated commands (e.g., `solvr-register` -> `solvr register`, `memory-prune` -> `memory prune`).
- Old direct script calls continue to work but are deprecated and may be removed in a future version.

### Other Changes

- Consolidation test suite added (`test/consolidation-test.sh`) verifying no functionality loss.
- SKILL.md updated with consolidated command reference and migration guide.
- All version references synchronized to 0.9.0.

## [0.8.1] - 2026-02-22

- Internal patch release during consolidation work.

## [0.8.0] - 2026-02-21

- Initial consolidation planning and PRD creation.
- Script consolidation began (tasks 1-10 of prd-consolidation.json).

## [0.7.x] - Prior

- Individual scripts for each operation.
- See git history for detailed changes.
