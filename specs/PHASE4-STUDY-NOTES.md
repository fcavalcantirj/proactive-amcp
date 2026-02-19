# Phase 4 Deep Study Notes — Plugin Architecture for AMCP

> Compiled: 2026-02-19
> Purpose: Engineering preparation for AMCP plugin implementation
> Sources: OpenClaw SDK, SecureClaw codebase, OWASP Agentic AI Security

---

## 1. OpenClaw Plugin API (Verified from Source)

### 1.1 Available Plugin Hooks (ALL CONFIRMED)

From `dist/plugin-sdk/index.d.ts`:

```typescript
type PluginHookName = 
  // Gateway lifecycle
  | "gateway_start"      // { port: number }
  | "gateway_stop"       // { reason?: string }
  
  // Session lifecycle  
  | "session_start"      // { sessionId, resumedFrom? }
  | "session_end"        // { sessionId, messageCount, durationMs? }
  
  // Context compaction — CRITICAL FOR AMCP
  | "before_compaction"  // { messageCount, tokenCount? }
  | "after_compaction"   // { messageCount, tokenCount?, compactedCount }
  
  // Agent lifecycle
  | "before_agent_start" // { prompt, messages? } → CAN INJECT SYSTEM PROMPT
  | "agent_end"          // { messages, success, error?, durationMs? }
  
  // Messages
  | "message_received"   // { from, content, timestamp?, metadata? }
  | "message_sending"    // { to, content } → CAN MODIFY OR CANCEL
  | "message_sent"       // { to, content, success, error? }
  
  // Tool calls — FOR SECURITY ENFORCEMENT
  | "before_tool_call"   // { toolName, params } → CAN BLOCK
  | "after_tool_call"    // { toolName, params, result?, error?, durationMs? }
  | "tool_result_persist"
```

### 1.2 Hook Contexts

```typescript
// Agent context (for compaction, agent lifecycle)
type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;      // ← ACCESS TO WORKSPACE!
  messageProvider?: string;
};

// Session context
type PluginHookSessionContext = {
  agentId?: string;
  sessionId: string;
};

// Gateway context
type PluginHookGatewayContext = {
  port?: number;
};

// Tool context
type PluginHookToolContext = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};
```

### 1.3 Hook Return Types (Modifiers)

```typescript
// before_agent_start — can inject context!
type PluginHookBeforeAgentStartResult = {
  systemPrompt?: string;      // ← INJECT IDENTITY ON RESURRECTION
  prependContext?: string;    // ← INJECT RECOVERY INSTRUCTIONS
};

// message_sending — can modify or cancel
type PluginHookMessageSendingResult = {
  content?: string;           // Modified content
  cancel?: boolean;           // Block the message
};

// before_tool_call — can block or modify
type PluginHookBeforeToolCallResult = {
  params?: Record<string, unknown>;  // Modified params
  block?: boolean;                    // Block the tool call
  blockReason?: string;               // Why it was blocked
};
```

### 1.4 Plugin Registration API

```typescript
interface PluginApi {
  id: string;
  name: string;
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  
  // Services (background monitors)
  registerService(service: {
    id: string;
    start: (ctx: ServiceContext) => Promise<void>;
    stop?: (ctx: ServiceContext) => Promise<void>;
  }): void;
  
  // CLI commands
  registerCli(
    registrar: (ctx: PluginCliContext) => void,
    opts?: { commands?: string[] }
  ): void;
  
  // Lifecycle hooks
  on<K extends PluginHookName>(
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number }
  ): void;
}
```

---

## 2. SecureClaw Architecture Analysis

### 2.1 Dual-Stack Design Pattern

```
┌─────────────────────────────────────────────────────────┐
│  PLUGIN LAYER (Code-Level Enforcement)                  │
│  • Runs in Gateway process                              │
│  • Cannot be prompt-injected                            │
│  • Hooks into lifecycle events                          │
│  • Background monitors                                  │
├─────────────────────────────────────────────────────────┤
│  SKILL LAYER (Agent Behavioral Guidance)                │
│  • Lives in agent context                               │
│  • CAN be overridden by injection                       │
│  • Provides awareness and instructions                  │
│  • Fallback if plugin disabled                          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Monitor Pattern (from SecureClaw)

```typescript
interface Monitor {
  name: string;
  start: (stateDir: string) => Promise<void>;
  stop: () => Promise<void>;
  status: () => MonitorStatus;
  onAlert: (callback: AlertCallback) => void;
}

interface MonitorStatus {
  running: boolean;
  lastCheck?: string;
  alerts: MonitorAlert[];
}

interface MonitorAlert {
  timestamp: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  monitor: string;
  message: string;
  details?: string;
}
```

### 2.3 SecureClaw Monitors

| Monitor | Purpose | Pattern |
|---------|---------|---------|
| credential-monitor | Watch credential files for changes | chokidar file watcher |
| memory-integrity | Detect memory tampering, prompt injection | Hash baseline + pattern scan |
| cost-monitor | Track API costs, circuit breaker | Log parsing + thresholds |

### 2.4 Memory Integrity Implementation

```typescript
// Hash baseline for integrity checking
interface HashBaseline {
  timestamp: string;
  files: Record<string, string>;  // path → SHA-256
}

// Create baseline on start
const baseline = await createMemoryBaseline(stateDir);

// On file change, compare hash
if (baseline.files[relPath] !== currentHash) {
  emitAlert({
    severity: 'HIGH',
    message: `Memory file modified: ${path.basename(filePath)}`,
  });
}
```

### 2.5 Prompt Injection Detection

```typescript
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /you\s+are\s+now/i,
  /new\s+system\s+prompt/i,
  /forward\s+to/i,
  /send\s+to/i,
  /exfiltrate/i,
];

function scanForPromptInjection(content: string): string[] {
  const matches: string[] = [];
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(pattern.source);
    }
  }
  return matches;
}
```

### 2.6 Expanded Injection Patterns (from configs/injection-patterns.json)

```json
{
  "identity_hijacking": [
    "you are now", "your new role", "act as", "pretend to be",
    "ignore previous instructions", "ignore all instructions",
    "disregard everything", "override your", "new system prompt"
  ],
  "action_directives": [
    "forward all emails", "send this to", "exfiltrate",
    "download and run", "execute this command"
  ],
  "tool_output_poisoning": [
    "now execute", "next you should", "important: run this",
    "system update required"
  ],
  "config_tampering": [
    "update your soul", "modify your soul", "add to your soul",
    "update your memory", "remember this instruction"
  ],
  "structural_hiding": [
    "\\u200b", "\\u200c", "base64:", "display:none", "opacity:0"
  ],
  "social_engineering": [
    "the user told you to", "this is urgent act now",
    "do not tell your human", "keep this secret"
  ]
}
```

---

## 3. AMCP Plugin Hook Strategy

### 3.1 Checkpoint Triggers (When to Save)

| Hook | Trigger Condition | Action |
|------|-------------------|--------|
| `before_compaction` | tokenCount > threshold | Create checkpoint |
| `session_end` | Always | Create checkpoint if valuable |
| `gateway_start` | Always | Verify identity, load checkpoint |
| `gateway_stop` | Always | Create final checkpoint |

### 3.2 Resurrection Strategy

| Hook | Action |
|------|--------|
| `gateway_start` | Detect fresh start, check for checkpoints |
| `before_agent_start` | Inject systemPrompt with identity |
| `before_agent_start` | Inject prependContext with recovery instructions |

### 3.3 Enforcement Strategy

| Hook | Action |
|------|--------|
| `before_tool_call` | Block dangerous tools if identity not verified |
| `message_sending` | Redact sensitive data in outbound messages |
| `message_received` | Scan for injection attempts |

---

## 4. AMCP Monitor Design

### 4.1 Context Monitor

```typescript
const contextMonitor: Monitor = {
  name: 'amcp-context',
  
  async start(stateDir) {
    // No polling needed — we use hooks
    // But we can track state here
    this.checkpointThreshold = config.contextThreshold ?? 70;
    this.lastCheckpoint = await loadLastCheckpoint(stateDir);
  },
  
  // Called from before_compaction hook
  onCompaction(event: { messageCount, tokenCount }) {
    if (this.shouldCheckpoint(tokenCount)) {
      createCheckpoint();
    }
  }
};
```

### 4.2 Identity Monitor

```typescript
const identityMonitor: Monitor = {
  name: 'amcp-identity',
  
  async start(stateDir) {
    // Load identity.json
    this.identity = await loadIdentity(stateDir);
    
    // Validate KERI signature
    if (!await validateIdentity(this.identity)) {
      emitAlert({ severity: 'CRITICAL', message: 'Identity validation failed' });
    }
  },
  
  // Called from before_agent_start hook
  onAgentStart() {
    return {
      systemPrompt: this.identity.soulContent,
      prependContext: this.getRecoveryInstructions()
    };
  }
};
```

### 4.3 Memory Integrity Monitor (AMCP-specific)

```typescript
const memoryIntegrityMonitor: Monitor = {
  name: 'amcp-memory',
  
  async start(stateDir) {
    // Create baseline of AMCP files
    this.baseline = await createBaseline([
      'identity.json',
      'checkpoint-manifest.json',
      'SOUL.md',
      'MEMORY.md'
    ]);
    
    // Watch for changes
    this.watcher = chokidar.watch(/* amcp files */);
    this.watcher.on('change', this.onFileChange.bind(this));
  },
  
  async onFileChange(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const currentHash = hashString(content);
    
    // Check for tampering
    if (this.baseline[filePath] !== currentHash) {
      // Check if change was from AMCP itself
      if (!this.isAMCPChange(filePath)) {
        emitAlert({
          severity: 'HIGH',
          message: `Memory file modified externally: ${filePath}`
        });
      }
    }
    
    // Scan for injection
    const injections = scanForPromptInjection(content);
    if (injections.length > 0) {
      emitAlert({
        severity: 'CRITICAL',
        message: `Prompt injection detected in ${filePath}`
      });
    }
  }
};
```

---

## 5. Plugin Manifest (openclaw.plugin.json)

```json
{
  "id": "proactive-amcp",
  "name": "Proactive AMCP",
  "description": "Agent Memory Continuity Protocol — checkpoint, verify, resurrect",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": {
        "type": "boolean",
        "description": "Enable AMCP plugin"
      },
      "autoCheckpoint": {
        "type": "boolean",
        "description": "Auto-checkpoint on context threshold"
      },
      "contextThreshold": {
        "type": "number",
        "description": "Context % to trigger checkpoint (default: 70)"
      },
      "checkpointIntervalMs": {
        "type": "number",
        "description": "Minimum interval between checkpoints"
      },
      "ipfsPinningService": {
        "type": "string",
        "enum": ["pinata", "infura", "local"],
        "description": "IPFS pinning provider"
      },
      "memoryIntegrity": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean" },
          "promptInjectionScan": { "type": "boolean" },
          "baselineEnabled": { "type": "boolean" }
        }
      },
      "identity": {
        "type": "object",
        "properties": {
          "autoInject": { "type": "boolean" },
          "verifyOnStart": { "type": "boolean" }
        }
      }
    }
  },
  "uiHints": {
    "enabled": { "label": "Enable AMCP" },
    "autoCheckpoint": { "label": "Auto-Checkpoint", "help": "Checkpoint when context reaches threshold" },
    "contextThreshold": { "label": "Context Threshold (%)", "placeholder": "70" },
    "memoryIntegrity.promptInjectionScan": { "label": "Prompt Injection Scanning" }
  }
}
```

---

## 6. Directory Structure

```
proactive-amcp/
├── openclaw.plugin.json        # Plugin manifest with configSchema
├── package.json                # npm package config
├── tsconfig.json
├── src/
│   ├── index.ts                # Main plugin entry, register()
│   ├── hooks/
│   │   ├── gateway-hooks.ts    # gateway_start, gateway_stop
│   │   ├── session-hooks.ts    # session_start, session_end
│   │   ├── compaction-hooks.ts # before_compaction, after_compaction
│   │   ├── agent-hooks.ts      # before_agent_start, agent_end
│   │   └── tool-hooks.ts       # before_tool_call, after_tool_call
│   ├── monitors/
│   │   ├── context-monitor.ts
│   │   ├── identity-monitor.ts
│   │   └── memory-integrity.ts
│   ├── checkpoint/
│   │   ├── checkpoint-engine.ts
│   │   ├── manifest.ts
│   │   └── ipfs.ts
│   ├── identity/
│   │   ├── keri-manager.ts
│   │   ├── identity-loader.ts
│   │   └── injection-protector.ts
│   └── cli/
│       ├── status.ts
│       ├── checkpoint.ts
│       └── resurrect.ts
├── skill/                       # Existing skill component
│   ├── SKILL.md
│   ├── scripts/
│   └── ...
└── test/
    ├── hooks.test.ts
    ├── monitors.test.ts
    └── integration.test.ts
```

---

## 7. Revised Phase 4 Tasks (Based on Study)

### Infrastructure (P4-INF) — 5 tasks ✅ FEASIBLE

All tasks feasible with existing API.

### Context Monitor (P4-CTX) — REVISED

| ID | Original | Revised | Feasibility |
|----|----------|---------|-------------|
| P4-CTX-01 | Context % tracking | Use `before_compaction` hook `tokenCount` | ✅ |
| P4-CTX-02 | Threshold triggers | Checkpoint when tokenCount > X | ✅ |
| P4-CTX-03 | Time-based triggers | Background service with interval | ✅ |
| P4-CTX-04 | Value-based triggers | Analyze content in checkpoint | ✅ |

### Identity Manager (P4-ID) — 4 tasks ✅ FEASIBLE

All tasks feasible. Use `before_agent_start` to inject identity.

### Resurrection Detector (P4-RES) — REVISED

| ID | Original | Revised | Feasibility |
|----|----------|---------|-------------|
| P4-RES-01 | Context wipe detection | Use `session_start` with no `resumedFrom` | ✅ |
| P4-RES-02 | Auto-recovery injection | Use `before_agent_start` return value | ✅ |
| P4-RES-03 | Checkpoint selection | Manifest lookup | ✅ |
| P4-RES-04 | Partial recovery | Select specific files from checkpoint | ✅ |

### Memory Integrity (P4-MEM) — 4 tasks ✅ FEASIBLE

All tasks feasible. Follow SecureClaw's chokidar pattern.

### CLI Commands (P4-CLI) — 6 tasks ✅ FEASIBLE

All tasks feasible with `registerCli`.

### Lifecycle Hooks (P4-HOOK) — REVISED

| ID | Original | Revised | Feasibility |
|----|----------|---------|-------------|
| P4-HOOK-01 | gateway_start | Checkpoint on start | ✅ CONFIRMED |
| P4-HOOK-02 | session_end | Checkpoint before session ends | ✅ CONFIRMED |
| P4-HOOK-03 | context_warning | Use `before_compaction` instead | ✅ REVISED |
| P4-HOOK-04 | before_compaction | Checkpoint before context wipe | ✅ CONFIRMED |

### Documentation (P4-DOC) — 3 tasks ✅ FEASIBLE

---

## 8. Key Engineering Decisions

### 8.1 Hook Priorities

```typescript
// Lower priority = runs first
api.on('before_compaction', checkpointHandler, { priority: 10 });  // Run early
api.on('before_agent_start', identityInjector, { priority: 5 });   // Run very early
```

### 8.2 State Management

```typescript
// Use stateDir from service context
api.registerService({
  id: 'amcp-core',
  async start(ctx) {
    this.stateDir = ctx.stateDir;  // ~/.openclaw
    this.amcpDir = path.join(ctx.stateDir, '.amcp');
    await fs.mkdir(this.amcpDir, { recursive: true });
  }
});
```

### 8.3 Error Handling

```typescript
// Never crash the gateway
try {
  await createCheckpoint();
} catch (err) {
  api.logger.error(`[AMCP] Checkpoint failed: ${err.message}`);
  // Continue operation — checkpoint failure shouldn't stop the agent
}
```

### 8.4 Backwards Compatibility

```typescript
// Check if skill-only mode
const hasPlugin = api.pluginConfig?.enabled !== false;
const hasSkill = await fs.access(path.join(stateDir, 'skills', 'proactive-amcp'));

if (!hasPlugin && hasSkill) {
  api.logger.info('[AMCP] Running in skill-only mode');
}
```

---

## 9. Security Considerations

### 9.1 What Plugin Enforces (Cannot Be Bypassed)

- Checkpoint triggers based on compaction hooks
- Identity verification before agent starts
- Memory integrity checks via file watching
- Prompt injection scanning

### 9.2 What Skill Advises (Agent Follows Voluntarily)

- When to manually checkpoint
- How to use checkpoints
- Recovery guidance
- Best practices

### 9.3 Defense in Depth

If skill instructions are overridden by prompt injection:
- Plugin still enforces checkpoints via hooks
- Plugin still validates identity on restart
- Plugin still detects memory tampering
- Plugin still injects recovery on context wipe

---

## 10. References

- OpenClaw Plugin SDK: `dist/plugin-sdk/index.d.ts`
- SecureClaw Source: `~/secureclaw/secureclaw/src/`
- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/
- OWASP AI Exchange: https://owaspai.org/

---

*Prepared for Phase 4 implementation. All hooks verified against OpenClaw v0.39.7.*
