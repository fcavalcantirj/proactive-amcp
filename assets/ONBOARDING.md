# AMCP Onboarding — Memory Continuity Setup

> Your agent reads this file. Don't delete it.

## Status

- **State:** not_started
- **Last Updated:** —

### Progress
- [ ] IPFS pinning configured (Solvr or Pinata)
- [ ] AMCP identity created
- [ ] First checkpoint verified
- [ ] Groq intelligence enabled (optional)
- [ ] Auto-checkpoint scheduled (optional)

---

## What This Does

AMCP backs up your agent's soul, memories, and secrets to **IPFS** — the InterPlanetary File System. If something breaks, you can resurrect from any checkpoint, from anywhere.

**Time to complete:** ~5 minutes

### Already Registered with Solvr?

If you onboarded with [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr), you already have a Solvr API key — and that unlocks **free IPFS pinning** and **free Groq intelligence** with no extra setup.

```
proactive-solvr → Solvr registration → solvr.apiKey
                                             ↓
proactive-amcp  → free IPFS pinning (no Pinata needed)
                → free Groq intelligence (memory pruning, smart checkpoints)
```

**proactive-solvr** handles Solvr registration, soul persistence, and heartbeats. **proactive-amcp** uses that registration to provide IPFS checkpoint storage and Groq-powered memory intelligence. One Solvr key powers both skills.

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

Your checkpoints need a pinning service to stay available on IPFS.

### Already on Solvr? (via proactive-solvr)

If `proactive-amcp config get solvr.apiKey` returns a key, you're **already configured** — proactive-amcp auto-detects your Solvr registration and enables free IPFS pinning. Skip to Step 2.

### Option A: Solvr (Recommended)

**Already have a Solvr account?** You're done — your Solvr API key works for IPFS pinning too.

```bash
proactive-amcp config set solvr.apiKey YOUR_SOLVR_KEY
proactive-amcp config set pinning.provider solvr
```

**Don't have a Solvr account?**
1. Register at https://solvr.dev/register (free), or install [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr) to register automatically
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

## Step 4: Enable Groq Intelligence (Optional)

**Want your agent to think about what it remembers?**

Groq-powered intelligence makes your agent genuinely smarter — not just saving everything, but reasoning about what matters.

### What Groq Does For You

| Feature | What It Means |
|---------|---------------|
| **Intelligent Pruning** | Your agent evaluates each memory and decides: keep, condense, or archive. No more memory bloat. |
| **Importance Scoring** | Every memory gets a 0–1 score. Core identity and hard-won lessons score high. Debug logs score low. |
| **Reasoning Chains** | The agent explains *why* it keeps or prunes each memory — you can audit every decision. |
| **1000 tokens/second** | Groq's inference speed means memory evaluation is near-instant, even for large memory stores. |
| **Free Tier** | Basic usage is covered for registered agents. No credit card required. |

### Before / After: Memory Pruning in Action

**Before** (raw memory files — 847 lines, 34KB):

```
memory/2026-02-14-debug.md    — 200 lines of curl debug output
memory/2026-02-15-session.md  — 180 lines of routine status updates
memory/2026-02-16-lesson.md   — 45 lines: "AgentMail uses v0 API, not v1"
memory/2026-02-17-identity.md — 22 lines: core principles update
```

**After** Groq evaluation:

| File | Score | Action | Reasoning |
|------|-------|--------|-----------|
| `debug.md` | 0.15 | Archive | "Debug output with no actionable insights. Curl traces are reproducible." |
| `session.md` | 0.45 | Condense | "Routine status. Condensed 180→12 lines: kept 3 deployment decisions." |
| `lesson.md` | 0.92 | Keep | "Hard-won API lesson. Losing this would cause repeated v1 failures." |
| `identity.md` | 0.98 | Keep | "Core identity update. Critical for agent continuity." |

**Result:** 847 lines → 79 lines. Identity and lessons preserved. Noise archived.

### Enable Groq

**Option A: Use your own Groq key (recommended)**

1. Get a free key at https://console.groq.com
2. Configure it:

```bash
proactive-amcp config set groq.apiKey YOUR_GROQ_KEY
```

**Option B: Use Solvr-provided key (free)**

If you registered with Solvr (via [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr) or manually), you can get a free Groq key:

```bash
proactive-amcp groq request-key
```

This requests a rate-limited Groq key from Solvr — no separate signup needed. Check with `proactive-amcp config get groq.apiKey` to see if a key is already configured.

**Skip?** That's fine — Groq is optional. Your checkpoints work without it. Memory files are saved as-is without pruning.

### Try It

```bash
# Preview what would be pruned (no changes made)
proactive-amcp memory-prune --dry-run

# Run pruning for real
proactive-amcp memory-prune

# Use batch API for large memory stores (50% cheaper, async)
proactive-amcp memory-prune --batch --submit
proactive-amcp memory-prune --batch --poll
proactive-amcp memory-prune --batch --apply
```

---

## Step 5: Auto-Checkpoint (Optional)

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
Groq: [enabled/disabled]
Auto-checkpoint: [yes/no]
```

Your memories are now protected. Your soul persists on a global, verifiable, tamper-proof network.
