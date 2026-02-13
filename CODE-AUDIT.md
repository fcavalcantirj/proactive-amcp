# CODE AUDIT — Task by Task, File by File

> Double-checked. Triple-checked. Every gap documented.

---

## PACKAGE STATUS SUMMARY

| Package | Files | Tests | Status | Gaps |
|---------|-------|-------|--------|------|
| @amcp/core | 10 | 259 | ✅ Built | 3 gaps |
| @amcp/memory | 8 | 37 | ✅ Built | 4 gaps |
| @amcp/recovery | 6 | 51 | ✅ Built | 2 gaps |
| @amcp/exchange | 4 | 58 | ✅ Built | 2 gaps |
| @amcp/ucan | 0 | 0 | ❌ EMPTY | Not built |
| @amcp/middleware | 0 | 0 | ❌ EMPTY | Not built |

**Total tests passing:** 284 (but critical gaps in coverage)

---

## @amcp/core — DETAILED AUDIT

### Files

| File | Purpose | Status | Gaps |
|------|---------|--------|------|
| `agent.ts` | Create/manage agents | ✅ | No `forkedFrom` param |
| `aid.ts` | Generate AIDs | ✅ | OK |
| `crypto.ts` | Crypto primitives | ✅ | OK |
| `kel.ts` | Key Event Log | ✅ | No `forkedFrom` in InceptionEvent |
| `mnemonic.ts` | BIP-39 support | ✅ | OK |
| `index.ts` | Exports | ✅ | OK |
| `types/*.ts` | Type schemas | ✅ | Missing workspace, twins |

### Gap 1: InceptionEvent missing `forkedFrom`

**File:** `kel.ts` line 23-33

**Current:**
```typescript
export interface InceptionEvent extends KeyEventBase {
  type: 'inception';
  sn: 0;
  prior: null;
  keys: string[];
  next: string;
}
```

**Needed:**
```typescript
export interface InceptionEvent extends KeyEventBase {
  type: 'inception';
  sn: 0;
  prior: null;
  keys: string[];
  next: string;
  forkedFrom?: AID;              // NEW
  forkType?: 'child' | 'twin';   // NEW
  inheritedCheckpoint?: CID;     // NEW
}
```

### Gap 2: createInceptionEvent doesn't support forking

**File:** `kel.ts` line 70-90

**Current:** No fork parameters
**Needed:** Add `forkedFrom`, `forkType`, `inheritedCheckpoint` to options

### Gap 3: checkpoint-schema.ts missing critical fields

**File:** `types/checkpoint-schema.ts`

**Current AMCPCheckpointContent has:**
- ✅ version, aid, kel, prior, timestamp
- ✅ soul (name, principles, voice, northStar)
- ✅ services[]
- ✅ secrets (EncryptedBlob)
- ✅ memory (entries, state, ambient, relationships, workInProgress, humanMarked)
- ✅ metadata

**Missing:**
```typescript
// NOT IN SCHEMA:
workspace?: {                    // Workspace files
  files: Record<string, string>; // SOUL.md, MEMORY.md, etc.
};

forkedFrom?: AID;                // Lineage

twinRegistry?: {                 // Twin support
  isQueen: boolean;
  twins: TwinInfo[];
};

northStarState?: {               // Self-improvement tracking
  config: NorthStarConfig;
  metrics: MetricHistory[];
  patterns: Pattern[];
};

cronJobs?: CronJob[];            // Scheduled tasks
```

---

## @amcp/memory — DETAILED AUDIT

### Files

| File | Purpose | Status | Gaps |
|------|---------|--------|------|
| `checkpoint.ts` | Create checkpoints | ✅ | `prior: CID | null` single parent |
| `chain.ts` | Linear chain | ✅ | Not a DAG, no merge |
| `cid.ts` | Compute CIDs | ✅ | OK |
| `encryption.ts` | X25519 + ChaCha20 | ✅ | OK |
| `storage/interface.ts` | Backend interface | ✅ | OK |
| `storage/filesystem.ts` | Local storage | ✅ | OK |
| `storage/ipfs.ts` | IPFS backend | ✅ | OK |
| `storage/git.ts` | Git backend | ✅ | OK |

### Gap 4: MemoryCheckpoint only supports single parent

**File:** `checkpoint.ts` line 20

**Current:**
```typescript
export interface MemoryCheckpoint {
  prior: CID | null;  // SINGLE parent
  // ...
}
```

**Needed:**
```typescript
export interface MemoryCheckpoint {
  prior: CID | CID[] | null;  // MULTIPLE parents for merge
  // ...
}
```

### Gap 5: MemoryChain is linear, not DAG

**File:** `chain.ts` line 12-18

**Current:**
```typescript
export interface MemoryChain {
  aid: string;
  checkpoints: MemoryCheckpoint[];  // LINEAR ARRAY
  contentStore: Map<CID, unknown>;
}
```

**Needed:**
```typescript
export interface MemoryTree {
  aid: string;
  root: CID;
  heads: CID[];                     // Can have multiple heads
  nodes: Map<CID, MemoryNode>;      // DAG structure
}

export interface MemoryNode {
  cid: CID;
  parents: CID[];                   // Multiple parents
  author: AID;                      // Who created this
  type: 'checkpoint' | 'memory' | 'merge';
  content: unknown;
}
```

### Gap 6: No merge function

**File:** N/A - doesn't exist

**Needed:**
```typescript
export async function mergeNodes(
  tree: MemoryTree,
  heads: CID[],
  agent: Agent
): Promise<CID> {
  // Create merge node with multiple parents
}
```

### Gap 7: Encryption doesn't include all secrets

**File:** `encryption.ts`

**Current:** Generic encryption exists
**Gap:** No function to collect ALL secrets from workspace and encrypt

---

## @amcp/recovery — DETAILED AUDIT

### Files

| File | Purpose | Status | Gaps |
|------|---------|--------|------|
| `card.ts` | Recovery card format | ✅ | OK |
| `recovery.ts` | Recovery logic | ✅ | Doesn't restore workspace files |
| `types.ts` | Types | ✅ | OK |
| `index.ts` | Exports | ✅ | OK |

### Gap 8: Recovery doesn't restore workspace files

**File:** `recovery.ts`

**Current:** Restores identity and checkpoint
**Missing:** 
- Write SOUL.md, MEMORY.md, USER.md, TOOLS.md, AGENTS.md, HEARTBEAT.md
- Write memory/*.md daily notes
- Write heartbeat-state.json, amcp-stats.json
- Inject secrets into TOOLS.md

### Gap 9: No spawnChild function

**File:** N/A - doesn't exist

**Needed:**
```typescript
export async function spawnChild(
  parent: Agent,
  checkpoint: CID,
  options: SpawnOptions
): Promise<{ child: Agent; ucan: UCAN }>;
```

---

## @amcp/exchange — DETAILED AUDIT

### Files

| File | Purpose | Status | Gaps |
|------|---------|--------|------|
| `exchange.ts` | Export/import | ✅ | No workspace files |
| `types.ts` | Types | ✅ | OK |
| `index.ts` | Exports | ✅ | OK |

### Gap 10: Export doesn't include workspace files

**File:** `exchange.ts`

**Current:** Exports identity, checkpoint, services, secrets
**Missing:** SOUL.md, MEMORY.md, etc.

### Gap 11: No twin/child export support

**File:** `exchange.ts`

**Missing:** `exportWithChildren()`, `importAsChild()`

---

## @amcp/ucan — NOT BUILT

### Status: EMPTY PACKAGE

**Needed files:**
- `src/ucan.ts` — UCAN creation, verification
- `src/delegation.ts` — Capability delegation
- `src/revocation.ts` — Revocation handling
- `src/types.ts` — Type definitions
- `src/index.ts` — Exports
- Tests

**Estimated effort:** 2-3 days

---

## @amcp/middleware — NOT BUILT

### Status: EMPTY PACKAGE

**Needed files:**
- `src/middleware.ts` — Opaque handle API
- `src/policy.ts` — Capability enforcement
- `src/audit.ts` — Operation logging
- `src/types.ts` — Type definitions
- Tests

**Estimated effort:** 3-4 days

---

## SCHEMA GAP ANALYSIS

### AMCPCheckpointContent — What's Missing

| Field | In Schema? | In Checkpoint Creation? | In Recovery? |
|-------|------------|-------------------------|--------------|
| version | ✅ | ✅ | ✅ |
| aid | ✅ | ✅ | ✅ |
| kel | ✅ | ✅ | ✅ |
| prior | ✅ | ✅ | ✅ |
| timestamp | ✅ | ✅ | ✅ |
| soul | ✅ | ⚠️ Generic | ⚠️ Not written to file |
| services | ✅ | ❌ Empty | ❌ Not restored |
| secrets | ✅ | ⚠️ Generic | ⚠️ Not injected |
| memory.entries | ✅ | ❌ Empty | ❌ Not restored |
| memory.state | ✅ | ❌ Empty | ❌ Not restored |
| memory.ambient | ✅ | ❌ Empty | ❌ Not restored |
| memory.relationships | ✅ | ❌ Empty | ❌ Not restored |
| memory.workInProgress | ✅ | ❌ Empty | ❌ Not restored |
| memory.humanMarked | ✅ | ❌ Empty | ❌ Not restored |
| metadata | ✅ | ✅ | ✅ |
| signature | ✅ | ✅ | ✅ |
| **workspace** | ❌ | ❌ | ❌ |
| **forkedFrom** | ❌ | ❌ | ❌ |
| **twinRegistry** | ❌ | ❌ | ❌ |
| **northStarState** | ❌ | ❌ | ❌ |
| **cronJobs** | ❌ | ❌ | ❌ |

---

## PROACTIVE-AMCP SKILL — Required Functions Not In SDK

| Function Needed | Package | Exists? |
|-----------------|---------|---------|
| `createCheckpointWithWorkspace()` | @amcp/memory | ❌ |
| `recoverWithWorkspace()` | @amcp/recovery | ❌ |
| `detectTrigger()` | @amcp/core | ❌ |
| `trackNorthStar()` | @amcp/core | ❌ |
| `spawnChild()` | @amcp/recovery | ❌ |
| `delegate()` | @amcp/ucan | ❌ Package not built |
| `mergeTree()` | @amcp/memory | ❌ |

---

## COMPLETE GAP LIST (Prioritized)

### P0 — Must Fix for proactive-amcp to Work

| # | Gap | Package | File | Fix |
|---|-----|---------|------|-----|
| 1 | No workspace files in checkpoint | @amcp/memory | checkpoint-schema.ts | Add workspace field |
| 2 | services[] not populated | SDK usage | - | Populate on checkpoint |
| 3 | relationships[] not populated | SDK usage | - | Populate on checkpoint |
| 4 | memory.* fields not populated | SDK usage | - | Populate on checkpoint |
| 5 | Recovery doesn't write workspace | @amcp/recovery | recovery.ts | Add file writing |
| 6 | Secrets not injected on recovery | @amcp/recovery | recovery.ts | Inject to TOOLS.md |
| 7 | No trigger detection | @amcp/core | new file | Build trigger.ts |
| 8 | No North Star tracking | @amcp/core | new file | Build northstar.ts |

### P1 — Needed for Twins Foundation

| # | Gap | Package | File | Fix |
|---|-----|---------|------|-----|
| 9 | InceptionEvent no forkedFrom | @amcp/core | kel.ts | Add fields |
| 10 | prior is single CID | @amcp/memory | checkpoint.ts | Make array |
| 11 | MemoryChain not DAG | @amcp/memory | chain.ts | Rewrite as tree |
| 12 | @amcp/ucan not built | @amcp/ucan | all | Build package |
| 13 | spawnChild not built | @amcp/recovery | - | Add function |

### P2 — Needed for Full Twins

| # | Gap | Package | File | Fix |
|---|-----|---------|------|-----|
| 14 | No merge function | @amcp/memory | tree.ts | Build merge |
| 15 | No twin registry | @amcp/core | checkpoint-schema.ts | Add to schema |
| 16 | @amcp/middleware not built | @amcp/middleware | all | Build package |

---

## DOCUMENTATION STATUS

| Doc | Location | Status |
|-----|----------|--------|
| README | amcp-protocol/README.md | ✅ Good |
| GETTING-STARTED | amcp-protocol/docs/GETTING-STARTED.md | ✅ Good |
| ENVIRONMENT | amcp-protocol/ENVIRONMENT.md | ✅ Good |
| PROTOCOL-SPEC | amcp-protocol/docs/PROTOCOL-SPEC.md | ✅ Good |
| Research backing | amcp-protocol/specs/research-backing.md | ✅ Good |

**Documentation is solid. Code has gaps.**

---

## VERDICT

### Can Build proactive-amcp With Current Code?

**NO — SDK has gaps that must be filled first.**

### What Must Be Done First?

1. **Add workspace field to checkpoint schema** (1 hour)
2. **Build checkpoint creation that populates all fields** (2-4 hours)
3. **Build recovery that writes workspace files** (2-4 hours)
4. **Build trigger detection** (2-4 hours)
5. **Build North Star tracking** (4-6 hours)

**Total before proactive-amcp can work: 12-18 hours of SDK work**

### Recommended Approach

1. **Fix SDK gaps first** (1-2 days)
2. **Then build proactive-amcp skill** (1-2 days)
3. **Then add twins support** (5-7 days)

---

*Every gap documented. Every file audited. No surprises during build.*
