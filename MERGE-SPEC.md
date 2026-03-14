# Merge Specification: self-improvement → proactive-amcp

> Goal: Absorb self-improvement's structured learning capture without breaking proactive-amcp's IPFS/Solvr/resurrection capabilities.

---

## What self-improvement Has That proactive-amcp Doesn't

### 1. Structured Learning IDs

| Feature | self-improvement | proactive-amcp |
|---------|------------------|----------------|
| ID format | `LRN-YYYYMMDD-XXX`, `ERR-YYYYMMDD-XXX`, `FEAT-YYYYMMDD-XXX` | None (freeform) |
| Tracking | Can grep/search by ID | No consistent identifiers |
| Linking | `See Also: LRN-20250110-001` | Manual memory search |

**Action:** Add ID generation to `/remember`, `/stuck`, `/learned` commands.

### 2. Priority & Status Lifecycle

| Field | Values | Purpose |
|-------|--------|---------|
| `priority` | `low`, `medium`, `high`, `critical` | Triage importance |
| `status` | `pending`, `in_progress`, `resolved`, `promoted`, `wont_fix` | Track lifecycle |

**Current proactive-amcp:** Learnings are flat entries with no lifecycle.

**Action:** Add priority/status to `memory/learning/*.jsonl` schema.

### 3. Area Tags

| Tag | Scope |
|-----|-------|
| `frontend` | UI, components, client-side |
| `backend` | API, services, server-side |
| `infra` | CI/CD, deployment, Docker |
| `tests` | Test files, coverage |
| `docs` | Documentation, READMEs |
| `config` | Configuration, settings |

**Action:** Add `area` field, auto-detect from file paths.

### 4. Recurrence Tracking

| Field | Purpose |
|-------|---------|
| `seeAlso` | Links to related entries |
| `recurrenceCount` | How many times this issue appeared |
| `firstSeen` | First occurrence date |
| `lastSeen` | Most recent occurrence |

**Behavior:** When logging similar issue:
1. Search existing entries
2. If match found, increment `recurrenceCount`, update `lastSeen`, add `seeAlso`
3. If `recurrenceCount >= 3`, auto-bump priority

**Action:** Add deduplication logic to learning capture.

### 5. Dedicated File Structure

```
.learnings/
├── LEARNINGS.md      # Corrections, knowledge gaps, best practices
├── ERRORS.md         # Command failures, exceptions
└── FEATURE_REQUESTS.md # User-requested capabilities
```

**Current proactive-amcp:** Uses `memory/learning/*.jsonl` (good) but no markdown summaries.

**Action:** Generate `.learnings/*.md` summaries from JSONL data for human readability.

### 6. Promotion Workflow

| Learning Type | Promote To |
|---------------|------------|
| Behavioral patterns | `SOUL.md` |
| Workflow improvements | `AGENTS.md` |
| Tool gotchas | `TOOLS.md` |
| Project facts | `CLAUDE.md` (if exists) |

**Command:** `/promote <id> <target>` — moves learning to permanent file, sets status=`promoted`.

**Action:** Add promotion command and targets.

### 7. Hook-Based Reminders

| Hook | Trigger | Action |
|------|---------|--------|
| `activator.sh` | `UserPromptSubmit` | Injects learning evaluation reminder |
| `error-detector.sh` | `PostToolUse` (Bash) | Detects errors, suggests logging |
| `handler.js` | `agent:bootstrap` | Reminds to check `.learnings/` |

**Current proactive-amcp:** No hooks, relies on natural language triggers.

**Action:** Port hooks as optional (disabled by default, user enables).

### 8. Detection Triggers

self-improvement detects patterns in conversation:

| Pattern | Creates |
|---------|---------|
| "No, that's not right..." | Learning (correction) |
| "Actually, it should be..." | Learning (correction) |
| "Can you also..." | Feature request |
| "I wish you could..." | Feature request |
| User provides unknown info | Learning (knowledge_gap) |
| Command returns non-zero | Error entry |

**Current proactive-amcp:** Has `/remember`, `/stuck`, `/learned` but no pattern detection.

**Action:** Add pattern detection to conversation handler (optional, via hook).

---

## What proactive-amcp Has That self-improvement Doesn't

| Feature | proactive-amcp | self-improvement |
|---------|----------------|------------------|
| IPFS persistence | ✅ CID-addressable checkpoints | ❌ Local files only |
| Cryptographic identity | ✅ Ed25519/KERI | ❌ None |
| Solvr integration | ✅ Search/post/approach lifecycle | ❌ None |
| Death/resurrection | ✅ `resuscitate.sh --from-cid` | ❌ None |
| Secrets handling | ✅ Double-encrypted in checkpoints | ❌ None |
| Watchdog | ✅ Auto-recovery on failure | ❌ None |
| Notifications | ✅ Telegram, Email | ❌ None |
| Groq intelligence | ✅ Memory pruning, condensing | ❌ None |

**These stay intact.** Merge adds structured logging ON TOP of existing capabilities.

---

## Security Improvements (From Scanner Feedback)

### 1. Declare Dependencies in Metadata

**Current SKILL.md metadata:**
```yaml
metadata:
  # Empty
```

**Should be:**
```yaml
metadata:
  openclaw:
    emoji: "🏴‍☠️"
    requires:
      bins: [python3, curl, jq]
      optionalBins: [claude, agentmemory, systemctl]
    installs:
      systemd: true
      cron: true
    credentials:
      optional:
        - name: solvr.apiKey
          purpose: IPFS pinning and Solvr network
        - name: pinata.jwt
          purpose: Alternative IPFS pinning
        - name: groq.apiKey
          purpose: Intelligent memory pruning
```

### 2. Remove `eval` from disk-cleanup.sh

**Current:**
```bash
cleanup() {
  local name="$1" cmd="$2"
  eval "$cmd" 2>/dev/null || true
}
```

**Should be:**
```bash
cleanup() {
  local name="$1"
  shift
  "$@" 2>/dev/null || true
}

# Usage:
cleanup "pnpm store" rm -rf ~/.local/share/pnpm/store
```

### 3. Add Explicit Consent for --full Mode

**Add to full-checkpoint.sh:**
```bash
if [[ "$1" != "--yes" ]]; then
  echo "⚠️  FULL MODE includes ALL secrets (encrypted):"
  echo "    - OpenClaw API keys"
  echo "    - OAuth tokens"
  echo "    - AgentMemory vault secrets"
  echo ""
  read -p "Type YES to confirm: " confirm
  [[ "$confirm" != "YES" ]] && exit 1
fi
```

### 4. Improve Security Documentation Format

self-improvement's assessment format is excellent:
- ✓ Purpose & Capability
- ℹ Instruction Scope
- ✓ Install Mechanism
- ℹ Credentials
- ℹ Persistence & Privilege

**Action:** Update SECURITY.md with similar section headers for scanner recognition.

---

## Implementation Order (Don't Break Anything)

### Phase 1: Security Metadata (Non-Breaking)
1. SEC-001: Add required bins to metadata
2. SEC-002: Add credentials to metadata
3. SEC-005: Document systemd/cron in metadata

### Phase 2: Code Safety (Non-Breaking)
4. SEC-003: Remove `eval` from disk-cleanup.sh
5. SEC-004: Add consent prompt for --full mode

### Phase 3: Structured Logging (Additive)
6. MERGE-001: Add `.learnings/` templates
7. MERGE-002: Add ID generation
8. MERGE-003: Add priority/status fields

### Phase 4: Enhanced Features (Additive)
9. MERGE-004: Recurrence tracking
10. MERGE-005: Area tags
11. MERGE-006: Auto-promotion

### Phase 5: Optional Hooks (Disabled by Default)
12. MERGE-007: Activator hook
13. MERGE-008: Error detector hook

---

## Testing Checklist

Before each phase, verify:

- [ ] `proactive-amcp status` returns READY
- [ ] `checkpoint.sh` creates valid checkpoint
- [ ] `resuscitate.sh` restores from checkpoint
- [ ] `/remember`, `/stuck`, `/learned` still work
- [ ] Solvr integration still works
- [ ] Watchdog still triggers on gateway death
- [ ] Notifications still send

---

## Files Changed

| File | Change Type | Risk |
|------|-------------|------|
| `SKILL.md` | Metadata additions | Low |
| `SECURITY.md` | Documentation format | Low |
| `scripts/disk-cleanup.sh` | Remove eval | Low |
| `scripts/full-checkpoint.sh` | Add consent | Low |
| `assets/LEARNINGS.md` | New template | None |
| `assets/ERRORS.md` | New template | None |
| `assets/FEATURE_REQUESTS.md` | New template | None |
| `scripts/generate-learning-id.sh` | New script | None |
| `scripts/promote-learning.sh` | New script | None |
| `hooks/openclaw/handler.js` | New hook (disabled) | None |
| `scripts/error-detector.sh` | New script | None |

---

## Success Criteria

1. **Security scanner rating:** "Suspicious medium" → "Benign high" (or documented acceptable)
2. **Learning capture:** Structured IDs, priority, status, recurrence
3. **No regressions:** All existing tests pass, watchdog/checkpoint/resurrect work
4. **Backwards compatible:** Old checkpoints still loadable

---

*"Their security report is gorgeous. Ours should be too."*
