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

## What You Get

| Feature | What It Does |
|---------|--------------|
| 🧠 **Soul Preservation** | SOUL.md, MEMORY.md, daily notes — all encrypted |
| 🔐 **Secrets Backup** | API keys extracted from configs, encrypted separately |
| 📌 **IPFS Pinning** | Checkpoints pinned via Pinata, fetch from any CID |
| 👁️ **Watchdog** | Monitors agent health, detects death |
| 🔄 **Auto-Recovery** | Tries lightweight fixes before full resurrection |
| 📢 **Notifications** | Telegram alerts on checkpoint/death/recovery |
| ⏰ **Auto-Checkpoint** | Cron-friendly script for periodic backups |

---

## ⚠️ REQUIRES: Pinata (Free Tier Works)

**Without Pinata, checkpoints stay local only. No cloud backup. No resurrection from CID.**

### Get Your Pinata JWT (2 minutes)

1. **https://pinata.cloud** → Sign up (free)
2. **API Keys** → **New Key**
3. Enable **pinFileToIPFS**
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
# Should return: {"message": "Congratulations! You are communicating with the Pinata API!"}
```

---

## Quick Start

```bash
# 1. Create AMCP identity (one time)
amcp identity create --out ~/.amcp/identity.json

# 2. Create first checkpoint
~/.openclaw/skills/proactive-amcp/scripts/full-checkpoint.sh
```

Done. Your agent's soul is now backed up to IPFS.

---

## What Gets Saved

| Content | What It Is | Why It Matters |
|---------|------------|----------------|
| 🧠 **SOUL.md** | Identity, personality, principles | Who your agent IS |
| 📝 **MEMORY.md** | Long-term curated memories | What they've learned |
| 📅 **memory/*.md** | Daily notes, logs | Recent context |
| 🔧 **TOOLS.md** | Tool configs, credential locations | How to use things |
| 👤 **USER.md** | Info about you | Who they serve |
| 📋 **AGENTS.md** | Operating rules | How they behave |
| 🔑 **Secrets** | API keys from configs | Access to services |

---

## Self-Healing: Recovery Hierarchy

When the watchdog detects issues, it tries lightweight fixes first:

| Step | What It Tries | When It Works |
|------|---------------|---------------|
| 1️⃣ **Restart gateway** | `systemctl --user restart openclaw-gateway` | Gateway crashed |
| 2️⃣ **Fix config** | Restore last known good openclaw.json | Config corrupted |
| 3️⃣ **Full rehydration** | Decrypt checkpoint → Restore workspace + secrets | Everything's gone |
| 4️⃣ **Human alert** | Telegram notification | All else failed |

**Most deaths are fixed at step 1.** Full resurrection is rare.

---

## Watchdog Monitoring

The watchdog script checks:

| Check | Frequency | Catches |
|-------|-----------|---------|
| Gateway process | Every run | Crashed gateway |
| API responsiveness | Every run | Hung gateway |
| Auth status | Every run | Expired OAuth |
| Disk space | Every run | Full disk |

Run manually:
```bash
~/.openclaw/skills/proactive-amcp/scripts/watchdog.sh
```

Or add to cron:
```bash
# Every 15 minutes
*/15 * * * * ~/.openclaw/skills/proactive-amcp/scripts/watchdog.sh
```

---

## Auto-Checkpoint (Recommended)

Set up periodic backups:

```bash
# Every 4 hours
0 */4 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh

# Or every 6 hours (lighter on resources)
0 */6 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh
```

`auto-checkpoint.sh` is silent unless there's an error.

### Checkpoint Cost

| Workspace Size | Checkpoint Size | Pinata Storage |
|----------------|-----------------|----------------|
| < 10 MB | ~2-5 MB encrypted | Free tier OK |
| 10-50 MB | ~5-20 MB encrypted | Free tier OK |
| > 50 MB | Consider pruning old notes | May need paid |

Pinata free tier: 1 GB storage, unlimited pins.

---

## Scripts Reference

| Script | Purpose | Silent? |
|--------|---------|---------|
| `checkpoint.sh` | Workspace only, pin to IPFS | No |
| `full-checkpoint.sh` | Workspace + secrets, pin to IPFS | No |
| `auto-checkpoint.sh` | Cron-friendly, errors only | Yes |
| `resuscitate.sh` | Full recovery from checkpoint | No |
| `inject-secrets.sh` | Restore secrets to configs | No |
| `watchdog.sh` | Health check, detect death | Configurable |
| `notify.sh` | Send Telegram alerts | N/A |

### Manual Resurrection

```bash
# From specific CID
./scripts/resuscitate.sh --from-cid QmXD4q8jhgrLVuXceRSDDqRkaDmE4R9uX3r7vEcCXoZDGs

# From last local checkpoint
./scripts/resuscitate.sh
```

---

## Notifications

Configure Telegram alerts:

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
| `~/.amcp/identity.json` | Signing key | **CRITICAL** |
| `~/.amcp/checkpoints/` | Local checkpoints | Optional |
| `~/.amcp/last-checkpoint.json` | Last CID + path | Recommended |
| `~/.amcp/recovery-*.log` | Recovery logs | No |

### What to Back Up Externally

| File | Priority | Why |
|------|----------|-----|
| `identity.json` | **CRITICAL** | Can't decrypt without it |
| Latest CID | HIGH | Your resurrection point |
| `openclaw.json` | HIGH | All your config + keys |

---

## Verification

Check your setup:

```bash
# Test Pinata connection
curl -s "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer $(jq -r '.skills.entries["proactive-amcp"].apiKey' ~/.openclaw/openclaw.json)"

# Check identity exists
ls -la ~/.amcp/identity.json

# Check last checkpoint
cat ~/.amcp/last-checkpoint.json

# Test checkpoint (dry run - doesn't pin)
PINATA_JWT="" ~/.openclaw/skills/proactive-amcp/scripts/checkpoint.sh
# Will create local checkpoint but skip IPFS
```

---

## Security & Permissions

### What This Skill Accesses

| Resource | Access | Purpose |
|----------|--------|---------|
| `~/.openclaw/workspace/*` | Read | Content to backup |
| `~/.openclaw/openclaw.json` | Read | Extract secrets |
| `~/.amcp/*` | Read/Write | Identity, checkpoints |
| `api.pinata.cloud` | Write | Pin checkpoints |
| Telegram API | Write | Notifications |

### What This Skill Does NOT Do

- Does not modify OpenClaw gateway config
- Does not run `openclaw gateway config.patch`
- Does not restart gateway (except during recovery)

### Encryption

- Checkpoints encrypted with AMCP identity key
- Only holder of `identity.json` can decrypt
- Secrets double-encrypted within checkpoint

### Pre-Commit Hook (Recommended)

Block accidental credential commits:

```bash
# Copy the hook
cp ~/.openclaw/skills/proactive-amcp/scripts/pre-commit-secrets.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Detects: API keys, JWTs, private keys, tokens.

---

## Troubleshooting

### "Checkpoint created but no CID"

Pinata JWT missing or invalid.

```bash
# Test authentication
curl -s "https://api.pinata.cloud/data/testAuthentication" \
  -H "Authorization: Bearer YOUR_JWT"
```

### "Can't decrypt checkpoint"

Wrong `identity.json`. The checkpoint was created with a different identity. You need the original file.

### "Gateway won't start after resurrection"

Check if config was restored correctly:

```bash
cat ~/.openclaw/openclaw.json | jq .
# Should be valid JSON
```

### "Secrets not injected"

Target config structure may have changed. Check the injection log:

```bash
cat ~/.amcp/recovery-*.log | grep -i secret
```

---

## Requirements Summary

| Requirement | Required | How to Get |
|-------------|----------|------------|
| `curl` | ✅ | Usually pre-installed |
| `jq` | ✅ | `apt install jq` / `brew install jq` |
| `PINATA_JWT` | ✅ | https://pinata.cloud → API Keys |
| `~/.amcp/identity.json` | ✅ | `amcp identity create` |
| OpenClaw | Optional | For Telegram notifications |

---

## Checkpoint Format

```
checkpoint.amcp (encrypted tar)
├── manifest.json       # Metadata, timestamp, previous CID
├── content/            # Workspace files
│   ├── SOUL.md
│   ├── MEMORY.md
│   ├── memory/
│   └── ...
├── secrets.json        # Encrypted API keys
└── signature           # AMCP identity signature
```

---

*Your agent's soul persists. Memories survive. Death is temporary. 🏴‍☠️*
