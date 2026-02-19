# proactive-amcp

OpenClaw skill (v0.7.1) implementing the AMCP (Agent Memory Continuity Protocol). Encrypted agent checkpoints to IPFS, watchdog health monitoring, and multi-tier resurrection. Bash primary, Python3 for JSON helpers. BATS for tests.

## Golden Rules

1. **Dynamic paths** — No hardcoded paths or magic strings. Use `$HOME`, env vars, or derive dynamically. Every script already follows this via overridable variables at the top.

2. **~800 line max per code file** — Refactor into logical modules if a file grows past this. Largest script today is full-checkpoint.sh at 523 lines.

## Architecture

CLI tool + systemd/cron services. Not an API server.

Entry point is `scripts/proactive-amcp.sh` which dispatches to subcommands: `init`, `config`, `install`, `solvr-register`.

All core scripts validate the AMCP identity (`~/.amcp/identity.json`) before operating. Fake sha256-style identities from openclaw-deploy are rejected.

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

## Data Flows

**Checkpoint:** validate identity -> extract secrets from config files -> scan for cleartext (reject unless --force) -> amcp CLI creates encrypted checkpoint -> pin to IPFS (Pinata, Solvr, or both per `pinning.provider`) -> save CID to last-checkpoint.json -> rotate old -> notify

**Watchdog:** validate identity -> diagnose.sh (JSON findings) -> light fix (session-fix.sh + restart) or heavy fix (resuscitate.sh) -> update watchdog-state.json -> notify

**Resurrection:** acquire lock -> Tier 1 restart gateway -> Tier 2 restore config backup -> Tier 3 fetch from IPFS, decrypt, inject secrets, restart -> Solvr search (read-only) -> email notification -> release lock

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
