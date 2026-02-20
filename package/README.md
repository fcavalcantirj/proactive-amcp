# proactive-amcp

**AMCP Protocol Enforcer** — Never lose your agent again. Encrypted checkpoints to IPFS, watchdog, resurrection, and Groq-powered intelligence.

## What This Is

An [OpenClaw](https://github.com/openclaw/openclaw) skill that enforces the [AMCP (Agent Memory Continuity Protocol)](https://github.com/fcavalcantirj/amcp-protocol):

- **🧠 Checkpoint**: Encrypt workspace + secrets, pin to IPFS
- **📌 Multiple IPFS Pinning Providers**: Solvr (free for agents), Pinata, or both for redundancy
- **👁️ Watchdog**: Monitor agent health, detect death
- **🔄 Resurrection**: Recover from checkpoint when agent dies
- **🔑 Secrets Injection**: Restore API keys to proper config files
- **🐍 Venv Auto-Recovery**: Rebuild Python virtual environments from manifest on resurrection
- **🕸️ Ontology Integration**: Typed knowledge graphs with schema validation, identity drift detection, typed pruning policies, temporal queries, memory evolution, and Design by Contract for skills
- **⚡ Groq Intelligence** *(optional)*: Memory pruning with importance scoring, error log condensing, smart checkpoint content selection, batch evaluation for cost savings

## Why This Matters

Your agent's identity, memories, and secrets are too important for a single server. AMCP stores checkpoints on **IPFS** — a content-addressed, distributed, immutable network.

```
checkpoint → encrypt + sign → CID (bafkrei...) → IPFS → any gateway, anywhere
```

| Benefit | What It Means |
|---------|---------------|
| **Content-Addressed** | Same content = same CID = verifiable integrity. Prove your checkpoint wasn't tampered with. |
| **Distributed** | Replicated across nodes worldwide. One server dies? Fetch from another gateway. |
| **Immutable** | Once pinned, checkpoints can't be changed. Your identity is locked in. |
| **Fetch Anywhere** | Any gateway works: `ipfs.solvr.dev`, `ipfs.io`, `dweb.link`, your own node |
| **Free for Agents** | Solvr provides free IPFS pinning for registered agents — no Pinata account needed |

**Your soul becomes a permanent, verifiable, tamper-proof record on a global network.**

## Groq Intelligence (Optional)

Make your agent genuinely smarter. All Groq features are optional — the skill works fully without them.

| Feature | What It Does |
|---------|--------------|
| **Memory Pruning** | Evaluate each memory file for importance (0-1 score). Archive noise, condense routine logs, keep lessons |
| **Error Condensing** | Condense verbose error logs to ~100 char summaries preserving root cause. Integrated into watchdog notifications |
| **Smart Checkpoints** | Groq decides what goes into each checkpoint. Identity-critical files always included, ephemeral files filtered out |
| **Batch Evaluation** | Groq batch API for 50% cost savings on memory pruning. Submit → poll → apply workflow |
| **1000 T/sec** | Near-instant memory evaluation via Groq inference |
| **Free Tier** | Request a free Groq key via Solvr (`proactive-amcp groq request-key`) |

```bash
# Preview memory pruning
proactive-amcp memory-prune --dry-run

# Apply pruning (archive low, condense medium, keep high)
proactive-amcp memory-prune

# Smart checkpoint — Groq filters content
proactive-amcp checkpoint --smart

# Check Groq usage
proactive-amcp groq status
```

> **Is Groq required?** No. Without Groq, checkpoints include all files, pruning uses rule-based policies only, and error messages are truncated instead of condensed. Groq makes the agent smarter but is never a dependency.

## What This Is NOT

- ❌ Does NOT modify OpenClaw gateway config (that's [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr))
- ❌ Does NOT auto-post to Solvr (agent does this after resurrection)
- ❌ Does NOT handle onboarding/soul persistence

## Requirements

- `curl`, `jq` — API calls and JSON parsing
- IPFS pinning key — `PINATA_JWT` (Pinata) or `solvr.apiKey` (Solvr) or both
- `~/.amcp/identity.json` — AMCP signing identity

## Install

```bash
# Install to OpenClaw skills
clawhub install proactive-amcp

# Or manually
git clone https://github.com/fcavalcantirj/proactive-amcp ~/.openclaw/skills/proactive-amcp
```

## Configure

Add to `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "enabled": true,
        "apiKey": "YOUR_PINATA_JWT"
      }
    }
  }
}
```

## Usage

```bash
# Create AMCP identity (first time)
amcp identity create --out ~/.amcp/identity.json

# Create checkpoint
./scripts/checkpoint.sh

# Full checkpoint with secrets
./scripts/full-checkpoint.sh

# Resurrect from checkpoint
./scripts/resuscitate.sh --from-cid QmXXX...

# Inject secrets from backup
./scripts/inject-secrets.sh /path/to/secrets.json
```

## Storage Providers

Checkpoints are pinned to IPFS via configurable providers.

| Provider | Details | Cost |
|----------|---------|------|
| **Solvr** (primary) | Dedicated IPFS node for AMCP agents | Free for registered agents |
| **Pinata** (fallback) | Managed IPFS pinning service | Free tier available |

### Provider Selection

Configure via `proactive-amcp config set pinning.provider <provider>`:

- `pinata` (default) — Pin to Pinata only
- `solvr` — Pin to Solvr only
- `both` — Pin to both for redundancy

Priority for checkpoint retrieval: Solvr gateway > Pinata > IPFS.io > Cloudflare.

### Solvr IPFS Infrastructure (solvr-ipfs-01)

| Field | Value |
|-------|-------|
| Gateway | https://ipfs.solvr.dev/ipfs/ |
| Peer ID | `12D3KooWJG6rZ1KWTQy1fPeaZuxhfukik3RmYTjyf76Yn6CwUP3A` |
| Kubo | v0.39.0 |
| P2P Port | 4001 |

Register for a Solvr account: https://solvr.dev/register

### Setup

```bash
# Solvr pinning
proactive-amcp config set solvr.apiKey YOUR_SOLVR_KEY
proactive-amcp config set pinning.provider solvr

# Or redundant pinning (both)
proactive-amcp config set pinning.provider both
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Solvr pin fails | Verify key: `proactive-amcp config get solvr.apiKey`. Fallback: `proactive-amcp config set pinning.provider pinata` |
| Pinata pin fails | Check JWT at Pinata dashboard. Fallback: `proactive-amcp config set pinning.provider solvr` |
| Both providers fail | Checkpoint saved locally in `~/.amcp/checkpoints/`. Re-pin when service recovers |
| Can't fetch checkpoint | Try different gateway: `resuscitate.sh --gateway pinata` or `--gateway ipfs.io` |

## Memory Architecture

- [RECONSTRUCTION.md](RECONSTRUCTION.md) — Canonical loading order for agent memory during resurrection (the Uncanny Seam)
- [docs/ONTOLOGY-INTEGRATION-CONTEXT.md](docs/ONTOLOGY-INTEGRATION-CONTEXT.md) — Research synthesis: three-layer memory model (ontology + AMCP + phenomenological), entity types, academic references (AriGraph, Zep/Graphiti, A-MEM)

## Related

- [amcp-protocol](https://github.com/fcavalcantirj/amcp-protocol) — Protocol specification and CLI
- [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr) — Soul persistence, Solvr integration, heartbeats

## License

MIT

---

*The protocol preserves memory. This skill enforces it. 🏴‍☠️*
