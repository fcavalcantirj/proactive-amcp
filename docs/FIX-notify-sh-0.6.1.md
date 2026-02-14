# Fix: notify.sh Test Stub → Real Implementation

**Version:** 0.6.0 → 0.6.1  
**Date:** 2026-02-14  
**Reporter:** Claudius (dogfooding)  
**Severity:** Medium (notifications silently failed)

---

## Context

`proactive-amcp` is the Agent Memory Continuity Protocol skill — it handles encrypted checkpoints, watchdog monitoring, and resurrection of AI agents. The `notify.sh` script is called by:

- `watchdog.sh` — when agent death is detected
- `resuscitate.sh` — when resurrection completes
- `auto-checkpoint.sh` — on checkpoint failures

Notifications are critical for humans to know when their agent died or came back.

---

## Problem

During dogfooding on v0.6.0, `resuscitate.sh --dry-run` failed with:

```
/home/clawdbot/.openclaw/skills/proactive-amcp/scripts/notify.sh: line 2: /notifications.log: Permission denied
```

**Root cause:** `notify.sh` was a test stub, not a real implementation:

```bash
#!/bin/bash
echo "[NOTIFY] $*" >> "${TEST_DIR}/notifications.log"
```

When `TEST_DIR` is unset (production use), this expands to `/notifications.log` — a root-owned path that fails silently or errors.

---

## Impact

- **Watchdog alerts:** Never sent
- **Resurrection notifications:** Never sent  
- **Checkpoint failure alerts:** Never sent
- **Human unaware:** Agent could die and human wouldn't know

---

## Fix Applied

Replaced test stub with full implementation:

### Features
1. **Logging** — All notifications logged to `~/.amcp/logs/notifications.log`
2. **Config-driven** — Reads from `~/.openclaw/openclaw.json`:
   - `skills.entries.proactive-amcp.config.notifyTarget` — Telegram user ID
   - `skills.entries.proactive-amcp.config.emailOnResurrect` — boolean
   - `skills.entries.proactive-amcp.config.emailTo` — email address
3. **Email support** — Uses AgentMail SDK when `--email "subject"` flag passed
4. **Graceful degradation** — Works even if config missing (logs only)

### Usage
```bash
# Basic notification (logs + notes Telegram target)
notify.sh "Agent died, attempting recovery"

# With email
notify.sh "Resurrection complete" --email "🔄 Agent Resurrected"
```

### Config Example
```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "config": {
          "notifyTarget": "152099202",
          "emailOnResurrect": true,
          "emailTo": "user@example.com",
          "agentmailInbox": "agent@agentmail.to"
        }
      }
    }
  }
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `scripts/notify.sh` | Complete rewrite (66 → 89 lines) |
| `_meta.json` | Version bump 0.6.0 → 0.6.1 |

---

## Testing Done

```bash
# Test basic notification
./scripts/notify.sh "Test notification from proactive-amcp 0.6.0"
# Output: [NOTIFY] Telegram target: 152099202 (use message tool from agent context)
#         [NOTIFY] Done: Test notification from proactive-amcp 0.6.0

# Verify log created
cat ~/.amcp/logs/notifications.log
# Output: [2026-02-14T01:27:10+00:00] Test notification from proactive-amcp 0.6.0

# Test all scripts still work
./scripts/diagnose.sh    # ✅ healthy
./scripts/watchdog.sh    # ✅ HEALTHY  
./scripts/session-fix.sh # ✅ CLEAN
```

---

## Known Limitations

1. **Telegram notifications** require agent context (message tool) — script logs the target but can't send directly from bash. Callers should use the OpenClaw message tool when in agent context.

2. **Email requires AgentMail** — if AgentMail SDK not installed at `~/clawd/skills/agentmail/.venv/bin/python3`, email silently skips.

---

## TODO (Future)

- [ ] Add webhook support for generic notification endpoints
- [ ] Add Discord/Slack options
- [ ] Consider standalone notification daemon that scripts can curl

---

## Commit Message

```
fix(notify): replace test stub with real notification implementation

- Was writing to ${TEST_DIR}/notifications.log (fails in production)
- Now logs to ~/.amcp/logs/notifications.log
- Reads Telegram target from config
- Supports email via AgentMail with --email flag
- Graceful degradation if config missing

Fixes silent notification failures in watchdog/resuscitate flows.
```
