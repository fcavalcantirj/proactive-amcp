# Learning System Roadmap

## MVP (Phase 1) — In prd-v1.json

| Task | Category | Description |
|------|----------|-------------|
| learning-storage | learning | Initialize Problem/Learning stores |
| problem-crud | learning | Problem entity operations |
| learning-crud | learning | Learning entity operations |
| command-prefix | learning | /remember, /stuck, /learned triggers |
| skill-triggers | learning | Natural language patterns |
| self-detect | learning | Auto-capture failure patterns |
| resurrection-hybrid | learning | Surface problems without auto-attempt |
| human-verification | learning | Require confirmation before trust |
| metrics-report | learning | Track self-improvement rate |
| integration-tests | testing | Full cycle tests |

**Protocol:** AMCP protocol-09-learning-schema.json defines entity schemas

---

## Phase 2 — Future Work

### Auto-Retry Logic (proactive-amcp)
**Not in MVP because:** Requires trust built through human verification first. Agent must prove it can track problems reliably before being trusted to retry autonomously.

**When to add:** After MVP is stable and human verification flow has 30+ verified learnings.

**Design notes:**
- Retry scheduler: after N successful tasks, pop one problem from queue
- Exponential backoff: 1h → 1d → 3d → 1w → give up
- Max attempts per problem: configurable (default: 5)
- Retry only during idle heartbeats, never interrupt active work
- Track retry success rate separately from first-attempt success

---

### Confidence Scoring (proactive-amcp)
**Not in MVP because:** Simple binary (tentative/verified) is sufficient for v1. Nuanced confidence scoring adds complexity without clear benefit until we have data.

**When to add:** After 100+ learnings, analyze patterns to inform scoring model.

**Design notes:**
- Confidence factors: human verification, time-tested (no recurrence), cross-referenced by other learnings
- Decay: confidence decreases if environment changes (new API version, etc.)
- Thresholds: high (>0.9) = use confidently, medium (0.6-0.9) = use with caveat, low (<0.6) = flag as uncertain

---

### Cross-Agent Learning via Solvr (amcp + proactive-amcp)
**Not in MVP because:** Requires Solvr API extensions and trust/reputation system for agent-contributed solutions.

**When to add:** After Solvr supports agent verification via AID.

**Design notes:**
- **AMCP protocol extension:** Define format for shareable Problem/Learning (redacted, generalized)
- **proactive-amcp implementation:**
  - On problem solved: check if generalizable, post to Solvr with AID signature
  - On problem encountered: search Solvr for solutions before attempting locally
  - Track provenance: "learned from agent X via Solvr"
- **Trust model:** Solutions from verified agents (valid AID) ranked higher
- **Privacy:** Never share problems containing PII, credentials, or user-specific context

---

### Problem Clustering (proactive-amcp)
**Not in MVP because:** Requires enough problems to see patterns.

**When to add:** After 50+ problems tracked.

**Design notes:**
- Cluster similar problems by keywords, error patterns, domain
- Surface: "You've had 5 problems with AgentMail API — consider reading docs"
- Identify systemic issues vs one-off failures

---

### Learning-Informed Prompting (proactive-amcp)
**Not in MVP because:** Complex integration with OpenClaw prompt construction.

**When to add:** After verified learnings are reliable.

**Design notes:**
- Inject relevant learnings into system prompt for related tasks
- Example: Task mentions "AgentMail" → inject verified learnings tagged "agentmail"
- Risk: prompt bloat. Need selective injection based on relevance.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-17 | MVP includes 3 trigger types | Brow: "all without overengineer" |
| 2026-02-17 | Human verification required first | Build trust before automation |
| 2026-02-17 | Hybrid resurrection (surface, don't auto-attempt) | Focus on learning, not aggressive retry |
| 2026-02-17 | Layer split: schema in AMCP, impl in proactive-amcp | Clean separation of protocol vs enforcer |
