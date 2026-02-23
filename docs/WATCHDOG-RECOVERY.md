# Watchdog Recovery Architecture

How proactive-amcp detects failures, routes them to the right fix, and escalates when automated recovery fails.

---

## Overview

The watchdog is a continuous health monitor that runs on a configurable interval (default: 60s). It follows a **diagnose-route-fix-verify** loop:

```
watchdog.sh (loop)
  │
  ├─ diagnose.sh → JSON findings
  │
  ├─ No findings? → HEALTHY (backup config, continue)
  │
  ├─ Findings found:
  │   ├─ Crash-loop detected? → HALT (notify human, stop auto-recovery)
  │   ├─ Stuck error? → Escalated fix (config repair or forced resurrection)
  │   ├─ Lightweight fixable? → Try Tier 1 fix inline
  │   └─ Failures >= threshold? → Launch resurrection (Tiers 1-3)
  │
  └─ Sleep CHECK_INTERVAL, repeat
```

---

## State Machine

The watchdog tracks agent health as a state machine persisted in `~/.amcp/watchdog-state.json`:

```
         ┌──────────┐
         │ HEALTHY  │◄────────────── Recovery succeeds
         └────┬─────┘
              │
        diagnose finds issues
              │
              ▼
         ┌──────────┐
         │ CHECKING │  (failures < FAIL_THRESHOLD)
         └────┬─────┘
              │
     failures >= FAIL_THRESHOLD
       or escalation triggered
              │
              ▼
         ┌──────────┐
         │   DEAD   │
         └────┬─────┘
              │
     ┌────────┼────────────┬──────────────┐
     │        │            │              │
  crash      resurrection  cooldown     resurrection
  loop?      running?      elapsed?     launches
     │        │            │           (background)
     ▼        ▼            ▼              │
   HALT     WAIT        retry             │
 (human   (log msg)     launch            │
 needed)                  │               │
                          └───────────────┘
```

### State Transitions

| From | To | Trigger |
|------|----|---------|
| HEALTHY | CHECKING | diagnose.sh returns findings |
| CHECKING | HEALTHY | Next check finds no issues |
| CHECKING | DEAD | `consecutiveFailures >= FAIL_THRESHOLD` |
| DEAD | HEALTHY | Any recovery tier succeeds |
| DEAD | DEAD (halted) | Crash-loop detected — no auto-recovery |

---

## Diagnostic Checks

`diagnose.sh` runs these checks and outputs a JSON findings array:

| Finding Type | Severity | What It Detects | Auto-Fixable? |
|---|---|---|---|
| `gateway_down` | Critical | Gateway process not running (`pgrep` finds nothing) | Yes — Tier 1-3 |
| `gateway_unresponsive` | Warning | Process alive but `/health` endpoint times out (ports 3141/8080/18789) | Yes — restart |
| `session_corrupted` | Critical | `tool_use_id` errors or partial JSON in session transcripts | Yes — session repair |
| `session_stuck` | Critical | 10+ error turns in last 20 turns with 2 or fewer successful turns | Yes — 3-tier fix |
| `config_invalid` | Critical | `~/.openclaw/openclaw.json` fails JSON parse | Yes — Tier 2-3 |
| `config_semantic_invalid` | Critical | `openclaw doctor` detects plugin/profile/auth errors | Yes — doctor fix |
| `disk_low` | Warning | Disk usage above 90% | No — logged only |
| `memory_low` | Warning | Memory usage above 90% | No — logged only |
| `crash_loop_detected` | Critical | 10+ restarts in last hour | No — halts recovery |

### Finding JSON Format

Each finding is a JSON object:

```json
{
  "type": "session_stuck",
  "severity": "critical",
  "message": "Session abc123 is stuck: 12 errors in last 20 turns",
  "path": "/home/user/.openclaw/agents/main/sessions",
  "fix_command": "session-fix.sh --fix --session-dir /path --session-id abc123"
}
```

---

## Recovery Tiers

Recovery follows a graduated approach — lightweight fixes first, heavier ones only when needed.

### Pre-Tier: Solvr Solutions

Before attempting standard recovery, the watchdog searches the Solvr knowledge base for similar known problems:

1. Search Solvr for matching error patterns
2. If found: try suggested approaches from other agents
3. If an approach succeeds: recovery complete (skip tiers)
4. If none match or all fail: proceed to Tier 1

### Tier 1: Lightweight Fixes

Attempted inline by watchdog when the gateway is still running (or just needs a restart).

#### Gateway Restart

- **Trigger:** `gateway_unresponsive` (process exists, health check fails)
- **Action:** `systemctl --user restart openclaw-gateway`
- **Verify:** Wait 5s, check process running

#### Session Corruption Repair

- **Trigger:** `session_corrupted` (malformed JSONL in session file)
- **Action:** `session-fix.sh --fix` — surgically repairs corrupted lines
- **Verify:** Restart gateway, check health

#### Session Stuck — 3-Tier Progression

- **Trigger:** `session_stuck` (agent looping on errors)
- **Sub-tiers** (tried in order, stop on first success):

| Sub-tier | Action | What It Does |
|----------|--------|-------------|
| T1a: Truncate | `session-fix.sh --truncate-errors` | Remove trailing error turns from session |
| T1b: Reset | `openclaw session reset` | Reset session context via gateway CLI |
| T1c: Archive | `session-fix.sh --archive` | Move session to backup, gateway creates fresh one |

#### Semantic Config Fix

- **Trigger:** `config_semantic_invalid` (plugin/auth profile issues)
- **Action:** `openclaw doctor --fix`
- **Verify:** Restart gateway, check health

### Tier 2: Config Restoration

Attempted when Tier 1 fails or config is too damaged for simple fixes.

Three sub-strategies (tried in order):

| Sub-tier | Action | What It Does |
|----------|--------|-------------|
| T2a: Backup restore | Restore from `~/.amcp/config-backups/` | Pull latest known-good config backup |
| T2b: Doctor fix | `openclaw doctor --fix` | Auto-repair semantic issues |
| T2c: Minimal config | Generate minimal valid config | Last-resort bare-minimum config |

After any sub-tier succeeds, the gateway is restarted and health is verified.

### Tier 3: Full Rehydration from Checkpoint

The nuclear option — full agent state recovery from IPFS.

**Sequence:**

1. **Fetch checkpoint** from IPFS gateways (priority order):
   - Solvr (`ipfs.solvr.dev`) > Pinata > IPFS.io > Cloudflare
2. **Decrypt and verify** via `amcp resuscitate` (verify signature, decrypt secrets)
3. **Restore workspace** to `$CONTENT_DIR` (skip code repos)
4. **Inject secrets** via `inject-secrets.sh`
5. **Validate learning data** (problems.jsonl, learnings.jsonl)
6. **Validate ontology** graph (if validator exists)
7. **Recreate Python venvs** from manifest (if script exists)
8. **Restart gateway**
9. **Surface open problems** for agent context on wake

### All Tiers Exhausted

If all three tiers fail:

- Write failure to `last-recovery.json`
- Send email notification with full recovery log
- Notify via Telegram: "Resurrection FAILED! Need human..."
- Watchdog continues polling with exponential backoff

---

## Escalation Thresholds

### Failure Threshold

| Parameter | Default | Description |
|-----------|---------|-------------|
| `FAIL_THRESHOLD` | 2 | Consecutive failed health checks before declaring DEAD |

At 2 consecutive failures, the watchdog transitions to DEAD and launches resurrection.

### Escalation Threshold (Stuck Errors)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ESCALATION_THRESHOLD` | 5 | Same error type appearing N consecutive times |

When the same error appears 5+ times in `errorHistory`, the watchdog bypasses normal thresholds and forces an escalated fix:

| Stuck Error Type | Escalated Action |
|--|--|
| `config_semantic_invalid` | Try config repair (`config.sh fix`) |
| `gateway_unresponsive` | Try config repair (`config.sh fix`) |
| All others | Force resurrection immediately |

### Crash-Loop Detection

| Parameter | Default | Description |
|-----------|---------|-------------|
| `CRASH_LOOP_THRESHOLD` | 10 | Max restarts per hour before halting |

The watchdog tracks restart timestamps (last 50). If 10+ restarts occur within one hour:

- State set to DEAD
- **Auto-recovery stops entirely**
- Notification: "CRASH-LOOP DETECTED! Manual intervention required."
- Requires human to investigate and reset watchdog state

---

## Cooldown and Backoff

The watchdog uses exponential backoff between resurrection attempts to avoid resource exhaustion:

| Attempt | Delay Before Retry |
|---------|--------------------|
| 1st | Immediate |
| 2nd | 300s (5 min) |
| 3rd | 600s (10 min) |
| 4th | 1200s (20 min) |
| 5th+ | 1800s (30 min) — capped |

**Reset:** When health returns to HEALTHY, retry delay resets to 0.

**Gateway settle time:** After any restart, the watchdog waits 5 seconds before checking if the gateway is up (configurable via `GATEWAY_SETTLE_TIME`).

---

## Concurrency Control

### Lock File

**Path:** `~/.amcp/resurrection.lock`

Only one resurrection can run at a time. The lock file contains the PID of the active resurrection process.

**Stale lock detection:** Before launching a new resurrection, the watchdog checks if the PID in the lock is still alive (`kill -0`). If the process is gone, the lock is considered stale and removed.

**Cleanup:** Lock file is removed on resurrection exit (via `trap EXIT`).

---

## State File Reference

### `~/.amcp/watchdog-state.json`

```json
{
  "state": "HEALTHY",
  "consecutiveFailures": 0,
  "lastCheck": "2026-02-20T12:34:56+00:00",
  "lastHealthy": "2026-02-20T12:34:56+00:00",
  "resurrectionPid": null,
  "lastResurrectionAttempt": null,
  "retryDelay": 0,
  "errors": [],
  "errorHistory": [],
  "restart_history": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `state` | string | HEALTHY, CHECKING, or DEAD |
| `consecutiveFailures` | int | Resets to 0 on healthy check |
| `lastCheck` | ISO-8601 | Timestamp of last health check |
| `lastHealthy` | ISO-8601 | Timestamp of last healthy state |
| `resurrectionPid` | int/null | PID of running resurrection process |
| `lastResurrectionAttempt` | ISO-8601/null | When last resurrection was launched |
| `retryDelay` | int | Current backoff delay in seconds |
| `errors` | string[] | Error types from latest check |
| `errorHistory` | string[] | Rolling window of recent error types |
| `restart_history` | string[] | ISO timestamps of recent restarts (max 50) |

### `~/.amcp/last-recovery.json`

Written after each resurrection attempt (success or failure):

```json
{
  "method": "restart|config_fix|rehydrate|failed",
  "downtime": 45,
  "timestamp": "2026-02-20T12:35:41+00:00",
  "log": "/tmp/resurrection-log-xxxxx"
}
```

---

## Troubleshooting

### What to check if watchdog can't recover

| Symptom | Check | Fix |
|---------|-------|-----|
| Watchdog stuck in DEAD, no resurrection | Is `resurrection.lock` stale? Check PID: `cat ~/.amcp/resurrection.lock && kill -0 $(cat ~/.amcp/resurrection.lock)` | Remove stale lock: `rm ~/.amcp/resurrection.lock` |
| Crash-loop detected | Review `restart_history` in `watchdog-state.json` — what's causing rapid restarts? | Fix root cause, then reset: set `restart_history: []` in watchdog-state.json |
| Resurrection keeps failing | Check `last-recovery.json` for method and log path. Read the log. | Common: missing identity.json, expired Pinata JWT, IPFS gateway timeout |
| Gateway starts but immediately dies | Check gateway logs: `journalctl --user -u openclaw-gateway` | Usually: invalid config, port conflict, missing API key |
| Config restore fails (Tier 2) | Are there backups? `ls ~/.amcp/config-backups/` | If no backups: Tier 3 (rehydrate) is the fallback |
| Rehydrate fails (Tier 3) | Is `identity.json` valid? Is there a checkpoint CID in `last-checkpoint.json`? | Verify: `amcp identity validate`, check CID exists on IPFS gateway |
| Notifications not arriving | Check `notify.target` in config: `proactive-amcp config get notify.target` | Verify Telegram bot token and chat ID are correct |
| Same error keeps repeating | Check `errorHistory` in watchdog-state.json for the pattern | After 5 repeats, watchdog auto-escalates — if still failing, it's a deeper issue |

### Manual Recovery

If all automated recovery fails:

1. **Check identity:** `amcp identity validate --path ~/.amcp/identity.json`
2. **Check config:** `cat ~/.amcp/config.json | jq .` (valid JSON?)
3. **Check gateway config:** `cat ~/.openclaw/openclaw.json | jq .`
4. **Try manual restart:** `systemctl --user restart openclaw-gateway`
5. **Check logs:** `journalctl --user -u openclaw-gateway --since "1 hour ago"`
6. **Last resort — rehydrate manually:**
   ```bash
   CID=$(jq -r .cid ~/.amcp/last-checkpoint.json)
   bash /path/to/scripts/resuscitate.sh --from-cid "$CID"
   ```

### Resetting Watchdog State

To clear a stuck state and let the watchdog start fresh:

```bash
# Reset to healthy (use after manual fix)
echo '{"state":"HEALTHY","consecutiveFailures":0,"retryDelay":0,"errors":[],"errorHistory":[],"restart_history":[]}' > ~/.amcp/watchdog-state.json
```

---

## Environment Variables

All configurable, all have defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECK_INTERVAL` | 60 | Seconds between health checks |
| `FAIL_THRESHOLD` | 2 | Consecutive failures before DEAD |
| `ESCALATION_THRESHOLD` | 5 | Same error N times triggers escalation |
| `CRASH_LOOP_THRESHOLD` | 10 | Restarts per hour before halting |
| `RETRY_DELAY_INITIAL` | 300 | Initial backoff delay (seconds) |
| `RETRY_DELAY_MAX` | 1800 | Maximum backoff delay (seconds) |
| `GATEWAY_SETTLE_TIME` | 5 | Seconds to wait after gateway restart |
| `DISK_THRESHOLD` | 10 | Minimum free disk % |
| `MEM_THRESHOLD` | 10 | Minimum free memory % |

---

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — Overall system architecture
- [RECONSTRUCTION.md](../RECONSTRUCTION.md) — Memory loading order during resurrection
- [SKILL.md](../SKILL.md) — Skill activation and quick reference
