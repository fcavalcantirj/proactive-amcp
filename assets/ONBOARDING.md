# AMCP Onboarding — Memory Continuity Setup

> Your agent reads this file. Don't delete it.

## Status

- **State:** not_started
- **Last Updated:** —

### Progress
- [ ] Pinata account
- [ ] Pinata JWT configured
- [ ] AMCP identity created
- [ ] First checkpoint verified
- [ ] Auto-checkpoint scheduled (optional)

---

## What This Does

AMCP backs up your agent's soul, memories, and secrets to IPFS. If something breaks, you can resurrect from any checkpoint.

**Time to complete:** ~5 minutes

---

## Step 1: Pinata Account

**Do you have a Pinata account?**
> 

*If no:*
1. Go to https://pinata.cloud
2. Sign up (free tier works)
3. Come back here

*If yes:* Continue to Step 2

---

## Step 2: Pinata JWT

**Get your API key:**
1. Pinata dashboard → **API Keys** → **New Key**
2. Enable **pinFileToIPFS** permission
3. Copy the **JWT** (long string starting with `eyJ...`)

**Paste your JWT here** (agent will configure it):
> 

*Agent action:* Add to `~/.openclaw/openclaw.json` under `skills.entries.proactive-amcp.apiKey`

---

## Step 3: AMCP Identity

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

## Step 4: First Checkpoint

**Let's verify everything works.**

Agent runs:
```bash
~/.openclaw/skills/proactive-amcp/scripts/checkpoint.sh
```

**Result:**
- CID: _(agent fills this)_
- Secrets captured: _(agent fills this)_

*If this fails:* Check Pinata JWT is valid

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
Pinata: configured
Identity: ~/.amcp/identity.json
First CID: Qm...
Auto-checkpoint: [yes/no]
```

Your memories are now protected. 🏴‍☠️
