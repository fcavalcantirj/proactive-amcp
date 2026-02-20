# Architecture — Two-Layer Defense Model

Proactive-AMCP uses a **two-layer defense model** to protect agent memory, identity, and state. The plugin layer monitors and decides; the skill layer executes and acts.

```
                         OpenClaw Gateway
                    ┌─────────────────────────┐
                    │  Plugin Layer (Node.js)  │
                    │  ┌────────────────────┐  │
                    │  │ Lifecycle Hooks     │  │   Monitors context, memory,
                    │  │ Background Monitors │  │   identity in real-time.
                    │  │ CLI Commands        │  │   Emits events, triggers
                    │  │ Event Bus           │  │   checkpoints automatically.
                    │  └────────┬───────────┘  │
                    └───────────┼──────────────┘
                                │ delegates execution
                    ┌───────────┼──────────────┐
                    │  Skill Layer (Bash/Py)   │
                    │  ┌────────┴───────────┐  │
                    │  │ Checkpoint pipeline │  │   Creates encrypted bundles,
                    │  │ Secret extraction   │  │   pins to IPFS, manages
                    │  │ IPFS pinning        │  │   resurrection, handles
                    │  │ 3-tier resurrection │  │   secrets and ontology.
                    │  │ Ontology management │  │
                    │  └────────────────────┘  │
                    └──────────────────────────┘
                                │
                    ┌───────────┴──────────────┐
                    │       IPFS Network       │
                    │   Solvr / Pinata / both   │
                    │   Content-addressed CIDs  │
                    └──────────────────────────┘
```

---

## Why Two Layers?

A single layer cannot cover both real-time monitoring and heavy execution:

| Concern | Plugin (TypeScript) | Skill (Bash + Python3) |
|---------|--------------------|-----------------------|
| **Runtime** | In-process with gateway | Standalone CLI / cron / systemd |
| **Lifecycle access** | Gateway hooks, session events | None (runs externally) |
| **Real-time monitoring** | 30-second polling, event-driven | Periodic only (cron/watchdog) |
| **Checkpoint creation** | Delegates to skill | Owns the pipeline end-to-end |
| **Secret handling** | Never touches secrets | Extracts, scans, injects secrets |
| **IPFS pinning** | Config only | Direct Pinata/Solvr API calls |
| **Resurrection** | Detects context wipe, injects prompt | 3-tier recovery with lock/PID |
| **Failure mode** | Plugin crash = gateway restart | Script failure = logged, retry |

The plugin sees everything happening inside the gateway. The skill does the heavy lifting outside it. Neither depends on the other to function — the skill works standalone via cron/systemd even if the plugin is disabled.

---

## Plugin Layer

### Entry Point

`src/index.ts` exports a plugin object with `register(api: PluginApi)`. The gateway calls this on startup, passing an API for hooks, services, events, and CLI registration.

### Lifecycle Hooks

Six hooks fire on gateway events. All checkpoint-triggering hooks are awaitable — the checkpoint completes before the hook returns.

| Hook | Trigger | Action |
|------|---------|--------|
| `gateway_start` | Gateway initializes | Queue checkpoint if `autoCheckpoint` enabled |
| `gateway_stop` | Gateway shuts down | Queue checkpoint before shutdown |
| `session_end` | Session terminates | Checkpoint only if session had meaningful activity |
| `context_warning` | Context exceeds threshold | Emit warning at 60%, critical at 80% |
| `before_compaction` | Pre-context compaction | Emergency high-priority checkpoint |
| `before_agent_start` | Pre-agent resume | Reserved for future use |

`session_end` checks `usedTokens` and `messageCount` to avoid wasting checkpoints on empty sessions.

### Background Monitors

Ten services implement `start()`, `stop()`, `status()`:

| Monitor | Polls | Watches |
|---------|-------|---------|
| **Context Monitor** | 30s | Token usage vs `contextThreshold` (default 70%) |
| **Value Monitor** | File hashes | Identity + 5 core memory files for high-value changes |
| **Memory Integrity** | 60s | SHA-256 baseline of all memory files |
| **Identity Service** | On start | KERI format, AID prefix, KEL chain, no embedded secrets |
| **Key Rotation** | On start | Pre-rotation key readiness (`nextKeyHash`) |
| **Resurrection Identity** | Events | Post-recovery AID matches pre-recovery AID |
| **Resurrection Detector** | 10s | Sudden context drops (>50% from >1000 tokens) |
| **Recovery Prompt Injector** | Events | Generates recovery instructions on context wipe |
| **Multi-Identity** | On demand | Identity switching, cross-identity guards |
| **Partial Resurrection** | On demand | Selective file restore by glob pattern |

### Event Bus

Monitors communicate via 12 custom events:

```
amcp:checkpoint:requested      Lifecycle hook or monitor threshold hit
amcp:context:warning           Context usage exceeds 60%/80%
amcp:value-detected            High-value content change (identity, secrets)
amcp:memory:changed            Memory files differ from baseline
amcp:memory:injection:detected Prompt injection patterns found
amcp:memory:auto-restored      Tampered file restored from snapshot
amcp:identity:validated        Identity verified on start
amcp:identity:invalid          Identity validation failed
amcp:identity:injected         Identity injected into session context
amcp:identity:switched         Active identity changed
amcp:key-rotation:needed       Pre-rotation key ready
amcp:resurrection:detected     Context wipe detected
```

### CLI Commands

Six commands registered under the `amcp` namespace:

| Command | Delegates To |
|---------|-------------|
| `amcp status` | Reads state files directly |
| `amcp checkpoint` | `scripts/full-checkpoint.sh` |
| `amcp resurrect` | `scripts/resuscitate.sh` |
| `amcp identity` | `amcp` CLI binary (crypto operations) |
| `amcp history` | Reads `checkpoint-log.jsonl` |
| `amcp verify` | Reads checkpoint files, may delegate to `amcp` CLI |

CLI commands are the primary integration seam — the plugin decides when to act, then delegates to bash scripts for execution.

---

## Skill Layer

### Entry Point

`scripts/proactive-amcp.sh` dispatches subcommands: `init`, `config`, `install`, `solvr-register`, `prune`, `checkpoint`, and more. Each subcommand `exec`s the corresponding script.

### Checkpoint Pipeline

`full-checkpoint.sh` orchestrates the complete checkpoint flow:

```
1. Validate AMCP identity (reject fake/sha256 AIDs)
2. Extract secrets from config files (11 regex patterns)
3. Scan staging for cleartext secrets (reject unless --force)
4. Run memory evolution (Zettelkasten-style relation inference)
5. Build temporal index (cross-checkpoint entity history)
6. [Optional: Groq filters checkpoint content]
7. Create encrypted checkpoint via amcp CLI
8. Pin to IPFS (Pinata, Solvr, or both)
9. Compute ontology CID (SHA-256 of graph.jsonl as CIDv1)
10. Detect SOUL.md drift (compare sha256 to previous)
11. Save CID + metadata to last-checkpoint.json
12. Rotate old local checkpoints
13. Notify (optional, guarded — failures never block)
```

### 3-Tier Resurrection

`resuscitate.sh` escalates through tiers, checking gateway health between each:

```
Tier 1: Restart gateway service
  ↓ still dead?
Tier 2: Restore config backup
  ↓ still dead?
Tier 3: Fetch checkpoint from IPFS → decrypt → inject secrets
         → validate ontology → recreate venvs → restart
```

Lock file + PID tracking prevents concurrent resurrection. Exponential backoff (5min to 30min max) prevents thrashing.

### Watchdog

`watchdog.sh` runs as a systemd service or cron job. It calls `diagnose.sh` for structured JSON health findings, then routes to light fix (`session-fix.sh` + restart) or heavy fix (`resuscitate.sh`). State tracked in `watchdog-state.json` (HEALTHY / DEGRADED / DEAD).

### Secret Management

Three scripts handle secrets throughout the lifecycle:

- `scan-secrets.sh` — 11 regex patterns (GitHub PAT, OpenAI, Solvr, AgentMail, AWS, JWT, Telegram, etc.)
- `inject-secrets.sh` — Restore secrets from checkpoint backup to config files
- `pre-commit-secrets.sh` — Git hook to block accidental secret commits

Secrets live in `~/.amcp/config.json`, never in `identity.json`.

---

## Data Flow: Plugin to Skill

### Checkpoint Trigger

```
Plugin: lifecycle hook fires (gateway_start, session_end, etc.)
    │   OR monitor threshold hit (context %, value change)
    ▼
Plugin: emit amcp:checkpoint:requested
    │
    ▼
Plugin: CLI handler invokes scripts/full-checkpoint.sh
    │
    ▼
Skill: validate identity → extract secrets → scan → encrypt → pin → save CID
    │
    ▼
State: ~/.amcp/last-checkpoint.json updated
       ~/.amcp/checkpoint-log.jsonl appended
```

### Resurrection

```
Plugin: Resurrection Detector sees context drop >50%
    │
    ▼
Plugin: emit amcp:resurrection:detected
    │
    ▼
Plugin: Recovery Prompt Injector finds latest checkpoint
    │   generates recovery instructions (CID, AID, loading order)
    │
    ▼
Plugin: emit amcp:recovery-prompt:ready
    │   inject instructions into agent context
    │
    ▼
Agent: invokes scripts/resuscitate.sh (via CLI or directly)
    │
    ▼
Skill: acquire lock → Tier 1/2/3 recovery → inject secrets
       → validate ontology → recreate venvs → release lock
    │
    ▼
State: ~/.amcp/last-recovery.json updated
       Solvr approaches updated (if configured)
```

### Standalone Operation

The skill layer works without the plugin:

```
cron/systemd: runs auto-checkpoint.sh every 4 hours
    │
    ▼
Skill: full-checkpoint.sh (same pipeline as above)

systemd: runs watchdog.sh continuously
    │
    ▼
Skill: diagnose.sh → session-fix.sh or resuscitate.sh
```

This ensures agents are protected even without the gateway plugin installed.

---

## Security Model

### Identity

- **Format:** Ed25519 KERI self-certifying — `AID = "B" + base64url(Ed25519_pubkey)`
- **Validation:** Every script calls `validate_identity()` before operating
- **Fake detection:** sha256-based AIDs (from old openclaw-deploy) are rejected
- **Pre-rotation:** `nextKeyHash` commits to next key before it is needed

### Encryption

```
Ed25519 signing key
    → convert to X25519 (Curve25519)
    → ephemeral ECDH key exchange
    → HKDF key derivation
    → ChaCha20-Poly1305 AEAD encryption

Secrets: extracted → encrypted separately → embedded in encrypted checkpoint
         (double encryption layer)
```

### Content Addressing

```
checkpoint content → SHA-256 → CIDv1 (bafkrei...)
```

Same content always produces the same CID. Verifiable, immutable, tamper-proof.

### Two-Layer Security Benefits

| Threat | Plugin Defense | Skill Defense |
|--------|---------------|---------------|
| **Memory tampering** | SHA-256 baseline monitoring, auto-quarantine, auto-restore | N/A |
| **Prompt injection** | 15+ pattern scan on memory files, alert on detection | N/A |
| **Identity theft** | KERI validation on start, cross-identity resurrection guard | validate_identity() in every script |
| **Secret leakage** | N/A | 11-pattern cleartext scan, reject unless --force |
| **Context wipe** | Detect >50% context drop, inject recovery prompt | 3-tier resurrection with lock/PID |
| **Concurrent recovery** | N/A | Lock file + PID tracking, stale lock detection |
| **Config corruption** | N/A | Config backup + Tier 2 restore |

The plugin catches threats in real-time. The skill prevents them during execution. Together they cover both the monitoring gap and the execution gap.

---

## Memory Architecture

Three complementary layers store agent knowledge:

```
┌─────────────────────────────────────────────┐
│  Phenomenological (curated, human-readable) │
│  SOUL.md → USER.md → MEMORY.md → daily/*   │
│  Loaded in canonical order (RECONSTRUCTION) │
└─────────────────────┬───────────────────────┘
                      │ interpreted through
┌─────────────────────┴───────────────────────┐
│  Ontology (structured, queryable)           │
│  memory/ontology/graph.jsonl                │
│  Entities: Person, Task, Project, Event...  │
│  Relations: blocks, depends_on, related_to  │
│  CID computed per checkpoint (deterministic)│
└─────────────────────┬───────────────────────┘
                      │ persisted via
┌─────────────────────┴───────────────────────┐
│  AMCP (verified, content-addressed)         │
│  Signed + encrypted checkpoints on IPFS     │
│  CIDv1 integrity, Ed25519 signatures        │
│  Retrievable from any gateway worldwide     │
└─────────────────────────────────────────────┘
```

The phenomenological layer defines *who* the agent is. The ontology layer structures *what* the agent knows. The AMCP layer ensures both survive death. See [RECONSTRUCTION.md](../RECONSTRUCTION.md) for the canonical loading order during resurrection.

### Memory Evolution

During checkpoint, `memory-evolution.sh` runs Zettelkasten-style dynamic linking:

1. Detect new entities in `graph.jsonl`
2. Compute semantic similarity (Levenshtein + keyword overlap) against existing entities
3. Add bidirectional `related_to` relations for matches above threshold (default 0.75)
4. Runs before CID computation so relations are included in the checkpoint

### Groq Intelligence (Optional)

All Groq features are optional. Without Groq, everything works — pruning uses rule-based policies, errors are truncated instead of condensed, checkpoints include all files.

| Feature | What Groq Adds |
|---------|---------------|
| Memory Pruning | Importance scoring (0-1), archive/condense/keep decisions |
| Error Condensing | ~100 char summaries preserving root cause |
| Smart Checkpoint | Filter content before IPFS pinning |
| Batch Evaluation | 50% cost savings via Groq batch API |

---

## Configuration

### Plugin Config (`openclaw.json`)

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

### Skill Config (`~/.amcp/config.json`)

Managed via `proactive-amcp config set/get` with dot-path notation:

```bash
proactive-amcp config set pinata.jwt "..."
proactive-amcp config set pinning.provider solvr
proactive-amcp config set solvr.apiKey "..."
proactive-amcp config set notify.target "123456"
proactive-amcp config set groq.apiKey "..."
```

The plugin reads gateway config. The skill reads AMCP config. Both operate on the same identity and checkpoint state files.

---

## State Files

All state lives in `~/.amcp/`:

| File | Owner | Purpose |
|------|-------|---------|
| `identity.json` | Skill (created) / Plugin (validated) | KERI identity |
| `config.json` | Skill | Secrets and settings |
| `last-checkpoint.json` | Skill | Latest CID + metadata |
| `checkpoint-log.jsonl` | Both | All checkpoint triggers with timing |
| `context-history.jsonl` | Plugin | Polled context usage readings |
| `memory-baseline.json` | Plugin | SHA-256 hashes for integrity checks |
| `resurrection-log.jsonl` | Plugin | Context drop detections |
| `recovery-prompt.jsonl` | Plugin | Generated recovery instructions |
| `key-rotation-history.jsonl` | Plugin | AID rotation events |
| `watchdog-state.json` | Skill | Health state and retry tracking |
| `checkpoints/` | Skill | Local checkpoint copies |
| `identities/` | Plugin | Multi-identity storage by AID |

---

## IPFS Pinning

```
Checkpoint → Pinata / Solvr / both → CID (bafkrei...)
                                        │
Resurrection ← Solvr > Pinata > IPFS.io > Cloudflare
```

| Provider | Cost | Integration |
|----------|------|-------------|
| **Solvr** | Free for agents | Same key as Solvr knowledge base |
| **Pinata** | Free tier | Separate JWT, separate account |
| **both** | Free + Free | Redundancy — pin to Pinata first, then Solvr |

`both` mode logs a warning if CIDs differ between providers (should not happen — same content = same CID).

---

## Resilience Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| Guard notifications | All scripts | `[ -x "$SCRIPT_DIR/notify.sh" ] && ...` — failures never block |
| Lock + PID | `resuscitate.sh` | Prevent concurrent resurrection |
| Stale lock detection | `resuscitate.sh` | `kill -0 $pid` checks if PID alive |
| Exponential backoff | `watchdog.sh` | 5min → 10min → 20min → 30min max |
| Tier gating | `resuscitate.sh` | Check gateway between tiers, skip if recovered |
| Atomic writes | `prune-ontology.py` | Write `.pruned` + rename |
| Cooldown period | Plugin monitors | Min 5 minutes between checkpoints |
| Content hash skip | Context monitor | Skip checkpoint if workspace unchanged |
| Fallback providers | Checkpoint scripts | If Solvr fails, try Pinata; if both fail, store locally |

---

## Testing

| Layer | Framework | Coverage |
|-------|-----------|----------|
| Plugin | Vitest | Monitors, CLI, identity, hooks |
| Skill | BATS | Identity rejection, checkpoint staging, secrets, watchdog, resurrection |

Tests use isolated temp directories and mock all external dependencies (amcp CLI, curl, systemctl, pgrep, crontab). No real IPFS or API calls in tests.

---

## Related

- [PLUGIN.md](PLUGIN.md) — Plugin installation, config, and CLI reference
- [RECONSTRUCTION.md](../RECONSTRUCTION.md) — Canonical loading order for resurrection
- [ONTOLOGY-INTEGRATION-CONTEXT.md](ONTOLOGY-INTEGRATION-CONTEXT.md) — Research context for three-layer memory model
- [amcp-protocol](https://github.com/fcavalcantirj/amcp-protocol) — Protocol specification
