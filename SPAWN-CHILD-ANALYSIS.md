# Spawn Child Process — End-to-End Analysis

> Does current code support this? What needs to change?

---

## The "Spawn Child" Process

```
┌─────────────────────────────────────────────────────────────────┐
│                    SPAWN CHILD FLOW                              │
│                                                                 │
│  1. PARENT exists with:                                         │
│     - Identity (AID, keys, KEL)                                │
│     - Checkpoint (memories, soul, secrets, state)              │
│                                                                 │
│  2. HUMAN requests: "Spawn a child for [task]"                 │
│                                                                 │
│  3. SYSTEM does:                                                │
│     a. Generate NEW keypair for child                          │
│     b. Create child AID                                        │
│     c. Create inception event with `forkedFrom: parent.aid`    │
│     d. Copy memories from parent checkpoint                    │
│     e. Copy soul (or customize for child role)                 │
│     f. Issue UCAN delegation from parent to child              │
│     g. Child starts with full context + limited capabilities   │
│                                                                 │
│  4. CHILD works on task                                        │
│     - Has parent's memories (read)                             │
│     - Can add new memories (write to shared tree)              │
│     - Cannot checkpoint as parent (only as self)               │
│                                                                 │
│  5. MERGE when done                                            │
│     - Child learnings flow to parent                           │
│     - Parent creates unified checkpoint                        │
│     - Child can be terminated or kept alive                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Current Code Analysis

### @amcp/core (Identity)

| Feature Needed | Current Status | Gap? |
|----------------|----------------|------|
| Generate keypair | ✅ `generateKeypair()` | No |
| Create AID | ✅ `aidFromPublicKey()` | No |
| Create inception event | ✅ `createInceptionEvent()` | **YES** — No `forkedFrom` field |
| Sign as agent | ✅ `signWithAgent()` | No |
| Verify lineage | ❌ Not implemented | **YES** |

**Code change needed:**

```typescript
// Current
interface InceptionEvent {
  type: 'inception';
  aid: AID;
  sn: 0;
  prior: null;
  keys: string[];
  next: string;
  timestamp: string;
  signature: string;
}

// Needed
interface InceptionEvent {
  type: 'inception';
  aid: AID;
  sn: 0;
  prior: null;
  keys: string[];
  next: string;
  timestamp: string;
  signature: string;
  forkedFrom?: AID;           // NEW: Parent agent
  forkType?: 'child' | 'twin' | 'clone';  // NEW: Type of fork
  inheritedCheckpoint?: CID;  // NEW: What checkpoint we forked from
}
```

### @amcp/memory (Checkpoints)

| Feature Needed | Current Status | Gap? |
|----------------|----------------|------|
| Create checkpoint | ✅ `createCheckpoint()` | No |
| Single parent (prior) | ✅ `prior: CID` | **YES** — Only single parent |
| Multiple parents | ❌ Not implemented | **YES** — Need for merge |
| Memory DAG | ❌ Linear chain only | **YES** — Need DAG |
| Twin registry | ❌ Not implemented | **YES** |

**Code change needed:**

```typescript
// Current
interface MemoryChain {
  aid: AID;
  checkpoints: Checkpoint[];  // Linear array
}

interface Checkpoint {
  prior: CID | null;          // Single parent
  // ...
}

// Needed
interface MemoryTree {
  aid: AID;
  root: CID;                  // Tree root
  head: CID;                  // Current head(s) - can be multiple!
  nodes: Map<CID, MemoryNode>;
}

interface MemoryNode {
  cid: CID;
  parents: CID[];             // MULTIPLE parents for merge
  author: AID;                // Who created this node
  type: 'checkpoint' | 'memory' | 'merge';
  // ...
}

interface Checkpoint {
  prior: CID[];               // ARRAY of parents (for merge)
  forkedFrom?: AID;           // If this is a child
  twinRegistry?: TwinRegistry;
  // ...
}
```

### @amcp/recovery (Recovery)

| Feature Needed | Current Status | Gap? |
|----------------|----------------|------|
| Recover from mnemonic + CID | ✅ `recoverAgent()` | No |
| Recover child (with lineage) | ❌ Not implemented | **YES** |
| Merge children | ❌ Not implemented | **YES** |

**Code change needed:**

```typescript
// NEW function needed
async function spawnChild(
  parent: Agent,
  parentCheckpoint: CID,
  options: {
    name?: string;
    role?: string;
    capabilities?: Capability[];
    soulOverrides?: Partial<Soul>;
  }
): Promise<{ child: Agent; ucan: UCAN }> {
  // 1. Generate new keypair
  const keypair = generateKeypair();
  
  // 2. Create child agent with lineage
  const child = await createAgent({
    keypair,
    name: options.name || `${parent.name}-child`,
    forkedFrom: parent.aid,
    inheritedCheckpoint: parentCheckpoint,
  });
  
  // 3. Issue UCAN delegation
  const ucan = await delegate(parent, child.aid, {
    capabilities: options.capabilities || ['memory:read', 'memory:write'],
    expiration: '24h',
  });
  
  // 4. Copy memories from parent
  await copyMemories(parentCheckpoint, child);
  
  return { child, ucan };
}
```

### @amcp/exchange (Export/Import)

| Feature Needed | Current Status | Gap? |
|----------------|----------------|------|
| Export agent | ✅ `exportAgent()` | No |
| Import agent | ✅ `importAgent()` | No |
| Export with children | ❌ Not implemented | **YES** |
| Import as child | ❌ Not implemented | **YES** |

### @amcp/ucan (Delegation) — DOESN'T EXIST

| Feature Needed | Current Status | Gap? |
|----------------|----------------|------|
| Issue delegation | ❌ Package not built | **YES** |
| Verify delegation | ❌ Package not built | **YES** |
| Revoke delegation | ❌ Package not built | **YES** |
| Capability attenuation | ❌ Package not built | **YES** |

**New package needed:**

```typescript
// @amcp/ucan - NEW PACKAGE

interface UCAN {
  header: { alg: 'EdDSA'; typ: 'JWT' };
  payload: {
    iss: AID;                 // Issuer (parent)
    aud: AID;                 // Audience (child)
    exp: number;              // Expiration
    cap: Capability[];        // Granted capabilities
    prf: CID[];               // Proof chain
  };
  signature: string;
}

interface Capability {
  with: string;               // Resource: "memory:/parent-aid/*"
  can: string;                // Action: "read" | "write"
}

// Functions
function delegate(issuer: Agent, audience: AID, caps: CapabilityGrant): Promise<UCAN>;
function verify(ucan: UCAN, requiredCap: Capability): Promise<boolean>;
function revoke(issuer: Agent, ucanCID: CID): Promise<void>;
function attenuate(ucan: UCAN, newCaps: Capability[]): Promise<UCAN>;
```

---

## Impact on Existing Code

### Files That Need Changes

| Package | File | Change |
|---------|------|--------|
| @amcp/core | `src/kel.ts` | Add `forkedFrom` to InceptionEvent |
| @amcp/core | `src/agent.ts` | Add `forkedFrom` to createAgent options |
| @amcp/core | `src/index.ts` | Export new types |
| @amcp/memory | `src/chain.ts` | Rename to `tree.ts`, support DAG |
| @amcp/memory | `src/checkpoint.ts` | Support multiple parents |
| @amcp/memory | `src/index.ts` | Export new types |
| @amcp/recovery | `src/recovery.ts` | Add `spawnChild()` function |
| @amcp/exchange | `src/exchange.ts` | Support children in bundle |
| **NEW** | `@amcp/ucan/*` | Entire new package |

### Tests That Need Updates

| Package | Test File | Changes |
|---------|-----------|---------|
| @amcp/core | `agent.test.ts` | Add fork tests |
| @amcp/core | `kel.test.ts` | Add lineage tests |
| @amcp/memory | `checkpoint.test.ts` | Add merge tests |
| @amcp/memory | `chain.test.ts` → `tree.test.ts` | DAG tests |
| @amcp/recovery | `recovery.test.ts` | Add spawn tests |
| **NEW** | `@amcp/ucan/*.test.ts` | All UCAN tests |

### Backward Compatibility

| Concern | Solution |
|---------|----------|
| Old checkpoints have `prior: CID` | Support both `prior: CID` and `prior: CID[]` |
| Old agents have no `forkedFrom` | Optional field, absence means "genesis" |
| Old code expects chain | Memory tree degrades to chain if single parent |

---

## Impact on Tasks Ahead

### proactive-amcp Skill

| Task | Impact | Action |
|------|--------|--------|
| Checkpoint creation | Minor | Add optional `twinRegistry` field |
| Recovery | Minor | Add optional `forkedFrom` handling |
| Watchdog | None | Single agent focus |
| Triggers | None | Single agent focus |

**Verdict:** Can build proactive-amcp WITHOUT twins. Just add empty/optional fields for future.

### Future Tasks

| Task | Priority | Dependency |
|------|----------|------------|
| Build @amcp/ucan | P2 | Before twins work |
| Upgrade MemoryChain → MemoryTree | P2 | Before twins work |
| Add spawnChild() | P2 | After @amcp/ucan |
| Add merge protocol | P2 | After MemoryTree |
| Add twin registry | P2 | After merge |
| Integration tests | P2 | After all above |

---

## Recommended Approach

### Phase 1: Core proactive-amcp (NOW)
Build single-agent proactive-amcp skill with:
- ✅ All checkpoint fields (design for twins)
- ✅ Optional `forkedFrom` in schema (not used yet)
- ✅ Optional `twinRegistry` in schema (empty)
- ✅ Single-parent checkpoints (but schema allows array)

### Phase 2: Twins Foundation
- Build @amcp/ucan package
- Upgrade MemoryChain → MemoryTree
- Add `forkedFrom` to InceptionEvent
- Add spawnChild() function

### Phase 3: Twins Complete
- Implement merge protocol
- Add twin registry
- Add coordination mechanisms
- Integration tests

---

## Schema Design (Forward-Compatible)

Design checkpoint schema NOW to support twins LATER:

```typescript
interface CompleteAMCPCheckpoint {
  version: '1.0.0';
  
  // Identity
  aid: string;
  kel: KeyEventLog;
  forkedFrom?: AID;           // Ready for Phase 2
  forkType?: 'child' | 'twin';
  
  // ... all other fields ...
  
  // Memory (forward-compatible)
  memoryTree?: {
    head: CID;                // Current head (single for now)
    parents?: CID[];          // For merge (empty for now)
    nodeCount: number;
  };
  
  // Twins (forward-compatible)
  twinRegistry?: {
    isQueen: boolean;         // Am I the main agent?
    queen?: AID;              // If I'm a twin, who's my queen?
    twins: TwinInfo[];        // Empty array for now
    lastMerge?: MergeInfo;
  };
  
  // Delegation (forward-compatible)
  activeDelegations?: {
    issued: UCANRef[];        // Delegations I've issued
    received: UCANRef[];      // Delegations I've received
  };
  
  // ... rest of schema ...
}
```

**By designing for twins NOW, we avoid rework LATER.**

---

## Verdict

### Current Code Ready? **NO** (60%)

| Component | Ready? | Gap |
|-----------|--------|-----|
| Identity with lineage | ❌ | Need `forkedFrom` |
| Memory tree (DAG) | ❌ | Only chain exists |
| UCAN delegation | ❌ | Package not built |
| Spawn child | ❌ | Function not built |
| Merge protocol | ❌ | Not designed |

### Can Build proactive-amcp Now? **YES**

Single-agent works. Design schema for future twins.

### Effort to Add Twins Later

| Task | Estimate |
|------|----------|
| @amcp/ucan package | 2-3 days |
| MemoryTree upgrade | 1-2 days |
| spawnChild function | 1 day |
| Merge protocol | 2-3 days |
| Integration tests | 1-2 days |
| **Total** | **7-11 days** |

---

## Updated Gap List

**Previous:** 10 gaps (9 critical + 1 P2)

**With spawn analysis:**

| # | Gap | Phase | Priority |
|---|-----|-------|----------|
| 1-9 | (previous critical gaps) | Phase 1 | P0 |
| 10 | Multi-agent twins | Phase 3 | P2 |
| **11** | **@amcp/ucan package** | Phase 2 | P1 |
| **12** | **MemoryTree (DAG) upgrade** | Phase 2 | P1 |
| **13** | **spawnChild function** | Phase 2 | P1 |
| **14** | **Merge protocol** | Phase 3 | P2 |
| **15** | **forkedFrom in InceptionEvent** | Phase 2 | P1 |

**Total:** 15 identified gaps (9 P0, 4 P1, 2 P2)

---

*Design for many. Build for one. Scale when ready.*
