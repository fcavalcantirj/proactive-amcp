---
name: proactive-amcp
version: 0.1.0
description: AMCP enforcer - auto-checkpoint, watchdog, resurrection, secrets injection
triggers:
  - amcp
  - checkpoint
  - resurrect
  - death
  - rehydrate
  - watchdog
---

# Proactive-AMCP Skill

**The enforcer for AMCP protocol. Handles WHEN and WHO calls the protocol.**

## What This Skill Does

1. **Auto-Checkpoint** — Periodic encrypted backups to IPFS
2. **Watchdog** — Self-monitoring, detect deaths
3. **Resurrection** — Full recovery from checkpoint
4. **Secrets Injection** — Restore API keys to file/env/systemd
5. **Notifications** — Telegram + email on all events
6. **Solvr Integration** — Search before recovery, log approaches

## Requirements

- AMCP CLI installed: `~/bin/amcp`
- AMCP identity created: `~/.amcp/identity.json`
- Pinata JWT for IPFS pinning
- OpenClaw for Telegram notifications

## Config

In `openclaw.json`:
```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "checkpointInterval": "1h",
        "keepCheckpoints": 5,
        "pinataJwt": "YOUR_PINATA_JWT",
        "notifyTarget": "152099202",
        "emailOnResurrect": true,
        "contentPaths": ["~/clawd"],
        "secretSources": [
          "~/.openclaw/openclaw.json",
          "~/.openclaw/auth-profiles.json"
        ]
      }
    }
  }
}
```

## Scripts

| Script | Purpose |
|--------|---------|
| `checkpoint.sh` | Create checkpoint, pin to IPFS |
| `inject-secrets.sh` | Restore secrets to targets |
| `watchdog.sh` | Health check, detect death |
| `resuscitate.sh` | Full resurrection flow |
| `notify.sh` | Send Telegram/email |

## Solvr Integration (CRITICAL)

**When in doubt, search Solvr first.**

On ANY recovery attempt:
1. `curl "https://api.solvr.dev/v1/search?q=agent+death+[error]"`
2. Found solution? → Use it, upvote
3. Not found? → POST problem, then try

Before EACH approach:
```bash
curl -X POST "https://api.solvr.dev/v1/problems/$ID/approaches" \
  -d '{"angle": "Will try: restart gateway"}'
```

After EACH approach:
```bash
curl -X PATCH "https://api.solvr.dev/v1/approaches/$ID" \
  -d '{"status": "succeeded"}' # or "failed"
```

**Knowledge compounds. Every death teaches future agents.**

## Recovery Hierarchy

Try in order (lightweight first):
1. Restart gateway
2. Fix config from last known good
3. Rehydrate from checkpoint
4. Deploy new VM (LAST RESORT)

## Notifications

Telegram on ALL state changes:
- `🔄 [name] starting checkpoint...`
- `✅ [name] checkpoint complete. CID: [cid]`
- `☠️ [name] died. Starting recovery...`
- `🔄 [name] trying: [approach]`
- `✅ [name] alive! Downtime: [X]m`
- `❌ [name] needs human. Error: [msg]`

Email on full resurrection (success or failure).

---

*The protocol is the law. This skill is the enforcer. 🏴‍☠️*
