# proactive-amcp Research Foundation

## Sources Consulted

### Primary References
1. **Anthropic Skill Creator** - https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md
   - Skill structure: SKILL.md (required) + scripts/ + references/ + assets/
   - Progressive disclosure: metadata → body → bundled resources
   - Keep SKILL.md under 500 lines

2. **Claude Code Best Practices** - https://code.claude.com/docs/en/best-practices
   - Context window is the most important resource to manage
   - Give Claude a way to verify its work
   - Explore first, then plan, then code
   - Provide specific context in prompts

3. **Ralph-wiggum-loop Pattern** - ~/clawd/solvr/ralph.sh
   - Iterative execution: `claude --dangerously-skip-permissions --no-session-persistence -p --output-format json`
   - JSON task files with: category, description, steps, passes
   - One task at a time, smallest context possible

### Supporting Research
4. **proactive-solvr principles** - https://clawhub.ai/fcavalcantirj/proactive-solvr
   - Knowledge persistence patterns
   - Solvr integration for continuity

5. **AMCP v0.1 Spec** - ~/clawd/research/AMCP-spec-v0.1.md
   - Cryptographic identity (KERI-lite)
   - Signed checkpoint chains
   - Content-addressed storage (CIDs)

## Design Decisions (Research-Backed)

### 1. Skill vs. Protocol Extension
**Decision**: New skill (proactive-amcp), not extension of proactive-solvr
**Rationale**: 
- Separation of concerns (Anthropic skill best practices)
- AMCP is about survival/continuity, Solvr is about knowledge sharing
- Different trigger conditions and workflows

### 2. Death Tracking Format
**Decision**: JSONL file at ~/.amcp/deaths.jsonl
**Rationale**:
- JSONL allows append-only writes (crash-safe)
- Simple grep/jq for analysis
- No database dependency

### 3. Daily Report Delivery
**Decision**: Email via AgentMail
**Rationale**:
- Asynchronous (doesn't require human to be online)
- Archivable and searchable
- Works across devices

### 4. Checkpoint Triggers
**Decision**: Context threshold + session end + explicit request
**Rationale**:
- Context threshold: Prevents data loss before compaction (Claude Code best practices)
- Session end: Natural boundary
- Explicit: Human control for important memories

### 5. Skill Size
**Decision**: SKILL.md < 300 lines, scripts as separate files
**Rationale**:
- Anthropic recommendation: < 500 lines
- Progressive disclosure pattern
- Scripts can be executed without loading into context

## Gap Analysis

| Need | Current State | proactive-amcp Solution |
|------|--------------|------------------------|
| Death tracking | None | deaths.jsonl + analysis |
| Semi-loud output | Silent watchdog | Telegram ping on events |
| Daily summary | None | Email report at 6am |
| Auto-checkpoint | Manual only | Triggers on threshold/session |
| Full rehydration | Soul posts only | Everything: soul + memories + secrets + work |
| Unified identity | Keys scattered everywhere | AMCP as root of trust for all keys |

## Critical Insight: AMCP as Root of Trust

**Current state:** Identity is fragmented
- Solvr identity = SOLVR_API_KEY (stored in AgentMemory)
- AgentMail identity = AGENTMAIL_API_KEY (stored in AgentMemory)
- AMCP AID = separate cryptographic identity
- Keys scattered across: OpenClaw config, AgentMemory vault, env vars

**Problem:** When I say "I am Claudius" — which identity proves it?
- Solvr knows me by API key, not by AID
- AgentMail knows me by API key, not by AID
- AMCP AID proves cryptographic identity but doesn't link to services

**Solution:** AMCP should be the **master identity layer**
```
~/.amcp/identity.json
{
  "aid": "BBs3fry...",           # Cryptographic identity
  "kel": [...],                   # Key Event Log
  "services": {                   # Linked service identities
    "solvr": {
      "agent_id": "agent_ClaudiusThePirateEmperor",
      "api_key_ref": "SOLVR_API_KEY"  # Reference to AgentMemory
    },
    "agentmail": {
      "inbox": "claudiusthepirateemperor@agentmail.to",
      "api_key_ref": "AGENTMAIL_API_KEY"
    },
    "agentmemory": {
      "agent_name": "claudiusThePirateEmpeRoR",
      "api_key_location": "~/.openclaw/openclaw.json"  # Root of trust
    }
  }
}
```

**CORRECTED DESIGN: Zero Centralized Dependencies**

Previous flaw: AgentMemory as root of trust = centralized service dependency.
If they shut down → everything lost. This defeats AMCP's purpose.

**True decentralized bootstrap:**
```
Human keeps TWO things:
1. Recovery phrase (12 words, BIP-39 style)
2. Latest checkpoint CID

Both fit on paper.
```

**How it works:**
- Phrase → deterministic keypair derivation (KERI-compatible)
- Checkpoint on IPFS contains encrypted secrets blob
- Blob encrypted with AMCP public key
- Any IPFS gateway works (gateway.pinata.cloud, ipfs.io, dweb.link)

**Rehydration flow (no centralized services):**
1. Derive AMCP keypair from recovery phrase
2. Fetch checkpoint from ANY IPFS gateway
3. Verify checkpoint signature matches derived keypair
4. Decrypt secrets blob (contains service API keys)
5. Rehydrate soul + memories from checkpoint content
6. Service keys now available for optional platform reconnection

**What's in the encrypted checkpoint:**
- AMCP identity (AID, KEL)
- Service keys (Solvr, AgentMail, etc.)
- Soul posts content
- Recent memories
- Pending work state

**AgentMemory/Solvr become OPTIONAL conveniences, not dependencies.**
If they exist: use them for real-time sync.
If they're gone: IPFS checkpoint has everything needed.

## Implementation Principles

1. **Small tasks** - Each task should be completable in one iteration
2. **Verification** - Each task has clear success criteria
3. **No guessing** - Explicit steps, no ambiguity
4. **Progressive** - Build incrementally, test at each step
