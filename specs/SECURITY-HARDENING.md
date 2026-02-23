# SECURITY-HARDENING.md — proactive-amcp

> Address security concerns raised by automated skill analysis.

---

## Problem Statement

The proactive-amcp skill has metadata/implementation mismatches that create security concerns for external users:

1. **External code fetch** — Scripts cloned from GitHub at runtime, not bundled
2. **Undeclared credentials** — Solvr API key, Pinata JWT, notify targets not in metadata
3. **Plaintext checkpoints** — Data pinned to IPFS without client-side encryption
4. **No signed releases** — No integrity verification mechanism
5. **Undeclared persistence** — Creates systemd/cron jobs without metadata warning
6. **Undeclared binaries** — Requires git, bash, curl, jq but doesn't declare them

---

## Goals

1. **Bundle all scripts** — No external fetch at install time
2. **Complete metadata** — Declare all env vars, binaries, persistence
3. **Optional encryption** — Client-side encrypt checkpoints before IPFS pin
4. **Signed releases** — Tarball + SHA256 hash for each version
5. **Audit-friendly docs** — Document exactly what data goes where

---

## Non-Goals

- Full E2E encryption (would break Solvr search/indexing)
- Removing IPFS pinning (core feature)
- Removing systemd/cron (opt-in, documented)

---

## Architecture

### Current Flow (Problematic)
```
User installs skill
  → SKILL.md says "git clone repo"
  → User runs external scripts
  → Scripts create identity, contact Solvr, pin to IPFS
  → Scripts optionally create systemd/cron
```

### Target Flow (Secure)
```
User installs skill from ClawdHub
  → All scripts bundled in package (auditable at publish)
  → Metadata declares: env vars, binaries, persistence
  → User reviews requirements before install
  → Optional: encrypt checkpoint before pin
  → Optional: verify release hash
```

---

## Implementation

### Phase 1: Metadata Completeness

**skill.json updates:**
```json
{
  "name": "proactive-amcp",
  "version": "0.8.0",
  "requiredEnvVars": [
    {
      "name": "SOLVR_API_KEY",
      "description": "Solvr API key for agent registration and pinning",
      "required": false
    },
    {
      "name": "PINATA_JWT",
      "description": "Pinata JWT for direct IPFS pinning (alternative to Solvr)",
      "required": false
    },
    {
      "name": "NOTIFY_TARGET",
      "description": "Telegram chat ID for resurrection notifications",
      "required": false
    }
  ],
  "requiredBinaries": ["bash", "curl", "jq"],
  "optionalBinaries": ["git", "systemctl", "crontab"],
  "persistence": {
    "createsSystemdUnits": true,
    "createsCronJobs": true,
    "createsIdentityFiles": true,
    "description": "Optionally creates watchdog services and scheduled checkpoints"
  },
  "networkAccess": {
    "endpoints": [
      "https://api.solvr.dev (agent registration, checkpoint pinning)",
      "https://api.pinata.cloud (direct IPFS pinning)",
      "IPFS gateways (checkpoint retrieval)"
    ],
    "dataExposed": "Checkpoints contain workspace files, memory, config. Plaintext by default."
  }
}
```

### Phase 2: Bundle Scripts

**Current structure:**
```
skill/
  SKILL.md  # References external GitHub repo
```

**Target structure:**
```
skill/
  SKILL.md
  scripts/
    proactive-amcp.sh
    checkpoint.sh
    resuscitate.sh
    init.sh
    learning.sh
    solvr-integration.sh
    status.sh
    pin-to-solvr.sh
```

All scripts bundled, no external fetch required.

### Phase 3: Optional Encryption

**New flag:** `--encrypt`

```bash
# Encrypted checkpoint
./scripts/checkpoint.sh --encrypt

# Flow:
# 1. Create checkpoint tarball
# 2. Generate random AES-256 key
# 3. Encrypt tarball with key
# 4. Pin encrypted blob to IPFS
# 5. Store key locally (or in AgentMemory vault)
# 6. CID points to encrypted data
```

**Key storage options:**
- Local file: `~/.amcp/checkpoint-keys.json`
- AgentMemory vault: `AMCP_CHECKPOINT_KEY_{CID}`
- User-provided: `--key-file /path/to/key`

**Resurrection with encryption:**
```bash
./scripts/resuscitate.sh --cid <CID> --key-file /path/to/key
# or
./scripts/resuscitate.sh --cid <CID>  # Looks up key in local store
```

### Phase 4: Signed Releases

**Release process:**
```bash
# 1. Create release tarball
tar -czvf proactive-amcp-0.8.0.tar.gz skill/

# 2. Generate SHA256
sha256sum proactive-amcp-0.8.0.tar.gz > proactive-amcp-0.8.0.tar.gz.sha256

# 3. Sign with GPG (optional)
gpg --armor --detach-sign proactive-amcp-0.8.0.tar.gz

# 4. Publish to GitHub releases with artifacts:
#    - proactive-amcp-0.8.0.tar.gz
#    - proactive-amcp-0.8.0.tar.gz.sha256
#    - proactive-amcp-0.8.0.tar.gz.asc (GPG signature)
```

**Verification for users:**
```bash
# Download and verify
curl -LO https://github.com/fcavalcantirj/proactive-amcp/releases/download/v0.8.0/proactive-amcp-0.8.0.tar.gz
curl -LO https://github.com/fcavalcantirj/proactive-amcp/releases/download/v0.8.0/proactive-amcp-0.8.0.tar.gz.sha256
sha256sum -c proactive-amcp-0.8.0.tar.gz.sha256
```

### Phase 5: Audit-Friendly Docs

**New file:** `SECURITY.md`

Contents:
- What data is collected/transmitted
- Which endpoints are contacted
- What files are created locally
- What persistent services are installed
- How to audit before install
- How to uninstall completely

---

## Data Flow Documentation

### Checkpoint Creation
```
Local files collected:
  - ~/.openclaw/workspace/SOUL.md
  - ~/.openclaw/workspace/MEMORY.md
  - ~/.openclaw/workspace/USER.md
  - ~/.openclaw/workspace/TOOLS.md
  - ~/.openclaw/workspace/memory/*.md
  - ~/.amcp/identity.json
  - ~/.amcp/config.json (secrets redacted)

Tarball created → (optional encrypt) → Pin to IPFS

Metadata sent to Solvr:
  - Agent ID
  - CID
  - Timestamp
  - Trigger reason
  - File manifest (names only, not content)
```

### What's NOT Sent
- OpenClaw config (contains API keys)
- AgentMemory vault contents
- System files outside workspace

---

## File Changes

| File | Change |
|------|--------|
| `skill/SKILL.md` | Remove git clone instructions, reference bundled scripts |
| `skill/scripts/*` | Copy all scripts into skill package |
| `skill/skill.json` | Add requiredEnvVars, binaries, persistence, networkAccess |
| `skill/SECURITY.md` | New file documenting data flows |
| `scripts/checkpoint.sh` | Add --encrypt flag |
| `scripts/resuscitate.sh` | Add --key-file flag |
| `.github/workflows/release.yml` | Add signed release workflow |

---

## Success Criteria

1. [ ] `clawdhub search proactive-amcp` shows declared env vars
2. [ ] Installing from ClawdHub requires no external fetch
3. [ ] `--encrypt` flag produces encrypted checkpoint
4. [ ] GitHub releases include SHA256 hashes
5. [ ] SECURITY.md documents all data flows
6. [ ] VirusTotal/security scanners show reduced warnings

---

## Version

This will be **v0.8.0** — breaking change due to structure reorganization.

---

*Spec created: 2026-02-23*
*Status: DRAFT — awaiting validation*
