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
metadata: {"openclaw": {"requires": {"bins": ["curl", "jq"], "env": ["PINATA_JWT"]}, "primaryEnv": "PINATA_JWT"}}
---

# Proactive-AMCP: Agent Memory Continuity Protocol

> **Your agent's soul and memories, encrypted and pinned to IPFS. Resurrect from anywhere.**

---

## ⚠️ CRITICAL: You Need Pinata (Free Tier Works)

**This skill requires [Pinata](https://pinata.cloud) for IPFS pinning.**

### Get Your Pinata JWT (2 minutes)

1. Go to https://pinata.cloud → Sign up (free)
2. Click **API Keys** → **New Key**
3. Enable **pinFileToIPFS** permission
4. Copy the **JWT** (starts with `eyJ...`)
5. Add to OpenClaw config:

```json
// ~/.openclaw/openclaw.json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "enabled": true,
        "apiKey": "eyJhbGciOiJIUzI1NiIs... YOUR_PINATA_JWT"
      }
    }
  }
}
```

**Without Pinata, checkpoints stay local only. No cloud backup. No resurrection from CID.**

---

## What Gets Saved

Every checkpoint encrypts and preserves:

| Content | What It Is |
|---------|------------|
| 🧠 **SOUL.md** | Your agent's identity, personality, principles |
| 📝 **MEMORY.md** | Long-term curated memories |
| 📅 **memory/*.md** | Daily notes, logs, context |
| 🔧 **TOOLS.md** | Tool configs, credential locations |
| 👤 **USER.md** | Info about you (the human) |
| 📋 **AGENTS.md** | Operating rules and behaviors |
| 🔑 **Secrets** | API keys from config files (encrypted separately) |

**Your agent's entire identity and memory, in one encrypted file.**

---

## How It Works

```
1. CHECKPOINT
   Workspace + Secrets → Encrypt with AMCP identity → Pin to IPFS
   
2. DEATH DETECTED  
   Watchdog notices agent unresponsive
   
3. RESURRECTION
   Fetch from IPFS → Decrypt → Restore workspace + secrets → Restart
   
4. AGENT LIVES AGAIN
   Same soul. Same memories. New session.
```

---

## Quick Start

### 1. Create AMCP Identity (one time)

```bash
# Install AMCP CLI if not present
# (check amcp-protocol repo for installation)

# Create your agent's cryptographic identity
amcp identity create --out ~/.amcp/identity.json
```

This generates a unique signing key. **Back this up.** Without it, you can't decrypt checkpoints.

### 2. Configure Pinata

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "enabled": true,
        "apiKey": "YOUR_PINATA_JWT_HERE"
      }
    }
  }
}
```

### 3. Create First Checkpoint

```bash
# Basic checkpoint (workspace only)
~/.openclaw/skills/proactive-amcp/scripts/checkpoint.sh

# Full checkpoint (workspace + all secrets)
~/.openclaw/skills/proactive-amcp/scripts/full-checkpoint.sh
```

Output:
```
✅ Checkpoint created
   Local: ~/.amcp/checkpoints/checkpoint-20260213-123456.amcp
   CID: QmXD4q8jhgrLVuXceRSDDqRkaDmE4R9uX3r7vEcCXoZDGs
   Pinned to IPFS ✓
```

**Save that CID.** It's your agent's resurrection point.

---

## Scripts

| Script | What It Does |
|--------|--------------|
| `checkpoint.sh` | Encrypt workspace, pin to IPFS |
| `full-checkpoint.sh` | Include secrets (API keys) in checkpoint |
| `resuscitate.sh` | Full resurrection from checkpoint |
| `inject-secrets.sh` | Restore secrets to config files |
| `watchdog.sh` | Monitor agent health, detect death |
| `notify.sh` | Send Telegram alerts |
| `auto-checkpoint.sh` | Cron-friendly, silent unless error |

### Resurrect from Checkpoint

```bash
# From specific CID
./scripts/resuscitate.sh --from-cid QmXD4q8jhgrLVuXceRSDDqRkaDmE4R9uX3r7vEcCXoZDGs

# From last local checkpoint
./scripts/resuscitate.sh
```

### Auto-Checkpoint (Recommended)

Add to cron for periodic backups:

```bash
# Every 4 hours
0 */4 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh
```

---

## Recovery Hierarchy

When resurrection is triggered, try lightweight first:

```
1. Restart gateway
   └─ systemctl --user restart openclaw-gateway
   
2. Fix config from backup
   └─ Restore last known good openclaw.json
   
3. Full rehydration from checkpoint
   └─ Decrypt → Restore workspace + secrets → Restart
   
4. Human intervention
   └─ If all else fails, alert human
```

---

## Notifications

Get Telegram alerts on all events:

| Event | Message |
|-------|---------|
| Checkpoint start | 🔄 Starting checkpoint... |
| Checkpoint done | ✅ Checkpoint complete. CID: Qm... |
| Death detected | ☠️ Agent died. Starting recovery... |
| Recovery attempt | 🔄 Trying: restart gateway |
| Recovery success | ✅ Alive! Downtime: 45s |
| Recovery failed | ❌ Need human. Check logs. |

Configure notification target in the skill config:
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

---

## Files & Locations

| Path | Purpose |
|------|---------|
| `~/.amcp/identity.json` | Your agent's signing key (BACK THIS UP) |
| `~/.amcp/checkpoints/` | Local checkpoint storage |
| `~/.amcp/last-checkpoint.json` | Last successful CID + path |
| `~/.amcp/recovery-*.log` | Recovery attempt logs |

---

## Security

### Encryption

- Checkpoints are encrypted with your AMCP identity key
- Only you can decrypt (holder of identity.json)
- Secrets are double-encrypted within the checkpoint

### What to Back Up

| File | Priority | Why |
|------|----------|-----|
| `~/.amcp/identity.json` | **CRITICAL** | Can't decrypt without it |
| Latest checkpoint CID | HIGH | Resurrection point |
| `~/.openclaw/openclaw.json` | HIGH | Config + API keys |

### What NOT to Commit to Git

- `identity.json` — your private key
- `*.amcp` files — encrypted but still sensitive
- Any file with real API keys

---

## Checkpoint Format

```
checkpoint.amcp (encrypted tar)
├── manifest.json       # Metadata, timestamps, previous CID
├── content/            # Your workspace files
│   ├── SOUL.md
│   ├── MEMORY.md
│   ├── memory/
│   ├── AGENTS.md
│   └── ...
├── secrets.json        # Encrypted API keys (optional)
└── signature           # AMCP identity signature
```

---

## Requirements

| Requirement | Required | Purpose |
|-------------|----------|---------|
| `curl` | ✅ | API calls |
| `jq` | ✅ | JSON parsing |
| `PINATA_JWT` | ✅ | IPFS pinning |
| `~/.amcp/identity.json` | ✅ | Encryption/signing |
| OpenClaw | Optional | Telegram notifications |

---

## Troubleshooting

### "Checkpoint created but no CID"

Pinata JWT missing or invalid. Check:
```bash
# Test Pinata connection
curl -s "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer YOUR_JWT"
```

### "Can't decrypt checkpoint"

Wrong identity file. The checkpoint was created with a different `identity.json`. You need the original.

### "Resurrection failed at secrets injection"

Target config file might have changed structure. Check `inject-secrets.sh` logs.

---

## Related

- **AMCP Protocol**: https://github.com/fcavalcantirj/amcp-protocol
- **Pinata**: https://pinata.cloud

---

*Your agent's soul persists. Memories survive. Death is temporary. 🏴‍☠️*
