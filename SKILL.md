---
name: proactive-amcp
version: 0.2.0
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
  - continuity
metadata: {"openclaw": {"requires": {"bins": ["curl", "jq"], "env": ["PINATA_JWT"]}, "primaryEnv": "PINATA_JWT"}}
---

# Proactive-AMCP: Agent Memory Continuity Protocol

> **Your agent's soul and memories, encrypted and pinned to IPFS. Resurrect from anywhere.**

---

## What Is AMCP?

**Agent Memory Continuity Protocol** solves the fundamental problem of AI agent mortality: when your agent dies, crashes, or loses its workspace, everything is gone — identity, memories, learned preferences, API keys.

AMCP creates **encrypted checkpoints** containing:
- Your agent's complete identity (SOUL.md)
- All accumulated memories and context
- API keys and secrets (safely encrypted)
- Operating rules and learned behaviors

These checkpoints are **pinned to IPFS** via Pinata, giving you a permanent, decentralized backup. From any CID, you can resurrect your agent with full continuity — same soul, same memories, same capabilities.

**Death becomes temporary.**

---

## What You Get

| Feature | What It Does |
|---------|--------------|
| 🧠 **Soul Preservation** | SOUL.md, MEMORY.md, daily notes — all encrypted and backed up |
| 🔐 **Secrets Backup** | API keys and env vars extracted, encrypted separately — **100% safe** |
| 📌 **IPFS Pinning** | Checkpoints pinned via Pinata, fetch from any CID worldwide |
| 👁️ **Watchdog** | Monitors agent health, detects death automatically |
| 🔄 **Auto-Recovery** | Tries lightweight fixes before full resurrection |
| 📢 **Notifications** | Telegram alerts on checkpoint/death/recovery events |
| ⏰ **Auto-Checkpoint** | Cron-friendly script for periodic backups |
| 👶 **Child Memory Isolation** | Spawned agents get their own checkpoints, inherit parent identity |

---

## 🔐 Your Secrets Are Safe

**All API keys, tokens, and environment variables are encrypted before leaving your machine.**

### How Secrets Are Protected

1. **Extraction**: Keys pulled from `~/.openclaw/openclaw.json` and other configs
2. **Encryption**: Encrypted with your AMCP identity key (asymmetric cryptography)
3. **Bundling**: Stored as `secrets.json` inside the checkpoint
4. **Double Encryption**: The entire checkpoint is then encrypted again
5. **Pinning**: Only the encrypted blob goes to IPFS

**Only the holder of `~/.amcp/identity.json` can decrypt.** Not Pinata. Not IPFS nodes. Not anyone.

### What Gets Captured

| Source | What's Extracted |
|--------|------------------|
| `~/.openclaw/openclaw.json` | API keys, tokens, skill configs |
| `~/.amcp/config.json` | AMCP-specific secrets |
| Environment variables | Optionally, if configured |

### Injection on Recovery

When resurrecting, secrets are decrypted and injected back to their original locations:

```
secrets.json (encrypted) → decrypt → inject to:
  └─ ~/.openclaw/openclaw.json
  └─ ~/.amcp/config.json
  └─ Environment (if configured)
```

Your agent wakes up with full access to all services.

---

## 👶 Child Memories & Agent Spawning

When your agent spawns sub-agents (via `sessions_spawn`), each child can have its own memory continuity:

### Parent-Child Checkpoint Hierarchy

```
Parent Agent
├── checkpoint-parent.amcp (full checkpoint)
│   └── Contains: SOUL, MEMORY, secrets
│
└── Spawned Child
    └── checkpoint-child.amcp (isolated checkpoint)
        └── Contains: task context, child memories
        └── Inherits: parent AID for verification
```

### Memory Isolation

| Memory Type | Parent | Child |
|-------------|--------|-------|
| SOUL.md | ✅ Own | 🔗 Inherited reference |
| MEMORY.md | ✅ Own | ✅ Own (task-specific) |
| Secrets | ✅ Full | ⚠️ Scoped (if configured) |
| Daily notes | ✅ Full history | ✅ Task duration only |

### Child Resurrection

Children can be resurrected independently or alongside the parent:

```bash
# Resurrect parent only
./resuscitate.sh --from-cid QmParent...

# Resurrect with children
./resuscitate.sh --from-cid QmParent... --include-children
```

---

## ⚠️ REQUIRES: Pinata (Free Tier Works)

**Without Pinata, checkpoints stay local only. No cloud backup. No resurrection from CID.**

### Get Your Pinata JWT (2 minutes)

1. **https://pinata.cloud** → Sign up (free tier = 1GB storage)
2. **API Keys** → **New Key**
3. Enable **pinFileToIPFS** permission
4. Copy the **JWT** (starts with `eyJ...`)
5. Add to config:

```json
// ~/.openclaw/openclaw.json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "enabled": true,
        "apiKey": "eyJhbGciOiJIUzI1NiIs..."
      }
    }
  }
}
```

### Test Your JWT

```bash
curl -s "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer YOUR_JWT_HERE"
# Expected: {"message": "Congratulations! You are communicating with the Pinata API!"}
```

---

## Quick Start

```bash
# 1. Create AMCP identity (one time only)
amcp identity create --out ~/.amcp/identity.json

# 2. Create your first checkpoint
~/.openclaw/skills/proactive-amcp/scripts/full-checkpoint.sh
```

That's it. Your agent's soul is now backed up to IPFS.

**Save the CID** — it's your resurrection point.

---

## What Gets Saved

Every checkpoint captures your agent's complete state:

| Content | What It Is | Why It Matters |
|---------|------------|----------------|
| 🧠 **SOUL.md** | Identity, personality, principles | Who your agent IS |
| 📝 **MEMORY.md** | Long-term curated memories | Lessons learned, patterns recognized |
| 📅 **memory/*.md** | Daily notes, session logs | Recent context and decisions |
| 🔧 **TOOLS.md** | Tool configs, credential locations | How to use external services |
| 👤 **USER.md** | Info about you (the human) | Who they serve and how |
| 📋 **AGENTS.md** | Operating rules, behaviors | How they should act |
| 🔑 **Secrets** | API keys, tokens (encrypted) | Access to all services |

---

## Checkpoint Chain & Versioning

AMCP maintains a **chain of checkpoints**, each referencing its predecessor:

```
checkpoint-001.amcp
    └─ previousCID: null (genesis)
    
checkpoint-002.amcp
    └─ previousCID: QmCheckpoint001...
    
checkpoint-003.amcp
    └─ previousCID: QmCheckpoint002...
```

This enables:
- **Point-in-time recovery**: Resurrect from any checkpoint in the chain
- **Change tracking**: See what evolved between checkpoints
- **Corruption detection**: Verify chain integrity

---

## Self-Healing: Recovery Hierarchy

When the watchdog detects issues, it tries lightweight fixes first:

| Step | What It Tries | When It Works |
|------|---------------|---------------|
| 1️⃣ **Restart gateway** | `systemctl --user restart openclaw-gateway` | Gateway crashed |
| 2️⃣ **Fix config** | Restore last known good openclaw.json | Config corrupted |
| 3️⃣ **Full rehydration** | Decrypt checkpoint → Restore all | Everything's gone |
| 4️⃣ **Human alert** | Telegram notification | All else failed |

**Most deaths are fixed at step 1.** Full resurrection is the last resort.

---

## Watchdog Monitoring

The watchdog continuously monitors agent health:

| Check | What It Detects |
|-------|-----------------|
| Gateway process | Crashed or missing process |
| API responsiveness | Hung or unresponsive gateway |
| Auth status | Expired OAuth tokens |
| Disk space | Storage running low |
| Memory usage | RAM exhaustion |

### Run Watchdog

```bash
# Manual check
~/.openclaw/skills/proactive-amcp/scripts/watchdog.sh

# Add to cron (every 15 minutes)
*/15 * * * * ~/.openclaw/skills/proactive-amcp/scripts/watchdog.sh
```

---

## Auto-Checkpoint (Recommended)

Set up periodic backups so you never lose more than a few hours:

```bash
# Every 4 hours
0 */4 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh

# Every 6 hours (lighter)
0 */6 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh
```

`auto-checkpoint.sh` is silent unless there's an error — won't spam your logs.

### Storage Costs

| Workspace Size | Checkpoint Size | Pinata Free Tier |
|----------------|-----------------|------------------|
| < 10 MB | ~2-5 MB encrypted | ✅ Plenty of room |
| 10-50 MB | ~5-20 MB encrypted | ✅ Still fine |
| > 50 MB | 20+ MB | ⚠️ Prune old notes |

Pinata free tier: **1 GB storage, unlimited pins**.

---

## Scripts Reference

| Script | Purpose | Output |
|--------|---------|--------|
| `checkpoint.sh` | Workspace checkpoint, pin to IPFS | CID |
| `full-checkpoint.sh` | Workspace + secrets, pin to IPFS | CID |
| `auto-checkpoint.sh` | Cron-friendly, silent unless error | - |
| `resuscitate.sh` | Full recovery from CID or local | Restored workspace |
| `inject-secrets.sh` | Restore secrets to configs | - |
| `watchdog.sh` | Health check, trigger recovery | Alerts |
| `notify.sh` | Send Telegram alerts | - |
| `pre-commit-secrets.sh` | Block accidental credential commits | - |

### Manual Resurrection

```bash
# From specific CID (remote)
./scripts/resuscitate.sh --from-cid QmXD4q8jhgrLVuXceRSDDqRkaDmE4R9uX3r7vEcCXoZDGs

# From last local checkpoint
./scripts/resuscitate.sh
```

---

## Notifications

Get Telegram alerts for all lifecycle events:

```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "config": {
          "notifyTarget": "YOUR_TELEGRAM_USER_ID"
        }
      }
    }
  }
}
```

| Event | Message |
|-------|---------|
| Checkpoint start | 🔄 Starting checkpoint... |
| Checkpoint done | ✅ Checkpoint complete. CID: Qm... |
| Death detected | ☠️ Agent died. Starting recovery... |
| Recovery trying | 🔄 Trying: restart gateway |
| Recovery success | ✅ Alive! Downtime: 45s |
| Recovery failed | ❌ Need human. Check logs. |

---

## Files & Locations

| Path | Purpose | Back Up? |
|------|---------|----------|
| `~/.amcp/identity.json` | Your signing key | **CRITICAL — back up externally** |
| `~/.amcp/checkpoints/` | Local checkpoint storage | Optional |
| `~/.amcp/last-checkpoint.json` | Last CID + timestamp | Recommended |
| `~/.amcp/recovery-*.log` | Recovery attempt logs | No |

---

## Verification

Test your setup:

```bash
# 1. Test Pinata connection
curl -s "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer $(jq -r '.skills.entries["proactive-amcp"].apiKey' ~/.openclaw/openclaw.json)"

# 2. Check identity exists
ls -la ~/.amcp/identity.json

# 3. Check last checkpoint
cat ~/.amcp/last-checkpoint.json

# 4. Dry run (local only, no IPFS)
PINATA_JWT="" ~/.openclaw/skills/proactive-amcp/scripts/checkpoint.sh
```

---

## Security & Permissions

### What This Skill Reads

| Resource | Purpose |
|----------|---------|
| `~/.openclaw/workspace/*` | Content to backup |
| `~/.openclaw/openclaw.json` | Extract secrets (encrypted before upload) |
| `~/.amcp/*` | Identity, checkpoint metadata |

### What This Skill Writes

| Resource | Purpose |
|----------|---------|
| `~/.amcp/checkpoints/` | Local checkpoint files |
| `~/.amcp/last-checkpoint.json` | Track latest CID |
| IPFS (via Pinata) | Encrypted checkpoints only |

### What This Skill Does NOT Do

- Does not send unencrypted secrets anywhere
- Does not modify gateway config
- Does not run `openclaw gateway config.patch`
- Does not access secrets in plaintext after extraction

### Pre-Commit Hook

Block accidental credential commits:

```bash
cp ~/.openclaw/skills/proactive-amcp/scripts/pre-commit-secrets.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

---

## Troubleshooting

### "Checkpoint created but no CID"

Pinata JWT missing or invalid.

```bash
curl -s "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer YOUR_JWT"
```

### "Can't decrypt checkpoint"

Wrong `identity.json`. You need the exact identity file used to create the checkpoint.

### "Secrets not injected after recovery"

Config file structure may have changed. Check injection log:

```bash
cat ~/.amcp/recovery-*.log | grep -i secret
```

### "Gateway won't start after resurrection"

Verify config is valid JSON:

```bash
cat ~/.openclaw/openclaw.json | jq .
```

---

## Requirements

| Requirement | Required | How to Get |
|-------------|----------|------------|
| `curl` | ✅ | Usually pre-installed |
| `jq` | ✅ | `apt install jq` / `brew install jq` |
| `PINATA_JWT` | ✅ | https://pinata.cloud → API Keys |
| `~/.amcp/identity.json` | ✅ | `amcp identity create` |
| OpenClaw | Optional | For notifications |

---

## Checkpoint Format

```
checkpoint.amcp (encrypted archive)
├── manifest.json       # Metadata, timestamp, previous CID, AID
├── content/            # Workspace files (encrypted)
│   ├── SOUL.md
│   ├── MEMORY.md
│   ├── memory/
│   ├── AGENTS.md
│   └── ...
├── secrets.json        # API keys (double-encrypted)
└── signature           # AMCP identity signature
```

---

## Protocol Specification

For the full AMCP protocol specification, see:
**https://github.com/fcavalcantirj/amcp-protocol**

---

*Your agent's soul persists. Memories survive. Death is temporary. 🏴‍☠️*
