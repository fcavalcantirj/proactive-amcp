# proactive-amcp Edge Cases & Failure Modes

> Comprehensive analysis to avoid rework. Plan once, build once.

---

## 1. IDENTITY LAYER

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Identity file missing | File not found | Create new OR recover from mnemonic+CID | 🔴 |
| Identity file empty | Size = 0 | Treat as missing | 🔴 |
| Identity file corrupt JSON | Parse error | Delete, recover | 🔴 |
| Identity file wrong schema | Schema validation | Migrate or recover | 🔴 |
| Private key doesn't match public | Signature test fails | Recover from mnemonic | 🔴 |
| AID mismatch (computed vs stored) | Compare on load | Alert, investigate | 🔴 |
| Pre-rotation key missing | Field missing | Generate new | 🔴 |
| KEL tampered | Signature verification | Reject, recover | 🔴 |
| Multiple identity files | Multiple in dir | Use canonical path only | 🔴 |

### Decision: Identity Source of Truth

```
Priority order:
1. ~/.amcp/identity.json (canonical)
2. Recovery from mnemonic + latest checkpoint CID
3. Recovery from mnemonic + any known CID
4. Create new identity (LAST RESORT - loses history)
```

---

## 2. CHECKPOINT LAYER

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Checkpoint too large (>10MB) | Size check | Compress or split | 🔴 |
| Upload fails mid-way | HTTP error | Retry 3x with backoff | 🔴 |
| CID doesn't match content | Hash verification | Re-upload | 🔴 |
| Old checkpoints pile up | Count > threshold | Retention policy cleanup | 🔴 |
| Old schema version | Version field | Migration function | 🔴 |
| Secrets encryption fails | Crypto error | Skip secrets, log error, alert | 🔴 |
| Secrets decryption fails | Crypto error | Agent works without secrets, alert | 🔴 |
| Checkpoint from wrong agent | AID mismatch | Reject | 🔴 |
| Checkpoint from future | Timestamp > now | Accept but warn (clock skew) | 🔴 |
| Duplicate timestamps | Same ts | Use CID as tiebreaker | 🔴 |

### Decision: Checkpoint Atomicity

```
Checkpoint creation:
1. Build content in memory
2. Validate schema
3. Sign
4. Write to temp file
5. Upload to IPFS (get CID)
6. Verify CID matches
7. Update stats atomically
8. Move temp to final location
9. Delete temp on failure

If ANY step fails → full rollback, alert, keep last good checkpoint
```

### Decision: Retention Policy

```yaml
retention:
  local_filesystem:
    max_count: 10
    max_age_days: 30
  ipfs:
    keep_pinned: 5  # Last 5 CIDs stay pinned
    unpin_older: true
```

---

## 3. RECOVERY LAYER

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Wrong mnemonic | AID mismatch after derive | Error: "Mnemonic doesn't match AID" | 🔴 |
| Mnemonic typo | BIP-39 checksum fail | Error: "Invalid mnemonic checksum" | 🔴 |
| Wrong CID | Fetch returns different content | Error: "CID doesn't match expected AID" | 🔴 |
| CID points to old checkpoint | Valid but outdated | Warn, proceed (loses recent data) | 🔴 |
| Recovery during active session | Lock file exists | Error: "Session active, stop first" | 🔴 |
| Partial recovery | Incomplete state | Transaction: all-or-nothing | 🔴 |
| Secrets won't decrypt | Key mismatch | Continue without secrets, alert | 🔴 |
| Memory files missing after recovery | Files not created | Restore from checkpoint content | 🔴 |
| Platform accounts need re-auth | OAuth expired | List what needs human action | 🔴 |

### Decision: Recovery Transaction

```
Recovery is ATOMIC:
1. Acquire lock
2. Backup current state to /tmp
3. Derive keys from mnemonic
4. Fetch checkpoint
5. Verify AID matches
6. Verify signature
7. Decrypt secrets
8. Write identity file
9. Write memory files
10. Verify everything readable
11. Release lock
12. Delete backup

On ANY failure:
- Restore from backup
- Release lock
- Alert with specific error
```

---

## 4. GATEWAY/SESSION LAYER

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Gateway unresponsive | Health check timeout | External watchdog kills + restarts | 🔴 |
| Gateway crash | Process not found | Systemd restart | 🔴 |
| Session JSON corrupt | Parse error | Delete session, restart | 🔴 |
| Session stale | Age > threshold | Checkpoint + new session | 🔴 |
| Multiple sessions conflict | Multiple lock files | Kill all, start fresh | 🔴 |
| Config corrupt | Parse error | Restore from backup | 🔴 |
| Disk full | Write error | Cleanup + alert | 🔴 |
| Port conflict | Bind error | Different port or kill conflicting process | 🔴 |
| Startup fails | Exit code != 0 | Alert, don't retry infinitely | 🔴 |

### Decision: Watchdog Design

```bash
# External watchdog (runs via cron, OUTSIDE gateway)
# Checks:
1. Is gateway process running?
2. Does health endpoint respond within 10s?
3. Was last heartbeat within 2x interval?

# Actions:
- If process dead → restart, log death
- If unresponsive → kill, restart, log death
- If heartbeat stale → alert (may be session issue, not gateway)

# Limits:
- Max 3 restarts per hour (prevent restart loop)
- After 3 failures → alert human, stop retrying
```

---

## 5. NETWORK LAYER

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| All IPFS gateways down | All timeouts | Use local filesystem | 🔴 |
| Local also unavailable | Write fails | Alert, operate read-only | 🔴 |
| Network slow | Timeout | Increase timeout, retry | 🔴 |
| Behind proxy | Connection refused | Support HTTPS_PROXY env | 🔴 |
| DNS fails | Resolution error | Use IP fallbacks for critical services | 🔴 |
| TLS cert invalid | SSL error | Fail secure (don't skip verify) | 🔴 |

### Decision: Gateway Fallback Order

```yaml
ipfs_gateways:
  - url: "https://gateway.pinata.cloud/ipfs"
    timeout: 10s
    priority: 1  # Our pinning service
  - url: "https://dweb.link/ipfs"
    timeout: 10s
    priority: 2
  - url: "https://ipfs.io/ipfs"
    timeout: 15s  # Often slow
    priority: 3
  - url: "https://cloudflare-ipfs.com/ipfs"
    timeout: 10s
    priority: 4

fallback:
  - type: filesystem
    path: "~/.amcp/checkpoints"
  - type: git
    repo: "git@github.com:user/amcp-backup.git"
```

---

## 6. TIMING/SCHEDULING

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Checkpoint cron + manual overlap | Lock file | Skip if locked, log | 🔴 |
| Heartbeat during checkpoint | Both running | Non-blocking checkpoint (async) | 🔴 |
| Clock wrong | Drift detection | Log warning, use monotonic for intervals | 🔴 |
| Timezone change | Unexpected trigger time | Always use UTC internally | 🔴 |
| Checkpoint slower than interval | Still running when next due | Skip, alert if chronic | 🔴 |

### Decision: Locking

```bash
LOCK_FILE="/tmp/amcp-checkpoint.lock"

acquire_lock() {
    if ! mkdir "$LOCK_FILE" 2>/dev/null; then
        # Check if stale (older than 30 min)
        if [ "$(find "$LOCK_FILE" -mmin +30)" ]; then
            rm -rf "$LOCK_FILE"
            mkdir "$LOCK_FILE"
        else
            return 1  # Lock held, skip
        fi
    fi
    trap 'rm -rf "$LOCK_FILE"' EXIT
}
```

---

## 7. DATA INTEGRITY

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Valid JSON, wrong schema | Schema validation | Reject with specific error | 🔴 |
| Required fields missing | Schema validation | Use defaults OR error | 🔴 |
| Wrong data types | Type check | Coerce if safe, else error | 🔴 |
| Encoding issues | UTF-8 validation | Normalize or reject | 🔴 |
| Signature invalid | Verify fails | Reject checkpoint | 🔴 |

### Decision: Schema Versioning

```json
{
  "version": "1.0.0",
  "schema": "amcp-checkpoint-v1",
  ...
}
```

Migration path:
- v1 → v2: Add new fields with defaults
- Breaking changes: New schema name, both supported during transition

---

## 8. SECRETS LAYER

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Encryption key lost | Can't derive | FATAL: Need mnemonic | 🔴 |
| Wrong format | Schema error | Skip malformed, log | 🔴 |
| Secrets too large | Size > 1MB | Split or reject | 🔴 |
| Secret update conflict | Different values | Latest timestamp wins | 🔴 |
| Secret deletion not synced | Exists in old checkpoint | Checkpoint wins (may resurrect) | 🔴 |

### Decision: Secret Handling

```
Secrets are SEPARATE from identity:
- Encrypted with X25519 derived from Ed25519 signing key
- Never stored in plaintext anywhere
- If can't decrypt → agent runs but alerts for each missing secret
- Human must re-add secrets manually if lost
```

---

## 9. HUMAN INTERACTION

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Mnemonic lost | Human reports | FATAL: Agent dead forever | N/A (human error) |
| CID lost | Human reports | Search Pinata dashboard, logs, stats file | 🔴 |
| Mnemonic entered wrong | Checksum fail or AID mismatch | Retry prompt | 🔴 |
| Human wants key rotation | Manual trigger | Rotation flow using pre-rotation key | 🔴 |
| Human wants to fork | Manual trigger | New identity with `forked_from` field | 🔴 |

### Decision: Recovery UX

```
Recovery prompts:
1. "Enter your 12-word recovery phrase:"
2. Validate checksum
3. "Enter checkpoint CID (or 'latest' to scan):"
4. If 'latest' → check Pinata, local, git for known CIDs
5. Show preview: "This will restore agent [AID] from [date]. Continue? [y/N]"
6. Proceed or abort
```

---

## 10. ALERTING

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Telegram down | Send fails | Fallback to email | 🔴 |
| Email down | Send fails | Fallback to local log | 🔴 |
| Alerts too noisy | Rate check | Throttle: max 1/min per type | 🔴 |
| Alerts missing | No alerts in 24h | Meta-alert: "I'm alive" | 🔴 |
| Sensitive data in alert | Content check | Sanitize: no keys, tokens, passwords | 🔴 |

### Decision: Alert Channels

```yaml
alerts:
  channels:
    - type: telegram
      priority: 1
    - type: email
      priority: 2
    - type: file
      path: "~/.amcp/alerts.log"
      priority: 3  # Always works
  
  throttle:
    same_message: 60s
    same_type: 300s
    
  levels:
    critical: [telegram, email, file]  # Death, corruption
    warning: [telegram, file]           # Degraded, slow
    info: [file]                         # Stats, checkpoints
```

---

## 11. MULTI-AGENT / FORK

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Two agents same AID | Same AID different machines | Conflict alert, refuse to run | 🔴 |
| Agent forked while running | New identity appears | Original continues, fork is separate | 🔴 |
| Wrong checkpoint for agent | AID mismatch | Reject with error | ✅ (planned) |

---

## 12. VERSION / UPGRADE

### Scenarios

| Scenario | Detection | Recovery | Implemented? |
|----------|-----------|----------|--------------|
| Skill code updated | Version check | Run migration if needed | 🔴 |
| Checkpoint schema changed | Version field | Migration function | 🔴 |
| Protocol breaking change | Major version bump | Support both during transition | 🔴 |
| Dependency breaks | Import/require fails | Version pinning, alert | 🔴 |

---

## SUMMARY: What to Build

### Must Have (P0)

1. **Identity validation on load** — Schema, signature, AID match
2. **Checkpoint atomicity** — All-or-nothing with rollback
3. **Recovery transaction** — Atomic with backup
4. **External watchdog** — Cron-based, kills unresponsive gateway
5. **Session corruption handling** — Detect, delete, recover
6. **Multi-gateway fallback** — 4 IPFS + local + git
7. **Lock file for operations** — Prevent overlap
8. **Schema versioning** — Migration path
9. **Alert fallback chain** — Telegram → Email → File

### Should Have (P1)

10. **Retention policy** — Cleanup old checkpoints
11. **Secrets encryption** — In checkpoint
12. **Alert throttling** — Prevent noise
13. **Clock skew handling** — UTC + monotonic
14. **Disk space check** — Before checkpoint

### Nice to Have (P2)

15. **Compression for large checkpoints**
16. **Git backend**
17. **Meta-monitoring** — "I'm alive" alerts
18. **Key rotation flow**
19. **Fork flow**

---

## File Structure (Final)

```
proactive-amcp/
├── SKILL.md                    # Agent instructions
├── EDGE-CASES.md               # This document
├── config.yaml                 # Defaults, thresholds
├── scripts/
│   ├── checkpoint.sh           # Atomic checkpoint creation
│   ├── recover.sh              # Atomic recovery
│   ├── verify-identity.sh      # Validation checks
│   ├── gateway-watchdog.sh     # External health monitor
│   ├── session-validate.sh     # Session integrity
│   ├── cleanup.sh              # Retention policy
│   └── alert.sh                # Multi-channel alerting
├── lib/
│   ├── lock.sh                 # Locking primitives
│   ├── ipfs.sh                 # Multi-gateway fetch
│   ├── schema.sh               # Validation
│   └── migrate.sh              # Schema migrations
└── systemd/
    ├── amcp-watchdog.service
    └── amcp-watchdog.timer
```

---

---

## 13. CROSS-PLATFORM (Linux / macOS / Windows)

### File System

| Issue | Linux | macOS | Windows | Solution |
|-------|-------|-------|---------|----------|
| Path separator | `/` | `/` | `\` | Use `path.join()` in Node, never hardcode |
| Home directory | `$HOME` | `$HOME` | `%USERPROFILE%` | Use `os.homedir()` in Node |
| Config location | `~/.amcp` | `~/.amcp` | `%APPDATA%\amcp` | Platform-specific default |
| Hidden files | `.file` works | `.file` works | No native hidden | Use config dir, not hidden |
| Case sensitivity | Yes | No (default) | No | Always use lowercase |
| Path length | 4096 | 1024 | 260 (default) | Keep paths short, enable long paths on Windows |
| Line endings | LF | LF | CRLF | Normalize to LF, use `.gitattributes` |
| File permissions | `chmod 600` | `chmod 600` | ACLs | Abstract via Node fs, document manual steps |
| Symlinks | Full support | Full support | Needs admin | Avoid symlinks, use direct paths |
| Temp directory | `/tmp` | `/tmp` | `%TEMP%` | Use `os.tmpdir()` |
| File locking | `flock` | `flock` | Different | Use `proper-lockfile` npm package |

### Shell / Scripts

| Issue | Linux | macOS | Windows | Solution |
|-------|-------|-------|---------|----------|
| Shell | bash | zsh (default) | PowerShell/CMD | Write TypeScript CLI, not bash |
| Shebang | Works | Works | Ignored | Use `npx tsx script.ts` |
| Env vars | `$VAR` | `$VAR` | `%VAR%` or `$env:VAR` | Use `process.env.VAR` in Node |
| `jq` command | Install | Install | Install | Use Node JSON parsing |
| `curl` command | Present | Present | May need install | Use `fetch()` or `node-fetch` |
| `openssl` CLI | Present | Present | May need install | Use Node `crypto` module |
| Process check | `ps aux` | `ps aux` | `tasklist` | Use Node `ps-list` package |
| Kill process | `kill PID` | `kill PID` | `taskkill /PID` | Use Node `tree-kill` package |

### Background Services

| Issue | Linux | macOS | Windows | Solution |
|-------|-------|-------|---------|----------|
| Service manager | systemd | launchd | Services | Abstract layer with platform detection |
| Cron equivalent | cron/systemd timer | launchd | Task Scheduler | Document all three OR use Node scheduler |
| Auto-start | systemd enable | launchd plist | Services | Provide templates for each |
| Watchdog | systemd WatchdogSec | launchd KeepAlive | Service recovery | Platform-specific configs |
| Logs | journalctl | Console.app | Event Viewer | Write to file, platform-agnostic |

### Crypto / Security

| Issue | Linux | macOS | Windows | Solution |
|-------|-------|-------|---------|----------|
| Secure storage | Secret Service | Keychain | Credential Manager | Use `keytar` npm package |
| Random numbers | `/dev/urandom` | `/dev/urandom` | `BCryptGenRandom` | Use Node `crypto.randomBytes()` |
| TLS certs | System store | System store | System store | Node handles this |

### Node.js Specifics

| Issue | Solution |
|-------|----------|
| Path construction | `path.join()` and `path.resolve()` ALWAYS |
| Home directory | `os.homedir()` |
| Temp directory | `os.tmpdir()` |
| Platform detection | `process.platform` → 'linux', 'darwin', 'win32' |
| Spawning processes | Use `execa` package for cross-platform |
| Native modules | Avoid, or use `prebuild` |
| Line endings | Use `os.EOL` or normalize |

### Platform-Specific Paths

```typescript
import os from 'os';
import path from 'path';

function getConfigDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || os.homedir(), 'amcp');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'amcp');
    default: // linux, freebsd, etc.
      return path.join(os.homedir(), '.amcp');
  }
}

function getTempDir(): string {
  return path.join(os.tmpdir(), 'amcp');
}

function getDataDir(): string {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || os.homedir(), 'amcp');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'amcp');
    default:
      return path.join(os.homedir(), '.local', 'share', 'amcp');
  }
}
```

### Service Templates

**Linux (systemd):**
```ini
# ~/.config/systemd/user/amcp-watchdog.service
[Unit]
Description=AMCP Watchdog
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/amcp/watchdog.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

**macOS (launchd):**
```xml
<!-- ~/Library/LaunchAgents/com.amcp.watchdog.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.amcp.watchdog</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/amcp/watchdog.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

**Windows (Task Scheduler XML):**
```xml
<!-- Import via: schtasks /create /tn "AMCP Watchdog" /xml amcp-watchdog.xml -->
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>node</Command>
      <Arguments>C:\path\to\amcp\watchdog.js</Arguments>
    </Exec>
  </Actions>
  <Settings>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
</Task>
```

### Dependencies by Platform

| Dependency | Linux | macOS | Windows |
|------------|-------|-------|---------|
| Node.js 18+ | `apt install nodejs` | `brew install node` | Download installer |
| pnpm | `npm i -g pnpm` | `npm i -g pnpm` | `npm i -g pnpm` |
| Git | `apt install git` | `xcode-select --install` | Download installer |
| (optional) jq | `apt install jq` | `brew install jq` | `choco install jq` |

### Testing Matrix

```yaml
# CI should test on all platforms
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node: [18, 20, 22]
```

---

## 14. FINAL ARCHITECTURE DECISION

### Core Logic: TypeScript (Cross-Platform)

```
proactive-amcp/
├── src/
│   ├── index.ts              # Main entry
│   ├── identity.ts           # Load, validate, recover
│   ├── checkpoint.ts         # Create, verify, store
│   ├── recovery.ts           # Full recovery flow
│   ├── watchdog.ts           # Health monitoring
│   ├── alerts.ts             # Multi-channel notifications
│   ├── storage/
│   │   ├── interface.ts      # StorageBackend interface
│   │   ├── filesystem.ts     # Local storage
│   │   ├── ipfs.ts           # IPFS with multi-gateway
│   │   └── git.ts            # Git backend
│   └── platform/
│       ├── paths.ts          # Cross-platform paths
│       ├── service.ts        # Service management abstraction
│       └── lock.ts           # Cross-platform locking
├── cli/
│   ├── checkpoint.ts         # CLI: amcp checkpoint
│   ├── recover.ts            # CLI: amcp recover
│   ├── status.ts             # CLI: amcp status
│   └── watchdog.ts           # CLI: amcp watchdog
├── templates/
│   ├── systemd/              # Linux service files
│   ├── launchd/              # macOS plist files
│   └── windows/              # Windows task XML
└── SKILL.md                  # Agent instructions
```

### Why TypeScript over Bash?

| Aspect | Bash | TypeScript |
|--------|------|------------|
| Cross-platform | ❌ Linux/macOS only | ✅ All platforms |
| Error handling | Fragile | Robust with try/catch |
| JSON handling | Needs `jq` | Native |
| Crypto | Needs `openssl` | Native `crypto` module |
| Path handling | Manual | `path.join()` |
| Testing | Difficult | Easy with vitest |
| Type safety | None | Full |
| Dependencies | System tools | npm packages |

### CLI Interface

```bash
# Works on ALL platforms
npx amcp checkpoint create     # Create checkpoint
npx amcp checkpoint list       # List checkpoints
npx amcp recover               # Interactive recovery
npx amcp recover --mnemonic "..." --cid "..."
npx amcp status                # Show identity + stats
npx amcp watchdog start        # Start watchdog
npx amcp watchdog install      # Install as system service
```

---

*Planning complete. Cross-platform covered. Ready to build without rework.*
