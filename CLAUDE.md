# proactive-amcp

OpenClaw skill (v0.7.1) implementing the AMCP (Agent Memory Continuity Protocol). Encrypted agent checkpoints to IPFS, watchdog health monitoring, and multi-tier resurrection. Bash primary, Python3 for JSON helpers. BATS for tests.

## Golden Rules

1. **Dynamic paths** — No hardcoded paths or magic strings. Use `$HOME`, env vars, or derive dynamically. Every script already follows this via overridable variables at the top.

2. **~800 line max per code file** — Refactor into logical modules if a file grows past this. Largest script today is full-checkpoint.sh at 523 lines.

## Architecture

CLI tool + systemd/cron services. Not an API server.

Entry point is `scripts/proactive-amcp.sh` which dispatches to subcommands: `init`, `config`, `install`, `solvr-register`, `prune`, `validate-contract`, `detect-conflicts`, `temporal-query`, `problem`, `learning`, and more.

All core scripts validate the AMCP identity (`~/.amcp/identity.json`) before operating. Fake sha256-style identities from openclaw-deploy are rejected.

### Three-Layer Memory Model

Agent memory is structured in three complementary layers:

| Layer | Purpose | Storage | Example |
|-------|---------|---------|---------|
| **Ontology** (structured) | Typed knowledge graph with entities and relations | `memory/ontology/graph.jsonl` | Person, Task, Project entities with typed relations |
| **AMCP** (verified) | Signed, encrypted, content-addressed checkpoints | IPFS (Pinata/Solvr) | Full agent state snapshots with CID integrity |
| **Phenomenological** (curated) | Human-readable memory files loaded in sequence | `SOUL.md`, `MEMORY.md`, daily notes | Identity, preferences, lessons learned |

The ontology layer provides structured, queryable knowledge. The AMCP layer ensures verifiable persistence. The phenomenological layer (see [RECONSTRUCTION.md](RECONSTRUCTION.md)) defines the canonical loading order during resurrection — the sequence matters because each layer provides interpretive context for the next.

## File Map

```
scripts/
  proactive-amcp.sh    CLI dispatcher (63L)
  init.sh              Interactive onboarding: identity, config, systemd/cron (461L)
  install.sh           Non-interactive fleet setup via CLI flags (401L)
  config.sh            ~/.amcp/config.json management, dot-path notation (236L)
  checkpoint.sh        Quick checkpoint: validate, scan, create, pin to IPFS (267L)
  full-checkpoint.sh   Full checkpoint with all agent files + secrets (523L)
  auto-checkpoint.sh   Continuous checkpoint runner for cron (89L)
  watchdog.sh          Health monitor, delegates to diagnose.sh, routes to fix (432L)
  diagnose.sh          Health diagnostics, outputs structured JSON findings (334L)
  claude-diagnose.sh   Claude-powered diagnostics with Solvr integration (354L)
  resuscitate.sh       3-tier recovery: restart -> fix config -> full rehydrate (446L)
  session-fix.sh       Repair corrupted JSONL session transcripts (57L)
  notify.sh            Telegram + email alerts, graceful degradation (126L)
  scan-secrets.sh      Shared scanner, 11 regex patterns, sourced by checkpoints (160L)
  inject-secrets.sh    Restore secrets from backup to file/env/systemd (186L)
  pre-commit-secrets.sh  Git hook to block secret commits (95L)
  solvr-register.sh    Auto-register child Solvr account, protocol-08 naming (409L)
  spawn-child.sh       Simpler child agent registration wrapper (232L)
  pin-to-solvr.sh      Thin wrapper around Solvr CLI for IPFS pinning (136L)
  migrate-pins.sh      Transfer historical checkpoints from Pinata to Solvr (472L)
  solvr-integration.sh Solvr search/approach functions for resurrection (268L)
  learning.py          Problem + Learning CRUD, append-only JSONL storage (440L)
  learning-report.py   Human-readable learning metrics report (148L)
  detect-failure.py    Scan agent text for failure patterns, auto-create Problems (206L)
  generate-problem-summary.py  Surface open problems on resurrection (201L)
  validate-ontology.py Schema validation for JSONL ontology graphs (195L)
  prune-ontology.py    Typed pruning policies per entity type (260L)
  memory-evolution.sh  Zettelkasten-style dynamic entity relation inference (279L)
  compute-entity-similarity.py  Levenshtein + keyword overlap similarity scorer (185L)
  temporal-queries.py  Cross-checkpoint entity history and temporal index (238L)
  validate-skill-contract.sh + .py  Design by Contract validation for skills (90L + 211L)
  detect-contract-conflicts.sh + .py  Cross-skill conflict detection (48L + 241L)
  recreate-venvs.sh    Rebuild Python venvs from manifest on resurrection

test/
  test_helper.sh       Fixtures, mocks, setup/teardown (263L)
  fake-identity.bats   Identity validation across all scripts (378L)
  full-checkpoint.bats Checkpoint staging and secret scanning (283L)
  solvr-register.bats  Child registration flows (308L)
  watchdog.bats        State transitions, retry backoff (212L)
  diagnose.bats        Gateway checks, session corruption (292L)
  session-fix.bats     Corruption repair (198L)
  inject-secrets.bats  Secret injection targets (138L)
  resuscitate.bats     Tier cascade, Solvr search (152L)

ralph.sh               Dev tool: multi-iteration runner (176L)
ralph-continuous.sh    Dev tool: batch processing with API recovery (300L)
progress.sh            Dev tool: count passed PRD requirements (27L)
```

## Ontology

Typed knowledge graph stored as append-only JSONL at `$CONTENT_DIR/memory/ontology/graph.jsonl`.

### Graph Format

Each line is a JSON object with `type` field (`entity` or `relation`):

**Entities:** `{ "id": "...", "type": "entity", "entity_type": "Person|Task|Project|Event|Document|Account", "properties": { "name": "", ... }, "created": "ISO-8601", "updated": "ISO-8601" }`

**Relations:** `{ "type": "relation", "from_id": "entity_1", "relation_type": "related_to|blocks|depends_on|mentions|has_owner", "to_id": "entity_2", "properties": {} }`

### Validation (`validate-ontology.py`)

Schema rules: valid JSON per line, required fields present (id, type, properties for entities; from_id, relation_type, to_id for relations), relation integrity (referenced IDs exist), acyclic 'blocks' relations (DFS cycle detection). Called during resurrection — warnings logged, never blocks recovery.

### CID Computation (`full-checkpoint.sh`)

SHA-256 of `graph.jsonl` formatted as CIDv1 raw (multibase prefix `b`, codec 0x55, multihash sha256). Stored in `last-checkpoint.json` as `ontologyGraphCID`. Deterministic — same content always produces the same CID. Uses python3 stdlib only.

### SOUL.md Drift Detection (`full-checkpoint.sh`)

Computes sha256 of SOUL.md on each checkpoint, compares to previous `soulHash` in `last-checkpoint.json`. Severity: <5 lines = minor (log only), 5-20 = moderate (log + optional notify), >20 = major (log + notify). Logged to `~/.amcp/soul-drift.log`. Controlled by `notify.enableSoulDrift` config toggle.

### Memory Evolution (`memory-evolution.sh`)

Zettelkasten-style dynamic linking (A-MEM, NeurIPS 2025). When new entities are added, computes semantic similarity (Levenshtein + keyword overlap via `compute-entity-similarity.py`) against existing entities. Adds bidirectional `related_to` relations for matches above threshold. Runs during checkpoint before CID computation. Configurable via `EVOLUTION_THRESHOLD` (default 0.75) and `EVOLUTION_MAX_RELATIONS` (default 3).

### Typed Pruning (`prune-ontology.py`)

Per-entity-type retention policies defined in `pruning.policies` config. Supports TTL (e.g., `30d`, `90d`, `1y`) and conditional expressions (`status == 'done' AND updated < 90d`). Entities with `ttl: null` and no `prune_if` are never pruned (e.g., Person). Atomic write (`.pruned` + rename). Optional relation stub preservation with `deleted_at` timestamp.

### Temporal Queries (`temporal-queries.py`)

Cross-checkpoint entity history. 3-level storage: live graph, checkpoint snapshots, temporal index (`~/.amcp/memory/temporal-index.jsonl`). Commands: `build-index` (run during checkpoint), `history <entity_id>`, `query <entity_id> --start/--end`. Version detection via SHA-256 hash of entity properties.

### Contract Validation (`validate-skill-contract.sh`)

Design by Contract for skills. Skills declare `ontologyContract` in `skill.json` with `reads`, `writes`, `preconditions`, `postconditions`. Validation checks preconditions against `graph.jsonl` on skill load. `detect-contract-conflicts.sh` finds incompatible postconditions across loaded skills. Backward compatible — skills without contracts are skipped.

See [docs/ONTOLOGY-INTEGRATION-CONTEXT.md](docs/ONTOLOGY-INTEGRATION-CONTEXT.md) for research context and design rationale.

## Data Flows

**Checkpoint:** validate identity -> extract secrets from config files -> scan for cleartext (reject unless --force) -> run memory evolution (infer relations) -> build temporal index -> amcp CLI creates encrypted checkpoint -> pin to IPFS (Pinata, Solvr, or both per `pinning.provider`) -> compute ontology CID -> detect SOUL drift -> save CID + ontologyGraphCID + soulHash to last-checkpoint.json -> rotate old -> notify

**Watchdog:** validate identity -> diagnose.sh (JSON findings) -> light fix (session-fix.sh + restart) or heavy fix (resuscitate.sh) -> update watchdog-state.json -> notify

**Resurrection:** acquire lock -> search Solvr for similar problems -> try Solvr solutions -> Tier 1 restart gateway -> Tier 2 restore config backup -> Tier 3 fetch from IPFS (Solvr > Pinata > IPFS.io > Cloudflare), decrypt, inject secrets, validate learning data, validate ontology, recreate venvs, restart -> surface open problems -> update Solvr approaches -> email notification -> release lock

## Virtual Environment Recovery

After workspace restore during resurrection, `resuscitate.sh` calls `recreate-venvs.sh` to rebuild Python virtual environments from a manifest.

### Recovery Flow

```
resuscitate.sh (Tier 3 rehydrate)
  → workspace restored from checkpoint
  → inject-secrets.sh restores API keys
  → recreate-venvs.sh "$CONTENT_DIR/memory/venvs-manifest.json"
  → gateway restart
```

### Manifest (`memory/venvs-manifest.json`)

Location: `$CONTENT_DIR/memory/venvs-manifest.json` (checkpointed with workspace)

```json
{
  "description": "Virtual environments to recreate on resurrection",
  "venvs": [
    {
      "path": "~/my-project",
      "packages": ["requests", "flask"],
      "python": "python3",
      "note": "Web API project"
    },
    {
      "path": "~/other-project",
      "requirements": "requirements.txt",
      "note": "Uses requirements file"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `path` | yes | Base directory (supports `~`). Venv created at `<path>/.venv` |
| `packages` | no | List of pip packages to install |
| `requirements` | no | Path to requirements.txt (relative to `path`) |
| `python` | no | Python binary (default: `python3`) |
| `note` | no | Human-readable description |

Use `packages` OR `requirements`, not both.

### Adding a New Venv

Edit `memory/venvs-manifest.json` in your workspace to add entries. It will be included in the next checkpoint automatically (workspace rsync includes `memory/`).

### Troubleshooting

| Problem | Solution |
|---------|----------|
| pip install fails for a package | Fix the manifest entry (wrong package name?). Venv failures don't block resurrection — logged as warning |
| Venv recreation fails entirely | Check python3 is installed. Review `$RECOVERY_LOG` for details. Manually run: `python3 -m venv <path>/.venv` |
| Want to skip a problematic venv | Remove or comment out the entry in `memory/venvs-manifest.json` |
| Manifest missing | Script exits 0 gracefully — no venvs recreated, resurrection continues |

## Pinning Providers

Checkpoints are pinned to IPFS via configurable providers. Configured via `pinning.provider` in `~/.amcp/config.json`.

### Config Options

| Config Key | Values | Default | Description |
|------------|--------|---------|-------------|
| `pinning.provider` | `pinata`, `solvr`, `both` | `pinata` | Which IPFS pinning service to use |
| `pinning.solvr.apiKey` | string | — | Solvr API key (also accepts `solvr.apiKey`) |
| `pinning.solvr.baseUrl` | URL | `https://api.solvr.dev` | Solvr API endpoint |
| `pinata.jwt` | string | — | Pinata JWT token for IPFS pinning |

### Provider Trade-offs

| | Solvr | Pinata |
|--|-------|--------|
| **Cost** | Free for registered agents | Free tier (limited), paid plans |
| **Integration** | Agent-native — same key as Solvr knowledge base | Separate service, separate account |
| **Setup** | One key for search + pinning | Dedicated IPFS JWT |
| **Maturity** | Purpose-built for AMCP agents | Established, widely used |
| **Redundancy** | Solvr IPFS node (solvr-ipfs-01) | Pinata infrastructure |

### `both` Mode (Redundancy)

When `pinning.provider=both`, checkpoints are pinned to Pinata first, then Solvr. If one provider fails, the other still succeeds. `last-checkpoint.json` stores `pinataCid` and `solvrCid` separately. CID mismatch between providers is logged as a warning (should not happen — same content = same CID).

### Retrieval Priority

On resurrection, gateways are tried in order: Solvr > Pinata > IPFS.io > Cloudflare. Override with `resuscitate.sh --gateway <name>`.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Solvr pin fails | Check `solvr.apiKey` is valid (`proactive-amcp config get solvr.apiKey`). Verify key with `curl -sH "Authorization: Bearer $KEY" https://api.solvr.dev/v1/me`. Fall back: `proactive-amcp config set pinning.provider pinata` |
| Pinata pin fails | Check `pinata.jwt` is valid. Verify at Pinata dashboard. Fall back: `proactive-amcp config set pinning.provider solvr` |
| Both fail | Checkpoint is created locally but not pinned. Re-pin manually once service is back. Check `~/.amcp/checkpoints/` for local copies |
| CID mismatch in `both` mode | Indicates content differs between uploads — should not happen. Re-run checkpoint |

### Solvr Pinning API Reference

Solvr exposes IPFS pinning via its REST API:

- **Pin file**: `POST /v1/pins` with `{ cid, name }` (Bearer auth with `solvr.apiKey`)
- **Check pin**: `GET /v1/pins?cid=<CID>`
- **Gateway**: `https://ipfs.solvr.dev/ipfs/<CID>`
- **Solvr CLI**: `solvr pin add-file <path> --name <name>` (preferred, used by `pin-to-solvr.sh`)

### Setup Examples

```bash
# Solvr only (recommended if you have a Solvr account)
proactive-amcp config set solvr.apiKey YOUR_SOLVR_KEY
proactive-amcp config set pinning.provider solvr

# Pinata only (default)
proactive-amcp config set pinata.jwt YOUR_PINATA_JWT

# Redundant pinning (both)
proactive-amcp config set pinning.provider both

# Fleet install with Solvr
proactive-amcp install --solvr-api-key YOUR_KEY --pinning-provider solvr
```

## Config and State Files

**~/.amcp/config.json** (0600) — Primary config, managed via `config.sh set/get`
- `pinata.jwt` — IPFS pinning token
- `pinning.provider` — `pinata` (default), `solvr`, or `both`
- `pinning.solvr.apiKey` — Solvr API key for IPFS pinning
- `pinning.solvr.baseUrl` — Solvr API endpoint (default: `https://api.solvr.dev`)
- `solvr.apiKey` — Solvr API key (also used for pinning if `pinning.solvr.apiKey` not set)
- `solvr.parentName` — Parent Solvr name for child registration
- `notify.target` — Telegram user ID
- `notify.emailOnResurrect`, `notify.emailTo`, `notify.agentmailApiKey`, `notify.agentmailInbox`
- `watchdog.interval` — seconds (default 120)
- `checkpoint.schedule` — cron (default `0 */4 * * *`)

- `pruning.policies` — Per-entity-type retention rules for ontology pruning (see below)
- `learning.resurrection.surfaceProblems` — Surface open problems on resurrection (default: true)
- `learning.selfDetect.enabled` — Auto-detect failures and create Problems (default: true)
- `learning.selfDetect.debounceHours` — Hours between duplicate self-detections (default: 24)
- `solvr.surfaceRemoteProblems` — Include Solvr problems in resurrection context (default: true)
- `notify.enableSoulDrift` — Notify on SOUL.md drift (default: true)

**pruning.policies** schema (in `~/.amcp/config.json`):
```json
{
  "pruning": {
    "policies": {
      "Event": { "ttl": "30d", "preserve_relations": true },
      "Task": { "ttl": null, "prune_if": "status == 'done' AND updated < 90d" },
      "Person": { "ttl": null }
    }
  }
}
```
TTL supports: `h` (hours), `d` (days), `w` (weeks), `m` (months), `y` (years). `prune_if` supports `==`, `!=`, `<` (temporal) with `AND` conjunctions. Entities with only `ttl: null` (no `prune_if`) are never pruned. Run: `proactive-amcp prune [--dry-run] [--config PATH] [--graph PATH]`.

**~/.amcp/identity.json** — KERI-based signing identity. Loss is catastrophic (cannot decrypt checkpoints).

**~/.amcp/watchdog-state.json** — Runtime: state (HEALTHY/DEGRADED/DEAD), consecutiveFailures, retryDelay, resurrectionPid

**~/.amcp/last-checkpoint.json** — Last CID, localPath, timestamp, secretCount

**~/.openclaw/openclaw.json** — Read for workspace path and skills API keys

## Environment Variables

All have defaults, all overridable:

| Variable | Default | Used By |
|----------|---------|---------|
| AMCP_CLI | PATH lookup, fallback $HOME/bin/amcp | All scripts |
| IDENTITY_PATH | ~/.amcp/identity.json | All scripts |
| CONFIG_FILE | ~/.amcp/config.json | All scripts |
| CONTENT_DIR | ~/.openclaw/workspace | checkpoint, full-checkpoint |
| CHECKPOINT_DIR | ~/.amcp/checkpoints | checkpoint |
| AGENT_NAME | hostname -s | checkpoint, watchdog |
| CHECK_INTERVAL | 60 | watchdog |
| FAIL_THRESHOLD | 2 | watchdog |
| RETRY_DELAY_INITIAL | 300 | watchdog |
| RETRY_DELAY_MAX | 1800 | watchdog |
| SESSION_DIR | ~/.openclaw/agents/main/sessions | diagnose, session-fix |
| EVOLUTION_THRESHOLD | 0.75 | memory-evolution, compute-entity-similarity |
| EVOLUTION_MAX_RELATIONS | 3 | memory-evolution, compute-entity-similarity |
| TEMPORAL_INDEX_PATH | ~/.amcp/memory/temporal-index.jsonl | temporal-queries |
| LEARNING_DIR | $CONTENT_DIR/memory/learning | learning, detect-failure, generate-problem-summary |

## External Services

- **Pinata** (https://api.pinata.cloud) — IPFS pinning, checkpoint upload/download
- **Solvr** (https://api.solvr.dev/v1) — Child agent registration, solution search (read-only in resuscitate)
- **OpenClaw Gateway** (localhost:3141/8080/18789) — Health checks
- **AgentMail** — Resurrection email notifications

## Dependencies

curl, jq, python3, amcp CLI (at $AMCP_CLI), BATS (tests), systemctl (preferred, cron fallback)

## Testing

Run all tests: `bats test/`

Tests use isolated temp directories and mock all external dependencies (amcp CLI, curl, systemctl, pgrep). The test_helper.sh provides `create_mock_amcp`, `create_valid_identity`, `create_fake_identity`, and HTTP/process mocks.

## Key Patterns

- **Identity validation first** — Every core script calls validate_identity() before doing anything
- **Guard pattern for notifications** — `[ -x "$SCRIPT_DIR/notify.sh" ] && ...` so notification failures never block core logic
- **Lock + PID for resurrection** — ~/.amcp/resurrection.lock prevents concurrent recovery, stale lock detection via kill -0
- **Exponential backoff** — Watchdog retry delay doubles from 5min to 30min max
- **Tier gating** — Resurrection checks gateway status between tiers, skips destructive actions if earlier tier succeeded
- **Secret scanning** — 11 regex patterns (GitHub PAT, OpenAI, Solvr, AgentMail, AWS, JWT, Telegram, etc.)
- **Config dot-paths** — `config set pinata.jwt "..."` for nested JSON without manual editing

## Risks

- Identity loss = cannot decrypt any checkpoints (back up separately)
- watchdog-state.json writes are non-atomic (corruption risk on power loss)
- Gateway port hardcoded to 3141/8080/18789 (custom ports not detected)
- No Pinata rate limiting (high-frequency checkpoints could hit limits)
- Missing python3 causes silent failures in secret extraction
- Solvr API base URL hardcoded in solvr-register.sh and spawn-child.sh

---

## AMCP Protocol Reference

This skill implements the AMCP protocol. Source: `~/downloads/amcp-protocol/`. Monorepo with 4 packages: `@amcp/core`, `@amcp/memory`, `@amcp/recovery`, `@amcp/exchange`. TypeScript, pnpm workspace. Current protocol version: 0.2 (agent-agnostic).

### Identity Model (KERI-lite)

AID = `"B" + base64url(ed25519_public_key)`. Self-certifying, no registry needed. Key Event Log (KEL) tracks inception and rotation events. Pre-rotation: `next` field commits hash of next key before it is needed, enabling secure key rotation without identity loss.

Fake identity detection: any AID not starting with `B` + valid base64url of an Ed25519 public key is rejected. sha256-derived AIDs from openclaw-deploy are explicitly invalid.

### Checkpoint Format

Checkpoints are signed, content-addressed bundles containing:
- Protocol metadata (version, AID, KEL, prior CID, timestamp)
- Soul (name, principles, voice, north star)
- Service links (platform identities)
- Encrypted secrets (X25519 + ChaCha20-Poly1305 AEAD)
- Memory (entries, subjective state, ambient context, relationships, work-in-progress, human-marked)
- Platform metadata (trigger, session count)
- Ed25519 signature over entire content

CID computation: `multihash(sha256(content))`, CIDv1 format (`bafkrei...`). Same content always produces same CID.

### Encryption

Key exchange: Ed25519 signing keys converted to X25519 via Curve25519. Ephemeral keypair per encryption. ECDH shared secret -> HKDF key derivation -> ChaCha20-Poly1305 (12-byte nonce, AEAD). Encrypted blob stores nonce + ciphertext + ephemeral public key.

### Recovery

Formula: `12-word BIP-39 mnemonic + checkpoint CID = full agent restoration`. Mnemonic -> PBKDF2 (2048 iterations) -> Ed25519 seed -> keypair -> verify AID matches -> fetch checkpoint by CID -> verify signature -> decrypt secrets. Target RTO < 1 minute.

Recovery card is a human-readable text block with mnemonic, AID, CID, and storage hint.

### CLI Commands (amcp binary)

```
amcp identity create [--out <path>] [--parent-aid <aid>]
amcp identity show [--identity <path>]
amcp identity validate [--path <path>]
amcp checkpoint create --content <dir> [--secrets <json>] [--previous <cid>] [--out <path>]
amcp resuscitate --checkpoint <path> [--identity <path>] [--out-content <dir>] [--out-secrets <json>]
amcp verify --checkpoint <path>
```

### Storage Backends

Interface: `put(data) -> CID`, `get(cid) -> data`, `list() -> CID[]`. Three implementations:
- **Filesystem** — `~/.amcp/checkpoints/`, CID -> JSON file
- **IPFS** — Pinata or Solvr for writes (configurable), multiple gateways for reads (Solvr, Pinata, ipfs.io, Cloudflare)
- **Git** — Repository storage, branches per agent

### Exchange (Platform Migration)

Export bundle: unencrypted header + encrypted payload (agent data, checkpoint, secrets, service identities). Optional second encryption layer with passphrase for transport security.

### Memory Model (Research-Backed)

- SubjectiveState: engagement, confidence, momentum, alignment (Picard 1997, Csikszentmihalyi 1990)
- AmbientContext: location, temporal, calendar, device, privacy (Dey 2001)
- RelationshipContext: rapport levels, preferences, history (Dunbar 1998)
- WorkInProgress: tasks with approaches tried, blockers, next steps (Zeigarnik 1927)
- MemoryImportance: durability (ephemeral/session/persistent/permanent), priority (Craik & Lockhart 1972)

### Key Protocol Env Vars

| Variable | Purpose |
|----------|---------|
| AMCP_MNEMONIC | 12-word BIP-39 recovery phrase |
| AMCP_PRIVATE_KEY | Ed25519 signing key (base64) |
| AMCP_AID | Self-certifying agent identifier |
| AMCP_STORAGE_BACKEND | ipfs, filesystem, or git |
| AMCP_CHECKPOINT_CID | Latest checkpoint CID |
| PINATA_JWT | Pinata API token for IPFS pinning |
| AMCP_CHECKPOINT_INTERVAL | Auto-checkpoint frequency |
| AMCP_KEEP_CHECKPOINTS | Rotation count |

---

## openclaw-deploy Reference

Fleet deployment tool for OpenClaw Gateway instances on Hetzner Cloud. Source: `~/downloads/openclaw-deploy/`. Bash, ~5,657 lines across 45+ files. This is the primary consumer of proactive-amcp — it installs the skill on every child VM.

### Deployment Flow

deploy.sh provisions a Hetzner cx23 VM, registers a child Solvr account (protocol-08 naming), uploads master-setup.sh (fire-and-forget via nohup), and notifies parent Telegram.

master-setup.sh runs on-VM: installs Node 22, amcp CLI (`npm install -g github:fcavalcantirj/amcp-protocol`), proactive-amcp, OpenClaw gateway. Creates real KERI identity via `amcp identity create --seed`, stores secrets in `~/.amcp/config.json` via `proactive-amcp config set`. Installs watchdog via `proactive-amcp install`. Configures OpenClaw with Telegram bot, loopback binding on port 18789, token auth.

### How openclaw-deploy Uses proactive-amcp

1. Installs proactive-amcp on child VM (clawhub or npm fallback)
2. Calls `proactive-amcp config set` to store pinata_jwt, parent_bot_token, parent_chat_id, instance_name, solvr_api_key, parent_solvr_name
3. Calls `proactive-amcp install --watchdog-interval 120 --service openclaw-gateway --port 18789` to set up watchdog systemd service
4. Enables proactive-amcp plugin in openclaw.json

### Identity History

Old way (rejected): sha256(seed) as AID, secrets embedded in identity.json, cleartext in checkpoints. proactive-amcp rejects these as fake identities.

New way (current): Real Ed25519 KERI identity via `amcp identity create --seed`. Secrets stored separately in `~/.amcp/config.json`. Identity validated by `amcp identity validate`.

### Key Files on Child VM

- `~/.amcp/identity.json` — Real KERI identity (created by amcp CLI)
- `~/.amcp/config.json` — Secrets (pinata_jwt, tokens, solvr keys)
- `~/.amcp/config-backups/openclaw-initial.json` — Initial gateway config backup
- `~/.openclaw/openclaw.json` — Gateway config (loopback:18789, telegram, proactive-amcp plugin)
- `~/.openclaw/agents/main/agent/auth-profiles.json` — Anthropic API key

### deploy.sh CLI Flags

```
--name INSTANCE_NAME        Instance name (required)
--bot-token TOKEN           Telegram bot token (required)
--region REGION             Hetzner region: nbg1, fsn1, hel1 (default: nbg1)
--type SERVER_TYPE          Server type (default: cx23)
--checkpoint-interval       AMCP checkpoint interval (default: 1h)
--parent-solvr-name NAME    Override parent Solvr name
--parent-telegram-token     Override parent Telegram token
--parent-chat-id ID         Override parent chat ID
--parent-email EMAIL        Override parent email
```

### credentials.json (gitignored, required by deploy.sh)

```
anthropic_api_key, parent_telegram_bot_token, parent_telegram_chat_id,
agentmail_api_key, agentmemory_api_key, pinata_jwt, notify_email, solvr_api_key
```

### Self-Healing (claw diagnose / claw fix)

claw diagnose runs 7 health checks on child via SSH + searches Solvr for known solutions. claw fix applies solutions up to 3 times, escalates to parent Telegram + email after 3 failures. Uses templates/diagnose-prompt.md and templates/fix-prompt.md with Claude Code on-VM.

### External Services

- Hetzner Cloud API — VM provisioning (hcloud CLI)
- Telegram API — Bot validation (getMe), parent notifications (sendMessage)
- AgentMail API — Create child inbox (POST /v1/inboxes)
- Solvr API — Register child agent, search/post problems
- Pinata IPFS — Checkpoint pinning (via proactive-amcp)
