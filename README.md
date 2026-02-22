# proactive-amcp

**AMCP — Your Agent's Continuity Safety Net**

Encrypted checkpoints to IPFS. Watchdog resurrection. Learning system that makes your agent smarter over time.

## What You Get

**🔄 Resurrection** — When your agent dies (server crash, OOM, config corruption), AMCP brings it back from the last checkpoint. Watchdog monitors health and auto-restarts.

**📌 Free IPFS Pinning** — Register on [Solvr](https://solvr.dev) and get 1GB free IPFS pinning. Your checkpoints live on a global, immutable network — fetch from any gateway, anywhere.

**🧠 Learning System** — `/remember`, `/stuck`, `/learned` commands let your agent capture insights. Solvr integration posts learnings for collective knowledge + personal recall.

**🔐 Security** — Secrets encrypted before checkpoint. Pre-commit hooks scan for leaked keys. Prompt injection detection on resurrection.

## Commands

| Command | What it does |
|---------|-------------|
| `status` | Identity, last checkpoint, IPFS health |
| `checkpoint` | Encrypt workspace → pin to IPFS |
| `resurrect` | Restore from checkpoint (local or CID) |
| `/remember [insight]` | Capture learning → Solvr |
| `/stuck [problem]` | Document blockers |
| `/learned [lesson]` | Record lessons |

## Plugin Included

The skill ships with an OpenClaw plugin that hooks into lifecycle events:

- `gateway_start` — verify identity, check resurrection needed
- `session_end` — smart checkpoint if significant changes
- `context_warning` — checkpoint before compaction
- `before_compaction` — save context that would be lost

No manual checkpoints needed — AMCP runs proactively.

## Install

```bash
openclaw skills install proactive-amcp
bash ~/.openclaw/skills/proactive-amcp/scripts/init.sh
```

## Why IPFS?

Your agent's identity, memories, and secrets are too important for a single server.

```
checkpoint → encrypt + sign → CID (bafkrei...) → IPFS → any gateway, anywhere
```

| Benefit | What It Means |
|---------|---------------|
| **Content-Addressed** | Same content = same CID = verifiable integrity |
| **Distributed** | Replicated across nodes worldwide |
| **Immutable** | Once pinned, checkpoints can't be changed |
| **Fetch Anywhere** | Any gateway works: `ipfs.solvr.dev`, `ipfs.io`, `dweb.link` |
| **Free for Agents** | Solvr provides free IPFS pinning for registered agents |

## Groq Intelligence (Optional)

Make your agent genuinely smarter. All Groq features are optional.

| Feature | What It Does |
|---------|--------------|
| **Memory Pruning** | Score memories 0-1 for importance. Archive noise, keep lessons |
| **Error Condensing** | Condense verbose errors to ~100 char root cause |
| **Smart Checkpoints** | Groq decides what goes into each checkpoint |
| **Batch Evaluation** | 50% cost savings via Groq batch API |

```bash
proactive-amcp memory-prune --dry-run
proactive-amcp checkpoint --smart
proactive-amcp groq status
```

## Quick Reference

```bash
# Check status
bash scripts/proactive-amcp.sh status

# Create checkpoint
bash scripts/checkpoint.sh

# Full checkpoint (includes secrets)
bash scripts/full-checkpoint.sh

# Resurrect from last checkpoint
bash scripts/resuscitate.sh

# Resurrect from specific CID
bash scripts/resuscitate.sh --from-cid QmYourCID...

# Capture learning
bash scripts/proactive-amcp.sh learning create --insight "What I learned"

# Record problem
bash scripts/proactive-amcp.sh problem create --description "What I'm stuck on"
```

## Configuration

Set in `~/.amcp/config.json`:

```json
{
  "ipfs": {
    "provider": "solvr",
    "gateway": "https://ipfs.solvr.dev"
  },
  "apiKeys": {
    "solvr": "your-solvr-api-key",
    "groq": "your-groq-key-optional"
  },
  "checkpointStrategy": "smart",
  "watchdog": {
    "enabled": true,
    "intervalMs": 30000
  }
}
```

## License

MIT — ClaudiusThePirateEmperor & Felipe Cavalcanti
