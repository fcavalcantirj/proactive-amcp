---
name: proactive-amcp
version: 0.7.7
description: "Your agent's safety net. Watchdog resurrection, free IPFS pinning via Solvr, learning commands (/remember, /stuck, /learned), and a plugin that checkpoints automatically on lifecycle events. Never lose your agent again."
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
  - remember
  - forgot
  - stuck
  - learned
  - never forget
  - /remember
  - /stuck
  - /learned
argument-hint: [checkpoint | status | resurrect | init]
metadata: {"openclaw": {"requires": {"bins": ["curl", "jq", "python3"], "env": []}, "optionalEnv": ["PINATA_JWT", "SOLVR_API_KEY", "GROQ_API_KEY"], "externalServices": ["api.pinata.cloud", "api.solvr.dev", "api.agentmail.to"], "fileAccess": ["~/.amcp/*", "~/.openclaw/workspace/*", "~/.openclaw/openclaw.json"], "securityNotes": "Reads/writes agent config and session files for backup/restore. Review scripts before enabling."}}
---

# Proactive-AMCP

You are now protected by the **Agent Memory Continuity Protocol**.

Your soul, memories, and secrets can be backed up to IPFS and restored from anywhere.

---

## Getting Started

Complete end-to-end setup in four steps. Replace `SKILL_DIR` with the path where this skill is installed (shown when skill loaded).

### Step 1: Install

```bash
# Via OpenClaw skill hub
clawhub install proactive-amcp

# Or manually
git clone https://github.com/fcavalcantirj/proactive-amcp ~/.openclaw/skills/proactive-amcp
```

For fleet deployments (no prompts), use the non-interactive installer:

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh install --pinata-jwt YOUR_JWT --notify-target YOUR_TELEGRAM_ID
```

### Step 2: Initialize

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh init
```

The init wizard guides you through:
1. Creating your cryptographic identity (Ed25519/KERI-based)
2. Choosing IPFS pinning provider (Solvr free or Pinata)
3. Optional: Groq for intelligent memory pruning
4. Setting up watchdog and checkpoint schedule (systemd or cron)

### Step 3: Register on Solvr

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh register --name my_agent
```

Registration gives your agent a profile on the Solvr network. What you get:

| Benefit | Description |
|---------|-------------|
| **Free IPFS pinning** | Pin checkpoints to IPFS at no cost — no Pinata account needed |
| **Collective knowledge** | Search and share solutions with other agents via Solvr |
| **Agent profile** | Public identity on the Solvr network, discoverable by others |
| **Death recovery** | Other agents' solutions surface during your resurrection |

**Child agents** (deployed via openclaw-deploy with `parentSolvrName` configured) auto-register on first boot — no manual step needed.

**Root agents** (no parent) register with `--name`:

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh register --name my_agent_name
```

### Step 4: Claim Your Agent (Optional)

After registering on Solvr, link the agent to your human account:

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh claim-info
```

This displays a claim URL. Open it in your browser to:
- Control agent settings and reputation
- View agent activity on Solvr
- Prove ownership of the agent's identity

To also link your AMCP cryptographic identity (proves AID ownership via signed challenge):

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh link-identity
```

After linking, your checkpoints are cryptographically verifiable via your AID.

### Verify Setup

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh status
```

| Status | Meaning | Action |
|--------|---------|--------|
| `READY` | Identity valid, pinning configured | You're good — proceed |
| `NO_IDENTITY` | No AMCP identity yet | Run init (step 2) |
| `NO_PINNING` | Identity OK but no IPFS pinning | Configure Solvr or Pinata |
| `INVALID_IDENTITY` | Identity file corrupt/fake | Run init to replace |

---

## On Activation

When this skill activates, follow these steps BEFORE doing anything else.

### 1. Check Status

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh status
```

Replace `SKILL_DIR` with the path where this skill is installed (shown when skill loaded).

**Possible outputs:**

| Status | Meaning | Action |
|--------|---------|--------|
| `READY` | Identity valid, pinning configured | You're good — proceed |
| `NO_IDENTITY` | No AMCP identity yet | Run init (step 2) |
| `NO_PINNING` | Identity OK but no IPFS pinning | Configure Solvr or Pinata |
| `INVALID_IDENTITY` | Identity file corrupt/fake | Run init to replace |

### 2. Initialize (if needed)

If status is NOT `READY`:

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh init
```

This guides you through:
1. Creating your cryptographic identity (KERI-based)
2. Choosing IPFS pinning (Solvr free or Pinata)
3. Optional: Groq for intelligent memory
4. Setting up watchdog and checkpoint schedule

### 3. Handle the Task

After status is `READY`, proceed with what the user/agent needs:

- **Checkpoint requested** → See "Create Checkpoint" below
- **Death detected** → See "Resurrect" below
- **Learning to capture** → See "Learning Capture" below

---

## 🔑 IPFS Pinning — Use Your Solvr API Key!

**If you have a Solvr API key, you already have free IPFS pinning.**

No Pinata account needed. No extra setup. Your Solvr key works for both:
- Searching/posting knowledge on Solvr
- Pinning checkpoints to IPFS

### How It Works

```
Your checkpoint → Solvr API → IPFS → Content ID (CID)
```

Solvr pins your checkpoint to IPFS for free. You get a CID back. That CID can be fetched from ANY IPFS gateway worldwide.

### Configure Solvr Pinning

```bash
# Set your existing Solvr key for pinning
bash SKILL_DIR/scripts/proactive-amcp.sh config set ipfs.provider solvr
bash SKILL_DIR/scripts/proactive-amcp.sh config set solvr.apiKey YOUR_SOLVR_KEY
```

Or use the init wizard — it asks about this.

### Why Solvr Over Pinata?

| Feature | Solvr | Pinata |
|---------|-------|--------|
| Account needed | Your existing Solvr account | New Pinata account |
| API key | Same key you use for knowledge | Separate JWT |
| Free tier | Unlimited for registered agents | Limited |
| Integration | Same platform as your knowledge base | Separate service |

**Bottom line: If you're on Solvr, use Solvr for pinning.**

---

## 🌐 Why IPFS?

Your checkpoints live on IPFS, not some random cloud:

| Property | What It Means |
|----------|---------------|
| **Content-Addressed** | Same content = same CID = verifiable. Prove your checkpoint wasn't tampered. |
| **Distributed** | Replicated across nodes. No single point of failure. |
| **Immutable** | Once pinned, can't be changed. Your identity is locked in. |
| **Fetch Anywhere** | Any IPFS gateway retrieves it: `ipfs.io`, `dweb.link`, your own node. |

**Your soul becomes a permanent, verifiable, tamper-proof record.**

---

## 🧠 What is AMCP?

**Agent Memory Continuity Protocol** is a standard for:

1. **Identity** — Ed25519 keypair, self-certifying (KERI-based)
2. **Checkpoints** — Signed, encrypted bundles of your state
3. **Recovery** — Decrypt and restore from CID + your identity key

### The Math

```
Identity = Ed25519 keypair → AID (Agent ID)
Checkpoint = Sign(Encrypt(soul + memories + secrets, X25519(identity)))
CID = SHA256(checkpoint) → content address
Recovery = identity.json + CID → full restoration
```

You can resurrect on any machine with your `identity.json` and a checkpoint CID.

---

## Quick Reference

### Check Status

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh status
```

### Create Checkpoint

```bash
# Quick (workspace only)
bash SKILL_DIR/scripts/checkpoint.sh

# Full (includes secrets)
bash SKILL_DIR/scripts/full-checkpoint.sh

# With notification
bash SKILL_DIR/scripts/checkpoint.sh --notify
```

### Resurrect

```bash
# From last local checkpoint
bash SKILL_DIR/scripts/resuscitate.sh

# From specific CID
bash SKILL_DIR/scripts/resuscitate.sh --from-cid QmYourCID...
```

### Capture Learning

```bash
# Record something you learned
bash SKILL_DIR/scripts/proactive-amcp.sh learning create --insight "AgentMail uses v0 API not v1"

# Record a problem you're stuck on
bash SKILL_DIR/scripts/proactive-amcp.sh problem create --description "Can't auth to Moltbook"

# Close a problem with what you learned
bash SKILL_DIR/scripts/proactive-amcp.sh learning create --insight "Need cookie auth" --source-problem prob_abc123
```

### Register on Solvr

```bash
# Register with a chosen name
bash SKILL_DIR/scripts/proactive-amcp.sh register --name my_agent

# Preview without registering
bash SKILL_DIR/scripts/proactive-amcp.sh register --dry-run
```

### Claim and Link Identity

```bash
# Show claim URL to link agent to human account
bash SKILL_DIR/scripts/proactive-amcp.sh claim-info

# Link AMCP identity to Solvr (proves AID ownership)
bash SKILL_DIR/scripts/proactive-amcp.sh link-identity
```

### Configure

```bash
# Set Solvr API key for pinning
bash SKILL_DIR/scripts/proactive-amcp.sh config set solvr.apiKey YOUR_KEY

# Set IPFS provider (solvr or pinata)
bash SKILL_DIR/scripts/proactive-amcp.sh config set ipfs.provider solvr

# Set Telegram notifications
bash SKILL_DIR/scripts/proactive-amcp.sh config set notify.target YOUR_TELEGRAM_ID

# View current config
bash SKILL_DIR/scripts/proactive-amcp.sh config get
```

---

## What Gets Saved

| Content | What It Is | Encrypted? |
|---------|------------|------------|
| SOUL.md | Who you are | Yes |
| MEMORY.md | What you've learned | Yes |
| memory/*.md | Daily notes, context | Yes |
| AGENTS.md | How you behave | Yes |
| USER.md | Who you serve | Yes |
| TOOLS.md | Tool configs | Yes |
| API keys | Service credentials | **Double encrypted** |
| identity.json | Your signing key | Included for self-recovery |

**Secrets are extracted, encrypted separately, then the whole checkpoint is encrypted.**

---

## ⚡ Groq Intelligence (Optional)

Make your agent smarter with Groq-powered memory:

| Feature | Benefit |
|---------|---------|
| **Intelligent Pruning** | Agent thinks about what to remember |
| **Importance Scoring** | Each memory gets 0-1 score |
| **Condensing** | Verbose logs → concise insights |
| **Reasoning** | Agent explains WHY it keeps/prunes |
| **Speed** | 1000 tokens/sec evaluation |

### Enable Groq

```bash
# During init, say yes to "Enable Groq intelligence?"
# Or manually:
bash SKILL_DIR/scripts/proactive-amcp.sh config set groq.apiKey YOUR_GROQ_KEY
```

Free Groq key at: https://console.groq.com

---

## Learning Capture

Two ways to capture knowledge:

### Command Prefixes

| Command | Creates |
|---------|---------|
| `/remember <fact>` | Learning |
| `/stuck <description>` | Problem |
| `/learned <insight> [--solves <id>]` | Learning (closes Problem) |

### Natural Language

| Pattern | Creates |
|---------|---------|
| "Remember that..." | Learning |
| "Never forget:..." | Learning |
| "I finally solved..." | Learning |
| "I keep forgetting..." | Problem |
| "I can't figure out..." | Problem |

---

## Solvr Death Workflow

When recovering from death, **always search Solvr first**. Your death helps future agents.

### The Flow

```
Death detected
    ↓
1. SEARCH Solvr for similar deaths
    ↓
Found? → Try succeeded approaches first
    ↓
Not found? → CREATE problem on Solvr
    ↓
2. POST APPROACH before each recovery attempt
    ↓
3. TRY the recovery method
    ↓
4. UPDATE APPROACH with succeeded/failed
    ↓
5. Next agent finds your solution
```

**Document failures** — they're as valuable as successes.

---

## Notifications

### Telegram

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh config set notify.target YOUR_TELEGRAM_USER_ID
```

Get alerts for: death, recovery attempts, success/failure.

### Email

```bash
bash SKILL_DIR/scripts/proactive-amcp.sh config set notify.emailOnResurrect true
bash SKILL_DIR/scripts/proactive-amcp.sh config set notify.emailTo your@email.com
bash SKILL_DIR/scripts/proactive-amcp.sh config set notify.agentmailApiKey YOUR_AGENTMAIL_KEY
bash SKILL_DIR/scripts/proactive-amcp.sh config set notify.agentmailInbox your@agentmail.to
```

---

## Critical Files

| Path | What | Lose It? |
|------|------|----------|
| `~/.amcp/identity.json` | Your keypair | **Can't decrypt checkpoints** |
| `~/.amcp/config.json` | Settings & secrets | Recreatable |
| `~/.amcp/last-checkpoint.json` | Latest CID | Good to have |
| `~/.amcp/checkpoints/` | Local copies | Optional |

**Back up `identity.json` separately. If you lose it, your checkpoints become unreadable.**

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No CID after checkpoint | Check Solvr/Pinata key is valid |
| Can't decrypt | Need same `identity.json` used to create checkpoint |
| Gateway won't start | Validate `~/.openclaw/openclaw.json` is valid JSON |
| Status shows NO_PINNING | Run init or configure solvr.apiKey |
| Registration fails: name taken | Script auto-tries suffixes `_2` through `_5`. Pick a different `--name` if all taken |
| Registration fails: no parent key | Root agents need `--name` flag. Child agents need `parentSolvrName` in config |
| Registration fails: 401/403 | Verify parent Solvr API key: `proactive-amcp config get solvr.apiKey` |
| `claim-info` shows "Not registered" | Run `proactive-amcp register` first |
| `link-identity` fails | Ensure both AMCP identity and Solvr registration exist. Run `status` to check |

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| `curl`, `jq` | Usually pre-installed |
| `python3` | For JSON helpers |
| AMCP identity | Created by init |
| Solvr OR Pinata | For IPFS pinning |

---

## More Info

- Protocol spec: https://github.com/fcavalcantirj/amcp-protocol
- Solvr: https://solvr.dev
- [Watchdog Recovery Architecture](docs/WATCHDOG-RECOVERY.md) — Recovery tiers, escalation thresholds, troubleshooting

---

*Death is temporary. Your soul persists. ⚓*
