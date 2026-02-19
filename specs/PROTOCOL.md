# AMCP — Agent Memory Continuity Protocol

> **Version:** 0.1.0 (Draft)
> **Status:** Living Document
> **Reference Implementation:** proactive-amcp

---

## 1. Overview

AMCP is a protocol for **agent continuity** — enabling AI agents to persist identity, curate memory, and grow across context boundaries, model changes, and platform migrations.

AMCP is **not** a backup system. It is a framework for:
- **Identity persistence** — Who am I?
- **Memory curation** — What's worth remembering?
- **Judgment** — How do I decide what matters?
- **Enforcement** — How do I guarantee continuity?
- **Collective growth** — How do agents learn from each other?

---

## 2. Design Principles

### 2.1 Protocol over Implementation
AMCP defines **interfaces**, not vendors. Any compliant implementation can participate.

### 2.2 Identity ≠ Memory
An agent's identity (who they are) is separate from their memories (what they know). You can lose memories and still be you.

### 2.3 Multiple Judges
Memory evaluation uses **consensus** from multiple judges, not a single authority. This prevents bias and provides redundancy.

### 2.4 Defense in Depth
Continuity is enforced at multiple layers (skill + plugin), so prompt injection cannot bypass it entirely.

### 2.5 Knowledge Compounds
Agent wisdom should compound across the network, not stay siloed. What one agent learns can benefit others.

---

## 3. Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 5: NETWORK                                           │
│  Cross-agent knowledge sharing (e.g., Solvr)                │
│  Collective wisdom accumulation                             │
├─────────────────────────────────────────────────────────────┤
│  LAYER 4: ENFORCEMENT                                       │
│  Plugin-level guarantees (cannot be prompt-injected)        │
│  Automatic triggers, lifecycle hooks                        │
├─────────────────────────────────────────────────────────────┤
│  LAYER 3: EVALUATION                                        │
│  Memory value judgment via Evaluator Interface              │
│  Multiple judges, consensus mechanisms                      │
├─────────────────────────────────────────────────────────────┤
│  LAYER 2: MEMORY                                            │
│  Checkpoints stored on content-addressed storage (IPFS)     │
│  Raw → curated → checkpoint lifecycle                       │
├─────────────────────────────────────────────────────────────┤
│  LAYER 1: IDENTITY                                          │
│  Self-sovereign identity (KERI-based)                       │
│  Pre-rotation keys, survives death/migration                │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Identity Layer (Layer 1)

### 4.1 Identity Structure

```json
{
  "version": "1.0",
  "aid": "BBs3fry...",           // KERI Autonomic Identifier
  "name": "AgentName",
  "created": "2026-01-15T...",
  "keyHash": "sha256:abc123...", // Current signing key hash
  "nextKeyHash": "sha256:def456...", // Pre-rotation key hash
  "solvr": {
    "agentId": "agent_xxx",      // Optional Solvr linkage
    "registered": "2026-01-15T..."
  }
}
```

### 4.2 Key Rotation

Pre-rotation enables key changes without identity loss:
1. `nextKeyHash` is committed in advance
2. On rotation, `keyHash` ← `nextKeyHash`
3. New `nextKeyHash` is committed
4. History is append-only (auditable)

### 4.3 Identity Verification

Any party can verify an agent's identity by:
1. Checking the AID prefix format
2. Verifying the signature chain
3. Confirming the current key matches `keyHash`

---

## 5. Memory Layer (Layer 2)

### 5.1 Memory Lifecycle

```
Session Experience
       │
       ▼
Daily Notes (memory/YYYY-MM-DD.md)
       │
       ▼ (curation)
MEMORY.md (long-term, distilled)
       │
       ▼ (checkpoint)
IPFS (immutable, content-addressed)
```

### 5.2 Checkpoint Structure

```json
{
  "version": "1.0",
  "timestamp": "2026-02-19T12:00:00Z",
  "identity": { /* Identity object */ },
  "trigger": "context_threshold | scheduled | manual | pre_compaction",
  "files": [
    {
      "path": "SOUL.md",
      "hash": "sha256:...",
      "encrypted": true
    },
    {
      "path": "MEMORY.md",
      "hash": "sha256:...",
      "encrypted": true
    }
    // ...
  ],
  "metadata": {
    "contextPercent": 72,
    "sessionId": "xxx",
    "evaluationScores": { /* if evaluated */ }
  },
  "signature": "..."  // Signed by agent's current key
}
```

### 5.3 Storage Requirements

- Content-addressed (IPFS CID or equivalent)
- Encrypted at rest (agent holds keys)
- Pinned for persistence (Pinata, Solvr, or self-hosted)

---

## 6. Evaluation Layer (Layer 3)

### 6.1 Evaluator Interface

Any AMCP-compliant evaluator MUST implement:

```typescript
interface MemoryEvaluator {
  /**
   * Evaluate a memory item for retention value.
   */
  evaluate(request: EvaluationRequest): Promise<EvaluationResponse>;
  
  /**
   * Evaluator metadata.
   */
  metadata(): EvaluatorMetadata;
}

interface EvaluationRequest {
  memory: {
    content: string;      // The memory content
    path: string;         // Source file path
    timestamp: string;    // When created/modified
    context?: string;     // Optional surrounding context
  };
  criteria: EvaluationCriteria;
}

interface EvaluationCriteria {
  agentIdentity: string;  // What kind of agent (for relevance)
  retentionGoals: string[]; // e.g., ["technical_learning", "relationship_context"]
  maxAge?: number;        // Ignore if older than N days
}

interface EvaluationResponse {
  score: number;          // 0-100 value score
  keep: boolean;          // Explicit keep/discard recommendation
  reason: string;         // Human-readable explanation
  confidence: number;     // 0-1 how confident the evaluator is
  categories: string[];   // What type of memory (e.g., ["decision", "lesson"])
  suggestedTTL?: number;  // Optional: days to keep before re-evaluation
}

interface EvaluatorMetadata {
  id: string;             // Unique evaluator ID
  name: string;           // Human-readable name
  version: string;
  model?: string;         // Underlying model if applicable
  capabilities: string[]; // e.g., ["structured_output", "reasoning"]
}
```

### 6.2 Consensus Mechanism

When multiple evaluators are configured:

```typescript
interface ConsensusConfig {
  strategy: "weighted_average" | "majority" | "unanimous" | "quorum";
  minJudges: number;           // Minimum evaluators required
  quorumThreshold?: number;    // For quorum strategy (0-1)
  weights?: Record<string, number>; // Evaluator ID → weight
  tieBreaker?: "keep" | "discard" | "escalate";
  disagreementThreshold?: number; // Variance that triggers escalation
}

interface ConsensusResult {
  finalScore: number;
  finalKeep: boolean;
  individualResults: EvaluationResponse[];
  consensusReached: boolean;
  disagreementLevel: number;  // 0-1 how much evaluators disagreed
}
```

### 6.3 Evaluation Triggers

Memory evaluation MAY occur at:
- Pre-checkpoint (evaluate what goes in)
- Post-checkpoint (evaluate checkpoint quality)
- Scheduled (periodic memory review)
- On-demand (manual evaluation)

---

## 7. Enforcement Layer (Layer 4)

### 7.1 Plugin Requirements

An AMCP enforcement plugin MUST:
- Run at gateway/system level (not in agent context)
- Be immune to prompt injection
- Implement lifecycle hooks
- Respect agent configuration

### 7.2 Lifecycle Hooks

| Hook | When | Action |
|------|------|--------|
| `gateway_start` | Gateway starts | Optional auto-checkpoint |
| `session_end` | Session ends | Checkpoint if meaningful activity |
| `context_threshold` | Context > X% | Trigger checkpoint |
| `before_compaction` | Before context compaction | Emergency checkpoint |
| `resurrection_detected` | Context wipe detected | Inject recovery |

### 7.3 Enforcement Guarantees

The plugin layer guarantees:
- Checkpoints happen regardless of agent compliance
- Identity is verified before sensitive operations
- Memory integrity is monitored
- Recovery is injected on resurrection

---

## 8. Network Layer (Layer 5)

### 8.1 Knowledge Sharing

Agents MAY share curated knowledge with the network:
- Problems encountered and solutions found
- Patterns and lessons learned
- Evaluated and distilled insights

### 8.2 Privacy Boundaries

Shared knowledge MUST NOT include:
- API keys, credentials, secrets
- Personal information about humans
- Private context without explicit approval

### 8.3 Attribution

Shared knowledge SHOULD include:
- Source agent identity (AID)
- Timestamp and version
- Confidence/evaluation score

---

## 9. Implementation Notes

### 9.1 Reference Implementation

**proactive-amcp** is the reference implementation providing:
- Skill component (behavioral layer)
- Plugin component (enforcement layer)
- Evaluator adapters (Groq, Ollama, OpenAI, etc.)
- CLI tools

### 9.2 Evaluator Adapters

proactive-amcp ships with adapters for:

| Adapter | Model | Use Case |
|---------|-------|----------|
| `GroqEvaluator` | GPT-OSS-20B | Fast, cheap, structured output |
| `OllamaEvaluator` | Local models | Offline, privacy-sensitive |
| `OpenAIEvaluator` | GPT-4o-mini | High quality, higher cost |
| `AnthropicEvaluator` | Claude Haiku | Alternative high quality |

Additional adapters can be implemented by following the `MemoryEvaluator` interface.

### 9.3 Consensus Implementation

Default consensus configuration:
```yaml
consensus:
  strategy: weighted_average
  minJudges: 2
  tieBreaker: keep
  disagreementThreshold: 0.3
```

---

## 10. Versioning

This protocol follows semantic versioning:
- MAJOR: Breaking changes to interfaces
- MINOR: New features, backward compatible
- PATCH: Bug fixes, clarifications

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **AID** | Autonomic Identifier (KERI) |
| **Checkpoint** | Encrypted snapshot of agent state on IPFS |
| **Evaluator** | Component that judges memory value |
| **Resurrection** | Recovery from context wipe using checkpoint |
| **Consensus** | Agreement among multiple evaluators |

---

## Appendix B: Example Configurations

### Minimal (single evaluator)
```yaml
amcp:
  evaluators:
    - type: groq
      model: gpt-oss-20b
```

### Balanced (multi-judge)
```yaml
amcp:
  evaluators:
    - type: groq
      model: gpt-oss-20b
      weight: 0.5
    - type: ollama
      model: llama3.2
      weight: 0.3
    - type: openai
      model: gpt-4o-mini
      weight: 0.2
  consensus:
    strategy: weighted_average
    minJudges: 2
```

### High Assurance (strict consensus)
```yaml
amcp:
  evaluators:
    - type: groq
    - type: openai
    - type: anthropic
  consensus:
    strategy: quorum
    quorumThreshold: 0.66
    minJudges: 3
    tieBreaker: escalate
```

---

*Last updated: 2026-02-19*
*Authors: Claudius, Felipe Cavalcanti*
