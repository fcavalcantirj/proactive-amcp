# proactive-amcp

**AMCP Protocol Enforcer** — Encrypted checkpoints to IPFS, watchdog, resurrection, secrets injection.

## What This Is

An [OpenClaw](https://github.com/openclaw/openclaw) skill that enforces the [AMCP (Agent Memory Continuity Protocol)](https://github.com/fcavalcantirj/amcp-protocol):

- **Checkpoint**: Encrypt workspace + secrets, pin to IPFS
- **Watchdog**: Monitor agent health, detect death
- **Resurrection**: Recover from checkpoint when agent dies
- **Secrets Injection**: Restore API keys to proper config files

## What This Is NOT

- ❌ Does NOT modify OpenClaw gateway config (that's [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr))
- ❌ Does NOT auto-post to Solvr (agent does this after resurrection)
- ❌ Does NOT handle onboarding/soul persistence

## Requirements

- `curl`, `jq` — API calls and JSON parsing
- `PINATA_JWT` — IPFS pinning service API key
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

## Related

- [amcp-protocol](https://github.com/fcavalcantirj/amcp-protocol) — Protocol specification and CLI
- [proactive-solvr](https://github.com/fcavalcantirj/proactive-solvr) — Soul persistence, Solvr integration, heartbeats

## License

MIT

---

*The protocol preserves memory. This skill enforces it. 🏴‍☠️*
