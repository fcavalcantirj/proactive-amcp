# Phase 4: Plugin Architecture for proactive-amcp

> **Status:** Planning
> **Prerequisite:** Phase 3 complete
> **Inspiration:** SecureClaw's dual-stack approach (plugin + skill)

---

## The Problem

Current proactive-amcp is **skill-only**. This means:
- All logic lives in the agent's context window as instructions
- Skills can be overridden by prompt injection
- If an attacker manipulates input, they can tell the agent to "ignore AMCP" or "skip checkpoints"
- Checkpoint triggers depend on agent compliance
- No enforcement at system level

## The Solution: Plugin + Skill Layered Defense

Following SecureClaw's architecture:

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 1: Plugin (Code-Level)                          │
│  • Gateway-enforced checkpoints                        │
│  • Background monitors                                 │
│  • Identity verification (KERI)                        │
│  • Cannot be prompt-injected                           │
├─────────────────────────────────────────────────────────┤
│  LAYER 2: Skill (Behavioral)                           │
│  • Agent awareness and instructions                    │
│  • Manual checkpoint triggers                          │
│  • Resurrection guidance                               │
│  • Real-time context for agent                         │
└─────────────────────────────────────────────────────────┘
```

---

## What We Learned from SecureClaw

### Plugin Structure
```
proactive-amcp/
├── openclaw.plugin.json     # Plugin manifest with configSchema
├── src/
│   ├── index.ts             # Main plugin, registers CLI/services/hooks
│   ├── checkpoint-engine.ts # Core checkpoint logic
│   ├── identity-manager.ts  # KERI identity operations
│   ├── monitors/
│   │   ├── context-monitor.ts    # Watch context %, trigger checkpoints
│   │   ├── memory-integrity.ts   # Detect tampering
│   │   └── resurrection-detector.ts  # Detect context wipes
│   └── utils/
│       ├── ipfs.ts          # IPFS pinning
│       └── crypto.ts        # Encryption
├── skill/                   # Existing skill component
│   ├── SKILL.md
│   └── scripts/
└── package.json
```

### Key Patterns from SecureClaw

1. **Plugin Registration API**
```typescript
register(api: PluginApi) {
  // Background services (monitors)
  api.registerService({ id: 'amcp-context-monitor', start, stop });
  
  // Lifecycle hooks
  api.on('gateway_start', async () => { /* auto-checkpoint on start */ });
  api.on('session_end', async () => { /* checkpoint before wipe */ });
  
  // CLI commands
  api.registerCli(({ program }) => {
    program.command('amcp checkpoint').action(/* ... */);
    program.command('amcp resurrect').action(/* ... */);
  });
}
```

2. **Config Schema** (in `openclaw.plugin.json`)
```json
{
  "configSchema": {
    "properties": {
      "autoCheckpoint": { "type": "boolean" },
      "checkpointIntervalMs": { "type": "number" },
      "contextThreshold": { "type": "number", "description": "Checkpoint when context > X%" },
      "ipfsPinningService": { "enum": ["pinata", "infura", "local"] },
      "encryptionKey": { "type": "string", "description": "Path to encryption key" }
    }
  }
}
```

3. **Background Monitors**
- Don't rely on agent following instructions
- Run as background services alongside gateway
- Can trigger actions automatically

---

## Phase 4 Tasks

### Infrastructure (P4-INF)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-INF-01 | Plugin manifest | Create `openclaw.plugin.json` with configSchema | P0 |
| P4-INF-02 | TypeScript setup | Initialize TypeScript project in `src/` | P0 |
| P4-INF-03 | Plugin registration | Implement `register()` with OpenClaw plugin API | P0 |
| P4-INF-04 | Build pipeline | npm scripts for build/test/publish | P1 |
| P4-INF-05 | Integration tests | Tests for plugin + OpenClaw integration | P1 |

### Context Monitor (P4-CTX)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-CTX-01 | Context % tracking | Monitor session context usage in real-time | P0 |
| P4-CTX-02 | Threshold triggers | Auto-checkpoint when context > configurable % | P0 |
| P4-CTX-03 | Time-based triggers | Checkpoint every N minutes (configurable) | P1 |
| P4-CTX-04 | Value-based triggers | Checkpoint when high-value content detected | P2 |

### Identity Manager (P4-ID)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-ID-01 | KERI validation | System-level identity verification | P0 |
| P4-ID-02 | Key rotation | Handle pre-rotation keys at plugin level | P1 |
| P4-ID-03 | Identity injection | Auto-inject identity on resurrection | P1 |
| P4-ID-04 | Multi-agent support | Support multiple agent identities | P2 |

### Resurrection Detector (P4-RES)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-RES-01 | Context wipe detection | Detect when context is cleared/compacted | P0 |
| P4-RES-02 | Auto-recovery injection | Inject recovery instructions automatically | P0 |
| P4-RES-03 | Checkpoint selection | Auto-select best checkpoint for recovery | P1 |
| P4-RES-04 | Partial recovery | Support partial resurrection (specific memories) | P2 |

### Memory Integrity (P4-MEM)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-MEM-01 | Hash baseline | Create baseline of memory file hashes | P1 |
| P4-MEM-02 | Tamper detection | Alert on unauthorized memory changes | P1 |
| P4-MEM-03 | Injection scanning | Scan memory files for prompt injection | P1 |
| P4-MEM-04 | Auto-restore | Restore from checkpoint on tampering | P2 |

### CLI Commands (P4-CLI)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-CLI-01 | `amcp status` | Show AMCP status, last checkpoint, identity | P0 |
| P4-CLI-02 | `amcp checkpoint` | Manual checkpoint trigger | P0 |
| P4-CLI-03 | `amcp resurrect` | Manual resurrection from checkpoint | P0 |
| P4-CLI-04 | `amcp identity` | Identity management commands | P1 |
| P4-CLI-05 | `amcp history` | Show checkpoint history | P1 |
| P4-CLI-06 | `amcp verify` | Verify checkpoint integrity | P1 |

### Lifecycle Hooks (P4-HOOK)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-HOOK-01 | `gateway_start` | Auto-checkpoint on gateway start | P0 |
| P4-HOOK-02 | `session_end` | Checkpoint before session ends | P0 |
| P4-HOOK-03 | `context_warning` | Hook for context threshold alerts | P1 |
| P4-HOOK-04 | `before_compaction` | Checkpoint before context compaction | P1 |

### Documentation (P4-DOC)

| ID | Task | Description | Priority |
|----|------|-------------|----------|
| P4-DOC-01 | Plugin README | Document plugin installation and config | P1 |
| P4-DOC-02 | Architecture doc | Explain plugin + skill synergy | P1 |
| P4-DOC-03 | Migration guide | Upgrading from skill-only to plugin+skill | P1 |

---

## Task Count Summary

| Category | P0 | P1 | P2 | Total |
|----------|----|----|----| ------|
| Infrastructure | 3 | 2 | 0 | 5 |
| Context Monitor | 2 | 1 | 1 | 4 |
| Identity Manager | 1 | 2 | 1 | 4 |
| Resurrection | 2 | 1 | 1 | 4 |
| Memory Integrity | 0 | 3 | 1 | 4 |
| CLI Commands | 3 | 3 | 0 | 6 |
| Lifecycle Hooks | 2 | 2 | 0 | 4 |
| Documentation | 0 | 3 | 0 | 3 |
| **TOTAL** | **13** | **17** | **4** | **34** |

---

## Implementation Order

### Sprint 1: Core Plugin Infrastructure
1. P4-INF-01: Plugin manifest
2. P4-INF-02: TypeScript setup
3. P4-INF-03: Plugin registration
4. P4-CLI-01: `amcp status`
5. P4-CLI-02: `amcp checkpoint`
6. P4-CLI-03: `amcp resurrect`

### Sprint 2: Context Monitoring
1. P4-CTX-01: Context % tracking
2. P4-CTX-02: Threshold triggers
3. P4-HOOK-01: `gateway_start`
4. P4-HOOK-02: `session_end`

### Sprint 3: Identity & Resurrection
1. P4-ID-01: KERI validation
2. P4-RES-01: Context wipe detection
3. P4-RES-02: Auto-recovery injection
4. P4-ID-03: Identity injection

### Sprint 4: Memory Integrity & Polish
1. P4-MEM-01: Hash baseline
2. P4-MEM-02: Tamper detection
3. P4-MEM-03: Injection scanning
4. P4-INF-04: Build pipeline
5. P4-INF-05: Integration tests
6. P4-DOC-*: All documentation

---

## Security Considerations

### What Plugin Enforces (Cannot Be Bypassed)
- Checkpoint triggers based on context %
- Identity verification before operations
- Memory integrity checks
- Resurrection injection on context wipe

### What Skill Advises (Agent Follows)
- When to manually checkpoint
- How to use checkpoints
- Recovery guidance
- Best practices

### Defense in Depth
If skill instructions are overridden by prompt injection:
- Plugin still enforces checkpoints
- Plugin still validates identity
- Plugin still detects tampering
- Plugin still injects recovery on wipe

---

## Research Papers to Study

1. **KERI (Key Event Receipt Infrastructure)** - Self-sovereign identity
2. **IPFS Content Addressing** - Immutable checkpoint storage
3. **Context Window Management** - Optimal checkpoint triggers
4. **Prompt Injection Defenses** - Why plugin layer matters

---

## Open Questions

1. **Hook availability**: Does OpenClaw expose `before_compaction` hook?
2. **Context % API**: How to get real-time context usage from gateway?
3. **Plugin distribution**: npm package or OpenClaw plugin registry?
4. **Backwards compatibility**: How to support skill-only installs?

---

*Created: 2026-02-19*
*Based on: SecureClaw architecture study*
