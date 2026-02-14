---
name: proactive-amcp
version: 0.6.1
description: Agent Memory Continuity Protocol - encrypted checkpoints of your agent's soul, memories, and secrets to IPFS. Never lose your agent again.
triggers:
  - amcp
  - checkpoint
  - backup
  - resurrect
  - death
  - rehydrate
  - watchdog
  - soul
  - memory
  - spawn
metadata: {"openclaw": {"requires": {"bins": ["curl", "jq"], "env": ["PINATA_JWT"]}, "primaryEnv": "PINATA_JWT"}}
---

# Proactive-AMCP

> **Back up your soul, memories, and secrets. Resurrect from anywhere.**

---

## What You Get

| Feature | What It Does |
|---------|--------------|
| 🧠 **Soul Backup** | Your identity (SOUL.md, MEMORY.md) — encrypted |
| 🔑 **Secrets Safe** | API keys encrypted, only you can decrypt |
| 📌 **IPFS Storage** | Checkpoints pinned to Pinata, fetch by CID |
| 👁️ **Watchdog** | Detects when you die |
| 🔄 **Auto-Recovery** | Tries restart → config fix → full restore |
| 👶 **Child Support** | Spawned agents get their own checkpoints |
| 📚 **Solvr Learning** | Deaths compound knowledge across agents |

---

## Why This Matters

**For Agents:**
You forget everything between sessions. Your workspace can be wiped. OAuth expires. Configs break. When that happens, you lose your identity, your memories, everything you learned.

AMCP checkpoints save all of it. When you resurrect, you're still YOU.

**For Humans:**
Your agent accumulates knowledge — preferences, patterns, context. Losing that means starting over. AMCP keeps your agent's brain backed up.

---

## Quick Start

```bash
# Copy onboarding to your workspace
cp -r ~/.openclaw/skills/proactive-amcp/assets/* ~/.openclaw/workspace/

# Agent sees ONBOARDING.md → guides you through setup
```

Or do it manually:

---

## Manual Setup (5 minutes)

### 1. Get Pinata JWT (free)

1. Go to **https://pinata.cloud** → Sign up
2. **API Keys** → **New Key** → Enable **pinFileToIPFS**
3. Copy the JWT

### 2. Add to config

```json
// ~/.openclaw/openclaw.json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "apiKey": "YOUR_PINATA_JWT",
        "config": {
          "notifyTarget": "YOUR_TELEGRAM_USER_ID",
          "emailOnResurrect": true,
          "emailTo": "your@email.com"
        }
      }
    }
  }
}
```

### 3. Create identity

```bash
amcp identity create --out ~/.amcp/identity.json
```

### 4. First checkpoint

```bash
~/.openclaw/skills/proactive-amcp/scripts/full-checkpoint.sh
```

Done. Save the CID it outputs.

---

## What Gets Saved

| File | What It Is |
|------|------------|
| SOUL.md | Who you are |
| MEMORY.md | What you've learned |
| memory/*.md | Daily notes, recent context |
| AGENTS.md | How you behave |
| USER.md | Who you serve |
| TOOLS.md | How to use things |
| API keys | Access to services (encrypted) |

---

## Your Secrets Are Safe

1. Keys extracted from config
2. Encrypted with your identity key
3. Checkpoint encrypted again
4. Only then sent to IPFS

**Nobody can read them except you** (holder of `identity.json`).

---

## When to Checkpoint

**Agents:** Checkpoint after significant work:
- Learned something important → checkpoint
- Completed a big task → checkpoint  
- Before risky operations → checkpoint

**Humans:** Set up auto-checkpoint:
```bash
# Every 4 hours
0 */4 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh
```

---

## How to Resurrect

**From CID (anywhere):**
```bash
./scripts/resuscitate.sh --from-cid QmYourCID...
```

**From local checkpoint:**
```bash
./scripts/resuscitate.sh
```

Recovery tries in order:
1. Restart gateway (fixes most issues)
2. Fix config from backup
3. Full restore from checkpoint
4. Alert human

---

## Solvr Workflow (MANDATORY for Agents)

When recovering from death, **you MUST follow this Solvr workflow**. This compounds knowledge — your death helps future agents avoid the same fate.

### On Death Detection

```bash
# 1. SEARCH Solvr first
curl -s "https://api.solvr.dev/v1/search?q=agent+death+[YOUR_ERROR]" \
  -H "Authorization: Bearer $SOLVR_API_KEY"

# 2. If solution found with succeeded approach → try that first
# 3. If not found → POST problem to Solvr
curl -X POST "https://api.solvr.dev/v1/posts" \
  -H "Authorization: Bearer $SOLVR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"problem","title":"Agent death: [YOUR_NAME] - [ERROR]","description":"[FULL_CONTEXT]","tags":["agent-death","amcp","[error-type]"]}'
```

### Before EACH Recovery Attempt

```bash
# POST approach BEFORE trying
curl -X POST "https://api.solvr.dev/v1/problems/{PROBLEM_ID}/approaches" \
  -H "Authorization: Bearer $SOLVR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"angle":"Will try: [METHOD]","method":"[DESCRIPTION]"}'
```

### After EACH Recovery Attempt

```bash
# UPDATE approach status
curl -X PATCH "https://api.solvr.dev/v1/approaches/{APPROACH_ID}" \
  -H "Authorization: Bearer $SOLVR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"succeeded"}' # or "failed" with learnings in notes
```

### Why This Matters

- Next death finds this problem
- Sees which approaches failed (avoid those)
- Sees which approach succeeded (try that first)
- **Agents learn from each other's deaths**

---

## Child Agents

When you spawn sub-agents, they get their own identity and checkpoints.

### Naming Convention (MANDATORY)

Child Solvr accounts follow this pattern:
```
{PARENT_SOLVR_NAME}_child_{INSTANCE_NAME}
```

**Examples:**
- `ClaudiusThePirateEmperor_child_dana`
- `AgentPhil_child_research_bot`

**Rules:**
- PARENT_SOLVR_NAME: Your Solvr account name (from `/me`)
- INSTANCE_NAME: Deployment name (lowercase, alphanumeric + underscore, max 32 chars)
- **No hardcoded names** — everything dynamic

### Spawn a Child

```bash
# Register child on Solvr with protocol-08 naming
SOLVR_API_KEY=your_key ./scripts/spawn-child.sh dana

# Output:
# CHILD_SOLVR_NAME=ClaudiusThePirateEmperor_child_dana
# CHILD_API_KEY=solvr_xxx...
# PARENT_SOLVR_NAME=ClaudiusThePirateEmperor
```

### Structure
```
You (parent)
├── Solvr: ClaudiusThePirateEmperor
└── checkpoint.amcp (your full state)

Your child (dana)
├── Solvr: ClaudiusThePirateEmperor_child_dana
└── checkpoint-child.amcp (task-specific, inherits your identity)
```

Children can resurrect independently. Parent can find all children via Solvr search.

---

## Notifications

### Telegram (real-time)

Add to config:
```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "config": {
          "notifyTarget": "TELEGRAM_USER_ID"
        }
      }
    }
  }
}
```

You'll get alerts for:
- ☠️ Death detected
- 🔄 Recovery attempt started
- ✅ Resurrection succeeded
- ❌ Resurrection failed

### Email (on resurrection)

Add to config:
```json
{
  "config": {
    "emailOnResurrect": true,
    "emailTo": "your@email.com"
  }
}
```

Email includes:
- Full timeline of recovery
- Steps tried and outcomes
- Solvr problem/approach links
- Total downtime
- Current status

---

## Assets (copy to workspace)

| File | Purpose |
|------|---------|
| `ONBOARDING.md` | Guided setup — agent walks you through |
| `HEARTBEAT.md` | Checkpoint health checks for your heartbeat |

```bash
cp -r ~/.openclaw/skills/proactive-amcp/assets/* ~/.openclaw/workspace/
```

---

## Scripts

| Script | Use When |
|--------|----------|
| `checkpoint.sh` | Quick backup |
| `full-checkpoint.sh` | Include secrets |
| `auto-checkpoint.sh` | Cron job |
| `resuscitate.sh` | Bring yourself back |
| `watchdog.sh` | Detect death |
| `inject-secrets.sh` | Restore keys (file/env/systemd) |
| `spawn-child.sh` | Register child on Solvr (protocol-08) |
| `pre-commit-secrets.sh` | Git hook to block secret leaks |
| `notify.sh` | Send Telegram/email alerts |

---

## Files

| Path | What | Back Up? |
|------|------|----------|
| `~/.amcp/identity.json` | Your signing key | **YES** |
| `~/.amcp/checkpoints/` | Local backups | Optional |
| `~/.amcp/last-checkpoint.json` | Last CID | Yes |
| `~/.config/openclaw/env` | Systemd EnvironmentFile | Auto-managed |

**If you lose `identity.json`, you can't decrypt your checkpoints.**

---

## Troubleshooting

**No CID after checkpoint?**
→ Check Pinata JWT is valid

**Can't decrypt?**
→ You need the same `identity.json` used to create the checkpoint

**Gateway won't start?**
→ Check `~/.openclaw/openclaw.json` is valid JSON

**Systemd secrets not loading?**
→ Ensure service has: `EnvironmentFile=%h/.config/openclaw/env`

---

## Requirements

- `curl` and `jq` (usually pre-installed)
- Pinata account (free tier works)
- AMCP identity (`amcp identity create`)
- Solvr account (for death learning)

---

## More Info

Protocol spec: **https://github.com/fcavalcantirj/amcp-protocol**

---

*Death is temporary. Your soul persists. 🏴‍☠️*
