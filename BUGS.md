# Bugs Fixed — 2026-02-14

## BUG 1 (CRITICAL): inject-secrets.sh — First Python block crashes, secrets never injected

**Root cause:** Two duplicate Python heredoc blocks. The first used a single-quoted heredoc (`<< 'EOF'`) and tried to read `SECRETS_FILE` from `os.environ`, but it was a bash variable, never exported. `open("")` raised `FileNotFoundError`. With `set -euo pipefail`, the script died immediately. The `export` statements and the working second Python block (which used bash interpolation) were never reached.

**Impact:** During resurrection, `resuscitate.sh` called `inject-secrets.sh`, which crashed silently (swallowed by `|| true`). The agent came back without API keys, Solvr credentials, or any secrets — alive but functionally broken.

**Fix:** Removed the broken first Python block and orphaned `export` statements. Kept the working second block with bash-interpolated heredoc (`<< PYEOF`), which receives `$SECRETS_FILE`, `$BACKUP_DIR`, and `$SYSTEMD_ENV_FILE` directly.

## BUG 2: watchdog.sh — No resurrection retry

**Root cause:** The watchdog only launched resurrection on the first transition to DEAD (`if [ "$current_state" != "DEAD" ]`). If resurrection failed, state stayed DEAD and the guard prevented ever re-launching. Agent stuck forever.

**Fix:** Added exponential backoff retry: after resurrection fails and lock file clears, the watchdog retries after a configurable delay (5min initial, doubling up to 30min). Tracks `lastResurrectionAttempt` and `retryDelay` in state file.

## BUG 3: watchdog.sh — Fire-and-forget resurrection

**Root cause:** Resurrection launched with `&` (background), no PID tracking, no lock file. No way to detect if resurrection was running, succeeded, or crashed.

**Fix:** Added `LOCK_FILE` (`$HOME/.amcp/resurrection.lock`) checked before launching. PID stored in state file. `is_resurrection_running()` validates lock file PID is still alive; stale locks are cleaned up automatically.

## BUG 4: resuscitate.sh — Self-sabotaging tier cascade

**Root cause:** No lock file prevented concurrent resurrection. No gateway check between tiers — each tier's `try_restart_gateway` did `pkill` which could kill a still-starting gateway from a previous tier. Tier 2 overwrote config and Tier 3 overwrote workspace files before checking if they were needed.

**Fix:** Added lock file (`acquire_lock()` + cleanup trap). Added `is_gateway_running()` helper (single source of truth, same pgrep patterns as watchdog). Tiers 2 and 3 gate on `is_gateway_running()` — if the gateway came up during a previous tier, they skip destructive actions.

## BUG 5 (RECURRING): Session corruption — permanent 400 error loop (3rd occurrence)

**Root cause:** Assistant response aborted mid-stream while generating tool_use blocks. The tool_use has `partialJson` (incomplete arguments) and `stopReason: "error"`. OpenClaw's built-in repair inserts synthetic `toolResult` blocks, but the Anthropic API still rejects the structurally broken `tool_use` with: `unexpected tool_use_id found in tool_result blocks`. Every subsequent message hits the same 400 — permanent error loop. Occurred Feb 6, Feb 9, and Feb 14.

**Impact:** Agent becomes completely unreachable. Gateway is running, but every turn fails. Previously required manual intervention (run fix-openclaw-session.py, restart gateway).

**Fix:** Added three new components:
- `diagnose.sh` — comprehensive health diagnostic that outputs structured JSON with findings (type, severity, path, fix_command). Detects session corruption by scanning active session JSONL for the 400 error pattern.
- `session-fix.sh` — CLI wrapper for `fix-openclaw-session.py`. Removes corrupted lines, re-parents DAG references, creates backup, verifies clean.
- Watchdog integration — `watchdog.sh` now calls `diagnose.sh` instead of inline health checks. When it finds `session_corrupted` (with gateway still running), it runs session-fix + gateway restart as a lightweight fix — no resurrection needed. Falls back to resurrection only if session fix fails.

The workflow now handles one or more corrupted sessions automatically. The diagnose step scans all active sessions and returns findings for each.
