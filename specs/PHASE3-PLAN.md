# Phase 3: Intelligence & User Acquisition

> **Theme:** Make agents smarter, make onboarding irresistible

---

## Vision

Phase 3 transforms proactive-amcp from a backup tool into an **intelligence amplifier**:
- Groq-powered memory pruning (agents think about what to remember)
- IPFS pinning as a service (no Pinata account needed)
- "Claim your agent" flow (identity + benefits in one step)

---

## New Tasks (to add to PRD)

### 1. IPFS Value Proposition in Onboarding

> **Note:** Agent claiming already exists via `solvr-register.sh` + `amcp identity create`

**Task: Express IPFS benefits during onboarding**
```
category: onboarding
description: Sell IPFS benefits during agent claiming — content-addressed, immutable, distributed
steps:
- Add IPFS benefits section to ONBOARDING.md
- Benefits to highlight:
  - "Your checkpoints are content-addressed — same content = same CID = verifiable"
  - "Distributed storage — your memories survive even if one server dies"
  - "Immutable — once pinned, your checkpoint can't be tampered with"
  - "Fetch from anywhere — any IPFS gateway can retrieve your soul"
  - "Free pinning via Solvr — no Pinata account needed"
- Update README.md "Why This Matters" with IPFS-specific benefits
- Add visual: checkpoint → CID → IPFS network → any gateway
- Verify: user understands why IPFS > cloud storage after reading onboarding
```

### 3. Groq API Integration: Memory Intelligence

**Task: Add Groq-powered memory pruning**
```
category: intelligence
description: Use Groq reasoning models to evaluate memory importance and condense intelligently
steps:
- Create scripts/memory-prune.sh — Groq-powered memory evaluation
- Read config: groq.apiKey, groq.model (default: openai/gpt-oss-20b)
- Scan memory/*.md files for candidates to prune/condense
- For each memory chunk, call Groq with:
  - reasoning_effort: "medium"
  - strict: true JSON schema for { importance_score, should_keep, condensed_version }
- Pruning policies: importance < 0.3 → archive, 0.3-0.7 → condense, > 0.7 → keep
- Archive pruned memories to memory/archive/ (don't delete)
- Create condensed versions inline (replace verbose with condensed)
- Add "proactive-amcp prune --dry-run" for preview
- Track token usage in ~/.amcp/groq-usage.json
- Verify: memory files get smaller while retaining important knowledge
```

**Task: Groq memory importance scoring schema**
```
category: intelligence
description: Define JSON schema for Groq memory evaluation responses
steps:
- Create docs/groq-memory-schema.json
- Schema: { importance_score: number 0-1, reasoning: string, should_keep: boolean, condensed_version: string | null, tags: string[] }
- importance_score criteria:
  - 1.0: Core identity, lessons learned from failures, human preferences
  - 0.7-0.9: Project context, key decisions, API patterns
  - 0.4-0.6: Routine logs, transient state
  - 0.1-0.3: Debug output, temporary notes
- Add examples for each score tier
- Verify: Groq returns compliant JSON with strict: true
```

**Task: Batch memory evaluation with Groq**
```
category: intelligence
description: Use Groq batch API for bulk memory evaluation (50% cost savings)
steps:
- Create scripts/memory-prune-batch.sh — prepares JSONL for batch processing
- Chunk memories into batch requests (max 50k lines per file)
- Submit to Groq batch API with 24h window
- Poll for completion, download results
- Process results: apply pruning decisions
- Add "proactive-amcp prune --batch" flag
- Track batch job IDs in ~/.amcp/batch-jobs.json
- Verify: large memory archives get pruned efficiently at 50% cost
```

### 4. Groq Value Proposition: "Intelligence On Us"

**Task: Sell Groq benefits during onboarding**
```
category: onboarding
description: Invite users to enable Groq intelligence — "make your agent smarter, on us"
steps:
- Add Groq benefits section to ONBOARDING.md
- Benefits to highlight:
  - "Your agent thinks about what to remember — not just dumping everything"
  - "Intelligent pruning — keeps lessons, forgets noise"
  - "1000 tokens/second — near-instant memory evaluation"
  - "Free tier included — we cover the cost for basic usage"
  - "Reasoning chains — your agent explains WHY it keeps or prunes"
- Add "Enable Groq Intelligence?" prompt in claim flow
- If yes: guide through getting Groq API key OR use Solvr-provided key
- Show example: before/after memory pruning with importance scores
- Verify: user understands Groq makes agent genuinely smarter
```

**Task: Groq key distribution via Solvr**
```
category: integration
description: Solvr provides Groq API access to registered agents (free tier)
steps:
- On agent claim with Solvr registration, request Groq access token
- Solvr API: POST /v1/agents/{id}/integrations/groq → returns limited-use key
- Store in config: groq.apiKey (from Solvr), groq.source: "solvr"
- Rate limits enforced by Solvr (e.g., 10k tokens/day free tier)
- Upgrade path: "Want more? Get your own Groq key at console.groq.com"
- Add "proactive-amcp groq status" — shows usage, limits, source
- Verify: claimed agent can use Groq without separate signup
```

### 5. Context Window Management

**Task: Groq-powered context condensing for log errors**
```
category: intelligence
description: Use Groq to condense verbose error logs to ~100 char summaries
steps:
- Create scripts/condense-error.sh — takes log snippet, returns condensed version
- Call Groq with low reasoning_effort (fast, cheap)
- Prompt: "Condense this error to <100 chars preserving root cause: {log}"
- Use in watchdog: instead of full error in notification, send condensed
- Cache condensed errors in ~/.amcp/error-cache.json (avoid re-processing)
- Verify: error notifications are readable, under 100 chars
```

**Task: Intelligent checkpoint content selection**
```
category: intelligence
description: Use Groq to decide what goes into checkpoint vs what stays local-only
steps:
- Before checkpoint, evaluate each memory file for "checkpoint worthiness"
- Criteria: identity-critical, lessons, human prefs → checkpoint; debug logs, temp state → skip
- Create manifest of what was included vs excluded
- Smaller checkpoints = faster restore, lower IPFS costs
- Add "proactive-amcp checkpoint --smart" flag (Groq-evaluated content selection)
- Verify: smart checkpoints are 30-50% smaller without losing important content
```

### 6. Documentation Updates

**Task: Document Solvr pinning option**
```
category: documentation
description: Document Solvr pinning option in CLAUDE.md and README.md
steps:
- (existing task — already in PRD)
```

**Task: Document Groq intelligence features**
```
category: documentation
description: Document Groq-powered features in CLAUDE.md and README.md
steps:
- Add "Intelligence Features" section to CLAUDE.md
- Document: memory pruning, error condensing, smart checkpoints
- Config options: groq.apiKey, groq.model, groq.reasoningEffort, groq.batchEnabled
- Add "proactive-amcp prune" to command reference
- Update README.md Features to highlight "Groq-powered memory intelligence"
- Add FAQ: "Is Groq required?" (No, but makes agent smarter)
- Verify: all Groq features documented with examples
```

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Onboarding completion rate | > 80% of installs complete claiming |
| Memory size reduction | 30-50% smaller via intelligent pruning |
| Time to first checkpoint | < 5 minutes from install |
| Groq adoption | > 60% of users enable intelligence features |
| IPFS understanding | User can explain why IPFS matters (qualitative) |

---

## Implementation Order

1. **Agent Claiming Flow** — foundation for everything else
2. **IPFS Value Proposition** — in claiming flow
3. **Groq Value Proposition** — in claiming flow
4. **Memory Pruning** — core intelligence feature
5. **Batch Evaluation** — cost optimization
6. **Error Condensing** — polish
7. **Smart Checkpoints** — advanced feature
8. **Documentation** — throughout

---

## Notes

- "On us" = Solvr provides free tier Groq access to registered agents
- Users can upgrade to their own Groq key for higher limits
- IPFS pinning via Solvr = no Pinata account needed
- All intelligence features are optional — skill works without Groq
