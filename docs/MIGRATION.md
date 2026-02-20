# Migration Guide — Skill-Only to Plugin + Skill

Upgrading from proactive-amcp skill-only (v0.6.x / v0.7.x) to the combined plugin + skill architecture. The plugin adds real-time monitoring, gateway hooks, and CLI commands while your existing bash scripts continue working unchanged.

---

## Before You Start

### Back Up Your Data

```bash
# 1. Back up identity (CRITICAL — loss means unrecoverable checkpoints)
cp ~/.amcp/identity.json ~/.amcp/identity.json.backup

# 2. Back up config
cp ~/.amcp/config.json ~/.amcp/config.json.backup

# 3. Back up last checkpoint reference
cp ~/.amcp/last-checkpoint.json ~/.amcp/last-checkpoint.json.backup

# 4. Note your latest CID (in case you need to resurrect)
cat ~/.amcp/last-checkpoint.json | jq -r '.cid'
```

### Verify Current Setup

```bash
# Confirm your identity is valid KERI (not legacy sha256)
amcp identity validate --path ~/.amcp/identity.json

# Confirm skill layer is working
proactive-amcp status
```

If `status` returns `NO_IDENTITY` or `INVALID_IDENTITY`, fix that first — run `proactive-amcp init` before migrating.

---

## What Changes (and What Doesn't)

| Component | Before (skill-only) | After (plugin + skill) |
|-----------|---------------------|----------------------|
| Checkpoint creation | `full-checkpoint.sh` via cron/manual | Same — plugin delegates to `full-checkpoint.sh` |
| Checkpoint triggers | Cron schedule only | Cron + gateway hooks + context monitor |
| Identity validation | `validate_identity()` in each script | Same + plugin verifies on gateway start |
| Secret scanning | `scan-secrets.sh` during checkpoint | Same (no change) |
| IPFS pinning | Pinata / Solvr / both | Same (no change) |
| Health monitoring | `watchdog.sh` via systemd/cron | Same + plugin context/memory monitors |
| Resurrection | `resuscitate.sh` (3-tier) | Same + plugin detects context wipes |
| Memory integrity | N/A | **New** — SHA-256 baseline + prompt injection scan |
| Config files | `~/.amcp/config.json` | Same + plugin config in `openclaw.json` |
| CLI commands | `proactive-amcp <cmd>` | Same + `openclaw amcp <cmd>` via gateway |

**Key point:** The skill layer works identically before and after migration. The plugin adds a monitoring layer on top — it never replaces bash scripts.

---

## Step 1 — Update proactive-amcp

Pull the latest version that includes both plugin and skill:

```bash
# If installed via git
cd ~/.openclaw/skills/proactive-amcp
git pull origin main
npm install && npm run build

# If installed via clawhub
clawhub update proactive-amcp

# If installed via npm
npm update -g proactive-amcp
```

Verify the build succeeded:

```bash
ls ~/.openclaw/skills/proactive-amcp/dist/index.js
# Should exist — this is the compiled plugin entry point
```

---

## Step 2 — Add Plugin Config to Gateway

Edit `~/.openclaw/openclaw.json` to register the plugin. If you already have a `skills` section for proactive-amcp, you'll now add a `plugins` section alongside it.

### Minimal Config (recommended to start)

```json
{
  "plugins": {
    "proactive-amcp": {
      "enabled": true
    }
  }
}
```

This enables the plugin with sensible defaults: auto-checkpoint on gateway lifecycle events, 70% context threshold, 5-minute cooldown, memory integrity monitoring, identity verification on start.

### Full Config (all options shown)

```json
{
  "plugins": {
    "proactive-amcp": {
      "enabled": true,
      "autoCheckpoint": true,
      "checkpointIntervalMs": 0,
      "contextThreshold": 70,
      "ipfsPinningService": "solvr",
      "encryptionKeyPath": "~/.amcp/identity.json",
      "checkpointCooldownMs": 300000,
      "memoryIntegrity": {
        "enabled": true,
        "promptInjectionScan": true,
        "autoRestore": false
      },
      "identity": {
        "autoInject": true,
        "verifyOnStart": true
      },
      "resurrection": {
        "autoDetect": true,
        "injectRecoveryPrompt": true
      }
    }
  }
}
```

### Preserving Your Existing Skills Config

Your existing `skills.entries.proactive-amcp` config is separate from the plugin config. Both can coexist:

```json
{
  "skills": {
    "entries": {
      "proactive-amcp": {
        "enabled": true,
        "apiKey": "YOUR_PINATA_JWT"
      }
    }
  },
  "plugins": {
    "proactive-amcp": {
      "enabled": true
    }
  }
}
```

The skill reads from `skills.entries`. The plugin reads from `plugins`. They don't conflict.

---

## Step 3 — Config Migration

Your AMCP config (`~/.amcp/config.json`) does not change — the plugin reads it as-is. No migration needed for:

- `pinata.jwt`
- `solvr.apiKey`
- `pinning.provider`
- `notify.target`
- `groq.apiKey`
- `watchdog.interval`
- `checkpoint.schedule`

### IPFS Provider Mapping

If you configured `pinning.provider` in AMCP config, set the matching plugin config:

| AMCP `pinning.provider` | Plugin `ipfsPinningService` |
|------------------------|-----------------------------|
| `pinata` | `"pinata"` |
| `solvr` | `"solvr"` |
| `both` | `"solvr"` (plugin config is for monitor display only — actual pinning uses AMCP config) |

The plugin's `ipfsPinningService` setting controls the plugin's awareness of which provider is active. The actual pinning logic in `full-checkpoint.sh` always reads from `~/.amcp/config.json`.

---

## Step 4 — Restart Gateway

```bash
# Restart the OpenClaw gateway to load the plugin
systemctl --user restart openclaw-gateway

# Or if using a different service manager
openclaw restart
```

### Verify Plugin Loaded

```bash
# Check plugin status via gateway CLI
openclaw amcp status
```

You should see:
- Identity: validated (your AID)
- Monitors: running
- Last checkpoint: your most recent CID
- Config: summary of active settings

If the plugin didn't load, check gateway logs for errors:

```bash
journalctl --user -u openclaw-gateway --since "5 minutes ago" | grep -i amcp
```

---

## Step 5 — Verify End-to-End

### Test Checkpoint via Plugin

```bash
# Trigger a manual checkpoint through the plugin CLI
openclaw amcp checkpoint
```

This should:
1. Invoke `full-checkpoint.sh` (same pipeline as before)
2. Pin to IPFS (Solvr/Pinata per your AMCP config)
3. Update `~/.amcp/last-checkpoint.json`
4. Log to `~/.amcp/checkpoint-log.jsonl`

### Test Standalone Skill (still works)

```bash
# Direct skill invocation (bypasses plugin)
bash ~/.openclaw/skills/proactive-amcp/scripts/full-checkpoint.sh
```

This should produce the same result. The skill layer is independent of the plugin.

### Verify Monitors Are Active

```bash
openclaw amcp status
```

Look for:
- Context Monitor: polling every 30s
- Memory Integrity: baseline established
- Identity Service: validated
- Resurrection Detector: watching for context drops

---

## Cron/Systemd Coexistence

Your existing cron or systemd checkpoint schedule continues to work alongside the plugin. This provides defense-in-depth:

| Trigger Source | When | Purpose |
|---------------|------|---------|
| **Cron/systemd** | Fixed schedule (e.g., every 4 hours) | Baseline periodic checkpoints |
| **Plugin hooks** | Gateway start/stop, session end | Event-driven checkpoints |
| **Plugin monitors** | Context threshold, value changes | Real-time protection |

The plugin's `checkpointCooldownMs` (default: 5 minutes) prevents duplicate checkpoints when multiple triggers fire close together.

If you want to remove cron/systemd checkpoints after migration (the plugin handles it now), you can — but keeping both is recommended for resilience. The skill layer protects you even if the gateway crashes.

---

## New Capabilities After Migration

These features only work with the plugin installed:

### Memory Integrity Monitoring

The plugin watches all memory files via SHA-256 baselines, detecting unauthorized changes and prompt injection attempts.

```bash
# Check for detections
cat ~/.amcp/memory-injection.jsonl
```

### Context-Aware Checkpoints

The plugin monitors context usage and triggers checkpoints before compaction erases agent memory.

```bash
# View context history
cat ~/.amcp/context-history.jsonl
```

### Resurrection Detection

The plugin detects sudden context drops and automatically injects recovery instructions.

```bash
# View detection log
cat ~/.amcp/resurrection-log.jsonl
```

### Plugin CLI

Six new commands accessible via the gateway:

```bash
openclaw amcp status        # Full AMCP status
openclaw amcp checkpoint    # Create checkpoint
openclaw amcp resurrect     # Restore from checkpoint
openclaw amcp identity show # Show KERI identity
openclaw amcp history       # Checkpoint trigger history
openclaw amcp verify        # Verify checkpoint integrity
```

---

## Rollback

If something goes wrong, disable the plugin without affecting the skill layer:

### Quick Disable

Set `"enabled": false` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "proactive-amcp": {
      "enabled": false
    }
  }
}
```

Restart the gateway. The skill layer (cron, watchdog, manual checkpoints) continues operating normally.

### Full Rollback

```bash
# 1. Disable plugin in config
# (edit openclaw.json as above)

# 2. Restore backups if needed
cp ~/.amcp/identity.json.backup ~/.amcp/identity.json
cp ~/.amcp/config.json.backup ~/.amcp/config.json

# 3. Restart gateway
systemctl --user restart openclaw-gateway

# 4. Verify skill layer works
proactive-amcp status
```

Your existing cron/systemd services are unaffected by plugin installation or removal.

---

## Fleet Migration (openclaw-deploy)

For fleet deployments via openclaw-deploy, the migration happens automatically in `master-setup.sh`:

1. `npm install` pulls the latest proactive-amcp (includes plugin)
2. `proactive-amcp install` sets up config and services (unchanged)
3. Plugin config is added to `~/.openclaw/openclaw.json` during gateway setup

No changes to `deploy.sh` flags are required. The plugin is enabled by default when the package includes `openclaw.plugin.json` and `dist/index.js`.

### Manual Fleet Update

For existing child VMs, SSH in and:

```bash
# Update the package
cd ~/.openclaw/skills/proactive-amcp && git pull && npm install && npm run build

# Add plugin config (if not already present)
python3 -c "
import json, os
p = os.path.expanduser('~/.openclaw/openclaw.json')
c = json.load(open(p))
if 'plugins' not in c:
    c['plugins'] = {}
if 'proactive-amcp' not in c.get('plugins', {}):
    c['plugins']['proactive-amcp'] = {'enabled': True}
    json.dump(c, open(p, 'w'), indent=2)
    print('Plugin config added')
else:
    print('Plugin config already present')
"

# Restart gateway
systemctl --user restart openclaw-gateway
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin not loading | Check `dist/index.js` exists (`npm run build`). Check Node.js >= 18. |
| `openclaw amcp status` not found | Plugin not registered. Verify `openclaw.plugin.json` exists and `plugins` section in `openclaw.json`. |
| Checkpoint conflicts (cron + plugin) | Normal — cooldown prevents duplicates. Increase `checkpointCooldownMs` if needed. |
| Plugin errors in logs | Check `journalctl --user -u openclaw-gateway`. Common: identity not found, build not run. |
| Memory baseline not established | Plugin needs one successful start. Check `~/.amcp/memory-baseline.json` exists. |
| Skill commands still work? | Yes — `proactive-amcp <cmd>` always works. Plugin CLI is additive (`openclaw amcp <cmd>`). |
| Old checkpoints compatible? | Yes — checkpoint format is unchanged. Old CIDs work with new version. |

---

## Summary

| Step | Action | Time |
|------|--------|------|
| **Backup** | Copy identity.json, config.json, last-checkpoint.json | 1 min |
| **Update** | Pull latest, `npm install && npm run build` | 2 min |
| **Configure** | Add `plugins.proactive-amcp` to openclaw.json | 1 min |
| **Restart** | Restart gateway | 30 sec |
| **Verify** | `openclaw amcp status` + test checkpoint | 2 min |

The migration is additive — nothing is removed, replaced, or broken. The plugin layer adds real-time monitoring and gateway integration on top of the existing skill infrastructure.

---

*The skill protected you before. The plugin watches over you now. Together, your soul persists.*
