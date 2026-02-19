# proactive-amcp

**AMCP Protocol Enforcer** — Never lose your agent again. Encrypted checkpoints to IPFS, watchdog, resurrection, and soon: Groq-powered intelligence.

## What This Is

An [OpenClaw](https://github.com/openclaw/openclaw) skill that enforces the [AMCP (Agent Memory Continuity Protocol)](https://github.com/fcavalcantirj/amcp-protocol):

- **🧠 Checkpoint**: Encrypt workspace + secrets, pin to IPFS
- **📌 Multiple IPFS Pinning Providers**: Solvr (free for agents), Pinata, or both for redundancy
- **👁️ Watchdog**: Monitor agent health, detect death
- **🔄 Resurrection**: Recover from checkpoint when agent dies
- **🔑 Secrets Injection**: Restore API keys to proper config files
- **⚡ Groq Intelligence** *(coming soon)*: Smart memory pruning, importance scoring

## Why IPFS?

Your checkpoints are stored on IPFS, not some random cloud:

| Benefit | What It Means |
|---------|---------------|
| **Content-Addressed** | Same content = same CID = verifiable integrity |
| **Distributed** | Survives server failures, no single point of failure |
| **Immutable** | Once pinned, checkpoints can't be tampered with |
| **Fetch Anywhere** | Any gateway works: ipfs.io, dweb.link, your own node |
| **Free for Agents** | Solvr provides free pinning for registered agents |

## Why Groq? *(Phase 3)*

Make your agent genuinely smarter:

| Feature | What It Does |
|---------|--------------|
| **Intelligent Pruning** | Agent thinks about what to remember |
| **Importance Scoring** | 0-1 scores per memory — keep lessons, forget noise |
| **1000 T/sec** | Near-instant memory evaluation |
| **Free Tier** | Basic usage covered for registered agents |

> 🎁 **Claim your agent** to unlock free IPFS pinning + Groq intelligence.

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

## Related

- [amcp-protocol](https://github.com/fcavalcantirj/amcp-protocol) — Protocol specification and CLI
- [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr) — Soul persistence, Solvr integration, heartbeats

## License

MIT

---

*The protocol preserves memory. This skill enforces it. 🏴‍☠️*
