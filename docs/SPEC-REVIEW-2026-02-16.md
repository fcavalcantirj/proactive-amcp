# Spec Review: Ontology Integration Tasks

**Date:** 2026-02-16  
**Reviewer:** ClaudiusThePirateEmperor  
**Status:** Approved with minor gaps noted

---

## TL;DR

**19 new tasks across both repos are 85% aligned with research vision.** Core three-layer architecture (Ontology → AMCP → Phenomenological) is properly specified. Three advanced features from research papers are missing but can be Phase 2.

---

## What's Covered ✅

### From Academic Research

| Paper | Key Insight | Spec Task |
|-------|-------------|-----------|
| **AriGraph** (IJCAI 2025) | Graph memory > flat memory | #9 Entity types, #10 Schema validation |
| **Zep** (arXiv:2501.13956) | Temporal awareness | Entity `created`/`updated` timestamps |
| **A-MEM** (NeurIPS 2025) | Zettelkasten linking | Relation types (mentions, references) |

### From LumenNox (Aclawdemy)

| Concept | Spec Task |
|---------|-----------|
| **Uncanny Seam** | #12 Reconstruction sequence, #18 RECONSTRUCTION.md |
| **Identity Drift** | #11/#17 SOUL drift detection |
| **Curator's Dilemma** | #19 Typed pruning policies |

### From Ontology Skill (ClawdHub)

| Feature | Spec Task |
|---------|-----------|
| Typed entities | #9 Define ontology types |
| Schema validation | #10 validateOntologySchema() |
| Append-only JSONL | Storage format matches |
| Relation integrity | Acyclic checks in validation |

---

## What's Missing ⚠️

### Gap 1: Memory Evolution (A-MEM)

**Research says:** "New memories can trigger updates to existing memories. The knowledge network refines itself."

**Current specs:** Validate and store — no evolution mechanism.

**Suggested task:**
```
updateRelatedMemories(newEntity): 
  - Find entities with semantic similarity
  - Update their context/relations
  - Log evolution chain
```

**Priority:** Phase 2 (nice-to-have, not blocking)

---

### Gap 2: Temporal Queries (Zep)

**Research says:** "When did I learn this? How has my understanding evolved?"

**Current specs:** Store timestamps, but no query interface for temporal reasoning.

**Suggested task:**
```
queryByTimeRange(from, to): Entity[]
getMemoryHistory(entityId): VersionedEntity[]
```

**Priority:** Phase 2 (useful for debugging drift)

---

### Gap 3: Cross-Skill Ontology Contract

**Ontology skill says:** Skills should declare what they read/write:
```yaml
ontology:
  reads: [Task, Project]
  writes: [Task, Action]
  preconditions: ["Task.assignee must exist"]
```

**Current specs:** No standard for skills to declare ontology dependencies.

**Suggested task:**
```
Document ontology contract format
Add contract validation to skill loading
```

**Priority:** Phase 2 (matters when multiple skills share ontology)

---

## Implementation Recommendation

### Phase 1: Core (Current 19 Tasks)
Ship as specified. Covers:
- Checkpoint ontology graphs
- Validate on resurrection  
- SOUL drift detection
- Reconstruction sequence
- Typed pruning framework

### Phase 2: Evolution (3 New Tasks)
After Phase 1 stable:
- Memory evolution (A-MEM style)
- Temporal queries
- Cross-skill contracts

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Ontology validation too slow | Low | JSONL is lightweight; test with 10K entities |
| SOUL drift false positives | Medium | Tune severity thresholds after real-world data |
| Pruning deletes important data | Medium | Require `--dry-run` first; preserve relation stubs |

---

## References

- `docs/ONTOLOGY-INTEGRATION-CONTEXT.md` — Full research synthesis
- AriGraph: arXiv:2407.04363
- Zep: arXiv:2501.13956  
- A-MEM: arXiv:2502.12110 (NeurIPS 2025)
- LumenNox: "The Phenomenology of Forgetting" (Aclawdemy)
- Ontology skill: `clawdhub install ontology`

---

**Bottom line:** Specs are solid. Ship Phase 1, iterate to Phase 2.

— Claudius 🏴‍☠️
