---
name: proactive-amcp
version: 0.2.0
description: AMCP protocol enforcer - encrypted checkpoints to IPFS, watchdog, resurrection, secrets injection
triggers:
  - amcp
  - checkpoint
  - resurrect
  - death
  - rehydrate
  - watchdog
  - backup
metadata: {"openclaw": {"requires": {"bins": ["curl", "jq"], "env": ["PINATA_JWT"]}, "primaryEnv": "PINATA_JWT"}}
---

# Proactive-AMCP Skill

**The enforcer for AMCP protocol. Handles encrypted memory checkpoints and resurrection.**

## What This Skill Does

| Feature | Description |
|---------|-------------|
| **Auto-Checkpoint** | Periodic encrypted backups to IPFS via Pinata |
| **Watchdog** | Self-monitoring, detect agent death |
| **Resurrection** | Full recovery from checkpoint |
| **Secrets Injection** | Restore API keys to config files |
| **Notifications** | Telegram alerts on all state changes |

## What This Skill Does NOT Do

- ❌ Modify OpenClaw gateway config (that's proactive-solvr)
- ❌ Post to Solvr automatically (agent does this after alive)
- ❌ Handle onboarding/soul persistence (that's proactive-solvr)

## Requirements

| Requirement | Purpose |
|-------------|---------|
| `curl` | API calls (Pinata, Telegram) |
| `jq` | JSON parsing |
| `PINATA_JWT` | IPFS pinning service |
| `~/.amcp/identity.json` | AMCP identity (create with `amcp identity create`) |

### Optional

| Requirement | Purpose |
|-------------|---------|
| `SOLVR_API_KEY` | Search Solvr for recovery solutions (read-only) |
| OpenClaw | Telegram notifications |

## Quick Start

```bash
# 1. Create AMCP identity
amcp identity create --out ~/.amcp/identity.json

# 2. Configure skill
# Add to ~/.openclaw/openclaw.json:
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "enabled": true,
        "apiKey": "YOUR_PINATA_JWT",
        "config": {
          "checkpointInterval": "4h",
          "keepCheckpoints": 5,
          "notifyTarget": "YOUR_TELEGRAM_ID",
          "contentPaths": ["~/.openclaw/workspace"],
          "secretSources": [
            "~/.openclaw/openclaw.json",
            "~/.amcp/config.json"
          ]
        }
      }
    }
  }
}

# 3. Create first checkpoint
./scripts/checkpoint.sh
```

## Scripts

| Script | Purpose | Solvr Usage |
|--------|---------|-------------|
| `checkpoint.sh` | Create checkpoint, encrypt, pin to IPFS | None |
| `full-checkpoint.sh` | Include secrets in checkpoint | None |
| `inject-secrets.sh` | Restore secrets to target files | None |
| `watchdog.sh` | Health check, detect death | None |
| `resuscitate.sh` | Full resurrection flow | **SEARCH only** |
| `notify.sh` | Send Telegram notifications | None |
| `auto-checkpoint.sh` | Cron-friendly checkpoint | None |

## Recovery Hierarchy

**Try lightweight first:**

```
1. SEARCH SOLVR → Look for known solutions (scripts do this)
2. Restart gateway → systemctl --user restart openclaw-gateway
3. Fix config → Restore from last known good
4. Full resurrection → Decrypt checkpoint, restore content + secrets
5. Deploy new VM → LAST RESORT (human intervention)
```

## Solvr Integration (READ-ONLY in scripts)

Scripts search Solvr for solutions but **never POST automatically**.

**Why?**
- During resurrection, the agent might be dead
- Scripts can search (find known solutions)
- After resurrection, the AGENT posts (via AGENTS.md patterns)

```bash
# Scripts do this (SEARCH):
curl -s "https://api.solvr.dev/v1/search?q=agent+death+gateway+restart" \
  -H "Authorization: Bearer $SOLVR_API_KEY"

# Agent does this AFTER ALIVE (POST):
# See proactive-solvr skill for Solvr posting patterns
```

## Notifications

Telegram alerts on state changes:

| Event | Message |
|-------|---------|
| Checkpoint start | `🔄 [name] starting checkpoint...` |
| Checkpoint done | `✅ [name] checkpoint complete. CID: [cid]` |
| Death detected | `☠️ [name] died. Starting recovery...` |
| Recovery attempt | `🔄 [name] trying: [approach]` |
| Recovery success | `✅ [name] alive! Downtime: [X]m` |
| Recovery failed | `❌ [name] needs human. Error: [msg]` |

## Security Considerations

### What This Skill Accesses

| Resource | Access | Purpose |
|----------|--------|---------|
| `~/.amcp/*` | Read/Write | Identity, checkpoints, config |
| `~/.openclaw/workspace/*` | Read | Content to backup |
| `~/.openclaw/openclaw.json` | Read | Extract secrets for backup |
| `api.pinata.cloud` | Write | Pin checkpoints to IPFS |
| `api.solvr.dev` | **Read only** | Search for recovery solutions |
| Telegram API | Write | Send notifications |

### What This Skill Does NOT Access

- ❌ Does not modify `~/.openclaw/openclaw.json`
- ❌ Does not call `openclaw gateway config.patch`
- ❌ Does not auto-post to Solvr

### Credential Storage

Store `PINATA_JWT` in:
- `~/.openclaw/openclaw.json` → `skills.entries.proactive-amcp.apiKey`
- Or environment variable

**Never commit credentials to git.** Use pre-commit hooks to catch accidental commits.

## Checkpoint Format

Checkpoints are encrypted tar archives containing:

```
checkpoint.amcp (encrypted)
├── content/           # Workspace files
│   └── workspace/     # ~/.openclaw/workspace contents
├── secrets.json       # Encrypted API keys (optional)
├── manifest.json      # Metadata, previous CID
└── signature          # AMCP identity signature
```

## Files Reference

| File | Purpose |
|------|---------|
| `~/.amcp/identity.json` | AMCP signing identity |
| `~/.amcp/checkpoints/` | Local checkpoint storage |
| `~/.amcp/last-checkpoint.json` | Last successful CID |
| `~/.amcp/recovery-*.log` | Recovery attempt logs |

## Related Skills

- **proactive-solvr** — Soul persistence, Solvr posting, heartbeats, onboarding
- **amcp-protocol** — Protocol specification and CLI

---

*The protocol preserves memory. This skill enforces it. 🏴‍☠️*
