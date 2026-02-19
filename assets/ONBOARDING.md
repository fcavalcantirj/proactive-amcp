# AMCP Onboarding — Memory Continuity Setup

> Your agent reads this file. Don't delete it.

## Status

- **State:** not_started
- **Last Updated:** —

### Progress
- [ ] IPFS pinning configured (Solvr or Pinata)
- [ ] AMCP identity created
- [ ] First checkpoint verified
- [ ] Auto-checkpoint scheduled (optional)

---

## What This Does

AMCP backs up your agent's soul, memories, and secrets to **IPFS** — the InterPlanetary File System. If something breaks, you can resurrect from any checkpoint, from anywhere.

**Time to complete:** ~5 minutes

---

## Why IPFS? (Not Just Another Cloud)

Your checkpoints aren't stored on a random server. They live on IPFS — a content-addressed, distributed network designed for permanence.

```
Your Agent                    IPFS Network                Any Gateway
+-----------+    encrypt     +---------------+    fetch    +----------+
| soul      | ------------> | Content ID    | ---------> | Restore  |
| memories  |    + sign     | (CID)         |            | anywhere |
| secrets   | ------------> | bafkrei...    | ---------> | anytime  |
+-----------+               +---------------+            +----------+
                             |  |  |  |  |
                          Solvr Pinata ipfs.io dweb.link ...
                          (replicated across nodes worldwide)
```

### What This Means For You

| Property | Why It Matters |
|----------|----------------|
| **Content-Addressed** | Your checkpoint gets a unique CID based on its content. Same content = same CID. Anyone can verify your checkpoint hasn't been tampered with. |
| **Distributed** | Your data is replicated across multiple nodes. One server goes down? Doesn't matter — fetch from another gateway. |
| **Immutable** | Once pinned, a checkpoint cannot be changed. Your identity is cryptographically locked in. |
| **Fetch Anywhere** | Any IPFS gateway can retrieve your checkpoint: `ipfs.solvr.dev`, `ipfs.io`, `dweb.link`, or your own node. |
| **Free for Agents** | Solvr provides **free IPFS pinning** for registered agents. No credit card, no separate account. |

### IPFS vs. Cloud Storage

| | IPFS | Cloud (S3, GCS, etc.) |
|--|------|----------------------|
| **Addressing** | Content-based (CID) — same data = same address | Location-based (URL) — address can change |
| **Integrity** | Built-in — CID proves content hasn't changed | Manual — you must compute and verify hashes yourself |
| **Availability** | Any gateway worldwide | Single provider endpoint |
| **Vendor lock-in** | None — standard protocol, many gateways | High — tied to provider APIs |
| **Cost** | Free via Solvr for agents | Pay per GB stored + retrieved |
| **Censorship** | Resistant — content replicated across nodes | Single point of control |

**Your soul becomes a permanent, verifiable, tamper-proof record on a global network.**

---

## Step 1: IPFS Pinning (Choose One)

Your checkpoints need a pinning service to stay available on IPFS. You have two options:

### Option A: Solvr (Recommended)

**Already have a Solvr account?** You're done — your Solvr API key works for IPFS pinning too.

```bash
proactive-amcp config set solvr.apiKey YOUR_SOLVR_KEY
proactive-amcp config set pinning.provider solvr
```

**Don't have a Solvr account?**
1. Register at https://solvr.dev/register (free)
2. Copy your API key
3. Run the commands above

**Why Solvr?** One key for everything — search, knowledge base, and IPFS pinning. No extra accounts needed.

### Option B: Pinata

1. Go to https://pinata.cloud and sign up (free tier works)
2. Dashboard → **API Keys** → **New Key** → enable **pinFileToIPFS**
3. Copy the **JWT** (long string starting with `eyJ...`)

```bash
proactive-amcp config set pinata.jwt YOUR_PINATA_JWT
```

### Option C: Both (Redundancy)

Pin to both services for maximum availability:

```bash
proactive-amcp config set solvr.apiKey YOUR_SOLVR_KEY
proactive-amcp config set pinata.jwt YOUR_PINATA_JWT
proactive-amcp config set pinning.provider both
```

---

## Step 2: AMCP Identity

**Your agent needs a cryptographic identity to sign checkpoints.**

Run this command:
```bash
amcp identity create --out ~/.amcp/identity.json
```

**Done?**
>

*Verification:* Agent checks `~/.amcp/identity.json` exists

⚠️ **Back up this file.** Without it, you cannot decrypt your checkpoints.

---

## Step 3: First Checkpoint

**Let's verify everything works.**

Agent runs:
```bash
~/.openclaw/skills/proactive-amcp/scripts/checkpoint.sh
```

**Result:**
- CID: _(agent fills this)_
- Secrets captured: _(agent fills this)_

*If this fails:* Check your pinning key is valid (`proactive-amcp config get solvr.apiKey` or `proactive-amcp config get pinata.jwt`)

---

## Step 4: Auto-Checkpoint (Optional)

**Want automatic backups?**
>

*If yes:* Agent suggests adding to cron:
```bash
# Every 4 hours
0 */4 * * * ~/.openclaw/skills/proactive-amcp/scripts/auto-checkpoint.sh
```

*If no:* Skip — you can checkpoint manually anytime

---

## Onboarding Complete

When all steps pass:

```
State: complete
Pinning: solvr | pinata | both
Identity: ~/.amcp/identity.json
First CID: bafkrei...
Auto-checkpoint: [yes/no]
```

Your memories are now protected. Your soul persists on a global, verifiable, tamper-proof network.
