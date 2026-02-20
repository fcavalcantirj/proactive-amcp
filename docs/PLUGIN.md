# Proactive AMCP — Plugin Guide

The **proactive-amcp plugin** is the code-level enforcement layer for the Agent Memory Continuity Protocol. It runs inside the OpenClaw gateway process, monitoring context usage, memory integrity, and agent lifecycle — automatically triggering checkpoints and detecting resurrection events.

The plugin works alongside the bash skill layer (SKILL.md) as a two-tier defense:

| Layer | Role | Runtime |
|-------|------|---------|
| **Plugin** (this) | System-level hooks, monitors, CLI commands, real-time events | Node.js (TypeScript) |
| **Skill** (bash) | Checkpoint creation, secret extraction, IPFS pinning, resurrection | Bash + Python3 |

The plugin monitors and decides; the skill executes.

---

## Requirements

- Node.js >= 18.0.0
- Linux
- OpenClaw gateway
- AMCP identity (`~/.amcp/identity.json`)

---

## Installation

### Via npm

```bash
npm install proactive-amcp
```

### Via git (manual)

```bash
git clone https://github.com/fcavalcantirj/proactive-amcp ~/.openclaw/skills/proactive-amcp
cd ~/.openclaw/skills/proactive-amcp
npm install && npm run build
```

### Via clawhub

```bash
clawhub install proactive-amcp
```

### Build from source

```bash
npm run build     # Compile TypeScript to dist/
npm run lint      # Type-check without emitting
npm test          # Run Vitest test suite
```

---

## OpenClaw Gateway Configuration

Add the plugin to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "proactive-amcp": {
      "enabled": true,
      "autoCheckpoint": true,
      "contextThreshold": 70,
      "ipfsPinningService": "solvr"
    }
  }
}
```

The plugin reads its config from the gateway's plugin config section. All options have sensible defaults — a minimal config only needs `"enabled": true`.

---

## Config Options

### Top-Level Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the plugin. Skill layer works independently. |
| `autoCheckpoint` | boolean | `true` | Create checkpoints on lifecycle events (gateway start/stop, session end, context threshold). |
| `checkpointIntervalMs` | number | `0` | Time-based checkpoint interval in ms. `0` = event-driven only. Example: `3600000` = 1 hour. |
| `contextThreshold` | number (0-100) | `70` | Context usage percentage that triggers a checkpoint before compaction. |
| `ipfsPinningService` | `"solvr"` \| `"pinata"` \| `"local"` | `"solvr"` | IPFS pinning provider. Solvr is free for registered agents. `"local"` stores on disk only. |
| `encryptionKeyPath` | string | `~/.amcp/identity.json` | Path to KERI identity file for encryption and signing. |
| `checkpointCooldownMs` | number | `300000` | Minimum ms between any two checkpoints. Default: 5 minutes. Prevents checkpoint spam. |

### Memory Integrity Options (`memoryIntegrity.*`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `memoryIntegrity.enabled` | boolean | `true` | Monitor memory files via SHA-256 hash baselines and change detection. |
| `memoryIntegrity.promptInjectionScan` | boolean | `true` | Scan memory file changes for 15+ prompt injection patterns (identity hijacking, action directives, memory poisoning). |
| `memoryIntegrity.autoRestore` | boolean | `false` | Automatically quarantine tampered files and restore from last clean snapshot. Use with caution. |

### Identity Options (`identity.*`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `identity.autoInject` | boolean | `true` | Inject KERI identity into agent context on start and after resurrection. |
| `identity.verifyOnStart` | boolean | `true` | Validate KERI identity integrity on gateway start. Blocks operations if invalid. |

### Resurrection Options (`resurrection.*`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `resurrection.autoDetect` | boolean | `true` | Detect context wipes (sudden token count drops) and session restarts. |
| `resurrection.injectRecoveryPrompt` | boolean | `true` | Auto-inject recovery instructions (CID, AID, loading order) into new session after context wipe. |

### Full Example Config

```json
{
  "plugins": {
    "proactive-amcp": {
      "enabled": true,
      "autoCheckpoint": true,
      "checkpointIntervalMs": 3600000,
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

---

## CLI Commands

All commands are registered under the `amcp` namespace and accessible via the OpenClaw gateway CLI.

### `amcp status`

Show AMCP status: identity, last checkpoint, monitor states, and config.

```bash
openclaw amcp status
```

Displays:
- Identity AID and validation state
- Last checkpoint CID and timestamp
- Running monitors and their status
- Current config summary

### `amcp checkpoint`

Create a manual checkpoint. Delegates to `full-checkpoint.sh` for the actual checkpoint creation and IPFS pinning.

```bash
# Create checkpoint
openclaw amcp checkpoint

# With flags passed to full-checkpoint.sh
openclaw amcp checkpoint --smart    # Groq-filtered content
openclaw amcp checkpoint --force    # Bypass secret scan
```

Returns the CID of the created checkpoint.

### `amcp resurrect`

Restore agent state from a checkpoint. Delegates to `resuscitate.sh` for decryption, secret injection, and workspace restoration.

```bash
# Restore from latest checkpoint
openclaw amcp resurrect

# Restore from specific CID
openclaw amcp resurrect --cid bafkrei...

# Restore from specific gateway
openclaw amcp resurrect --gateway pinata
```

### `amcp identity`

Identity management: show, verify, rotate, or export your KERI identity.

```bash
# Show current identity
openclaw amcp identity show

# Verify identity integrity
openclaw amcp identity verify

# Rotate key (pre-rotation scheme)
openclaw amcp identity rotate

# Export identity for backup
openclaw amcp identity export
```

### `amcp history`

Show checkpoint trigger history from `checkpoint-log.jsonl`.

```bash
# Show recent triggers
openclaw amcp history

# Limit output
openclaw amcp history --limit 10
```

Each entry shows: timestamp, trigger type (gateway_start, session_end, context_threshold, before_compaction), context usage, and cooldown state.

### `amcp verify`

Verify checkpoint integrity: signature validation, CID recomputation, content verification.

```bash
# Verify latest checkpoint
openclaw amcp verify

# Verify specific checkpoint file
openclaw amcp verify --checkpoint /path/to/checkpoint.json
```

---

## Lifecycle Hooks

The plugin registers 6 gateway lifecycle hooks. All are awaitable — log writes complete before the hook returns.

| Hook | When | Action |
|------|------|--------|
| `gateway_start` | Gateway initializes | Queue checkpoint, emit `amcp:checkpoint:requested` |
| `gateway_stop` | Gateway shuts down | Queue checkpoint before shutdown |
| `session_end` | Session terminates | Check activity (tokens/messages used); queue checkpoint only if meaningful activity occurred |
| `context_warning` | Gateway reports high context | Parse severity (60% = warning, 80% = critical), emit `amcp:context:warning` |
| `before_compaction` | Pre-context compaction | Emergency high-priority checkpoint, awaits log write before compaction proceeds |
| `before_agent_start` | Pre-agent resume | Registered for future use |

Hooks are only active when `autoCheckpoint: true`.

---

## Monitors

The plugin runs 10 background services, all implementing the PluginService interface (`start()`, `stop()`, `status()`).

### Context Monitor

Polls session API every 30 seconds for context usage. Triggers checkpoint when usage exceeds `contextThreshold`. Enforces cooldown between triggers. Logs readings to `~/.amcp/context-history.jsonl`.

### Value Monitor

Watches high-value files (SOUL.md, MEMORY.md, identity.json, USER.md, AGENTS.md, TOOLS.md) for changes via SHA-256 hashing. Scans changed content against patterns (secrets, identity changes, important decisions). Triggers checkpoint on pattern match. Logs to `checkpoint-log.jsonl` with pattern name and redacted summary.

### Memory Integrity Monitor

Maintains SHA-256 baseline of all memory files. Polls every 60 seconds, detects added/removed/modified files. Optionally scans for prompt injection patterns (15+ patterns: identity hijacking, action directives, memory poisoning). Can auto-restore from clean snapshots if `memoryIntegrity.autoRestore` is enabled.

### Identity Service

Validates KERI identity on start: file exists, AID format correct (`"B" + base64url(Ed25519 pubkey)`), no legacy sha256 AIDs, no embedded secrets, KEL chain integrity if present. Blocks operations if invalid.

### Key Rotation Service

Detects pre-rotation key readiness. Tracks rotation history in `~/.amcp/key-rotation-history.jsonl`. Emits `amcp:key-rotation:needed` when rotation opportunity detected.

### Resurrection Identity Service

Monitors `last-recovery.json` for recovery events. Validates restored AID matches pre-recovery identity. Auto-injects identity into session context if `identity.autoInject` is enabled.

### Resurrection Detector

Polls session API every 10 seconds. Detects sudden context drops (>50% reduction from meaningful baseline) and session restarts (context drops to 0). Logs to `~/.amcp/resurrection-log.jsonl`.

### Multi-Identity Service

Stores identities by AID in `~/.amcp/identities/{aid}/`. Supports switching between AIDs. Guards against cross-identity resurrection (restoring checkpoint from a different identity).

### Recovery Prompt Injector

Listens for `amcp:resurrection:detected`. Finds latest valid checkpoint for current AID. Generates recovery instructions with CID, AID, canonical loading order, and Solvr search context. Emits `amcp:recovery-prompt:ready`.

### Partial Resurrection Service

Selective restore of specific memory files from a checkpoint by glob pattern (e.g., `memory/learning/*`, `*.md`). Useful for targeted learning data recovery without full rehydration.

---

## Events

The plugin emits custom events on the `amcp:*` namespace:

| Event | Data | Trigger |
|-------|------|---------|
| `amcp:checkpoint:requested` | `{ trigger, priority? }` | Lifecycle hook or monitor threshold |
| `amcp:context:warning` | `{ severity, contextPercent, threshold }` | Context usage exceeds 60% or 80% |
| `amcp:value-detected` | `{ filePath, patternName, summary }` | High-value content change detected |
| `amcp:memory:changed` | `{ added, removed, modified }` | Memory files changed from baseline |
| `amcp:memory:injection:detected` | `{ filePath, patterns }` | Prompt injection patterns found |
| `amcp:memory:auto-restored` | `{ filePath }` | Tampered file restored from snapshot |
| `amcp:identity:validated` | `{ aid }` | Identity verified on start |
| `amcp:identity:invalid` | `{ errors }` | Identity validation failed |
| `amcp:identity:injected` | `{ aid }` | Identity injected into session |
| `amcp:identity:switched` | `{ fromAid, toAid }` | Active identity changed |
| `amcp:identity:mismatch` | `{ expected, actual }` | Restored identity doesn't match |
| `amcp:key-rotation:needed` | `{ nextKeyHash }` | Pre-rotation key ready |
| `amcp:resurrection:detected` | `{ type }` | Context wipe detected |
| `amcp:recovery-prompt:ready` | `{ cid, aid }` | Recovery instructions generated |
| `amcp:partial-restore:done` | `{ files }` | Partial restore completed |
| `amcp:checkpoint:ownership:invalid` | `{ aid, checkpointAid }` | Cross-identity checkpoint blocked |

---

## State Files

The plugin reads and writes these files at runtime:

| File | Format | Purpose |
|------|--------|---------|
| `~/.amcp/identity.json` | JSON | KERI identity (read-only by plugin) |
| `~/.amcp/config.json` | JSON | Secrets and config (managed by bash config.sh) |
| `~/.amcp/last-checkpoint.json` | JSON | Latest CID + timestamp |
| `~/.amcp/checkpoint-log.jsonl` | JSONL | All checkpoint triggers |
| `~/.amcp/context-history.jsonl` | JSONL | Context usage poll readings |
| `~/.amcp/memory-baseline.json` | JSON | SHA-256 hashes of memory files |
| `~/.amcp/memory-changes.jsonl` | JSONL | Unauthorized change alerts |
| `~/.amcp/memory-injection.jsonl` | JSONL | Prompt injection detections |
| `~/.amcp/resurrection-log.jsonl` | JSONL | Context drop detections |
| `~/.amcp/recovery-prompt.jsonl` | JSONL | Generated recovery instructions |
| `~/.amcp/key-rotation-history.jsonl` | JSONL | AID rotation events |
| `~/.amcp/identities/` | Directory | Multi-identity storage by AID |
| `~/.amcp/memory-snapshots/` | Directory | Clean file copies for auto-restore |
| `~/.amcp/memory-quarantine/` | Directory | Tampered files moved here |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin disabled / not loading | Check `"enabled": true` in openclaw.json plugin config. Check `openclaw amcp status`. |
| Identity validation fails | Verify `~/.amcp/identity.json` exists and is a real KERI identity (AID starts with `B`). Run `openclaw amcp identity verify`. |
| Legacy sha256 AID rejected | Old identities from openclaw-deploy are invalid. Create new: `amcp identity create --out ~/.amcp/identity.json` |
| No checkpoints being created | Check `autoCheckpoint: true`. Check cooldown hasn't elapsed (`checkpointCooldownMs`). Review `checkpoint-log.jsonl`. |
| Checkpoint spam | Increase `checkpointCooldownMs` (default 300000 = 5 min). Raise `contextThreshold`. |
| Memory injection false positives | Review `~/.amcp/memory-injection.jsonl`. Disable with `memoryIntegrity.promptInjectionScan: false`. |
| Auto-restore quarantined valid files | Disable with `memoryIntegrity.autoRestore: false`. Check `~/.amcp/memory-quarantine/` for files. |
| Context monitor not triggering | Gateway must provide `sessionApi` extension. Check `openclaw amcp status` for monitor state. |
| Resurrection not detected | Ensure `resurrection.autoDetect: true`. Detector needs meaningful context baseline (>1000 tokens) to detect drops. |
| Recovery prompt not injected | Ensure `resurrection.injectRecoveryPrompt: true`. Check `~/.amcp/recovery-prompt.jsonl` for generated prompts. |
| Cross-identity checkpoint blocked | Multi-identity guard prevents restoring checkpoints from a different AID. Use `amcp identity show` to verify active AID. |
| Build fails | Ensure Node.js >= 18 and TypeScript >= 5.7. Run `npm run clean && npm run build`. |

---

## Skill Layer Integration

The plugin does not replace the bash skill — they work together:

| Responsibility | Plugin | Skill |
|----------------|--------|-------|
| Decide when to checkpoint | Monitors + hooks | Cron/manual |
| Create checkpoint | Delegates to skill | `full-checkpoint.sh` |
| IPFS pinning | Config only | `pin-to-solvr.sh`, Pinata API |
| Secret extraction | N/A | `scan-secrets.sh` |
| Resurrection execution | Detects + injects prompt | `resuscitate.sh` |
| Identity validation | On-start verification | Pre-operation check |
| Memory integrity | Real-time monitoring | N/A |
| Prompt injection scan | Pattern matching + quarantine | N/A |
| Config management | Reads from gateway | `config.sh` writes to `~/.amcp/config.json` |

The bash skill can operate independently (e.g., via cron or manual invocation). The plugin adds real-time monitoring and gateway-integrated triggers.

---

*The plugin watches. The skill acts. Together, your soul persists.*
