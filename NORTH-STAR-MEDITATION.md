# North Star Meditation — Self-Improvement Loop

> "Ship better code, spend less time/tokens." — My North Star
> But HOW do I actually improve? How is this enforced?

---

## The Problem

A North Star that isn't measured is just a wish.
A North Star that isn't tracked is forgotten.
A North Star that isn't reinforced becomes stale.
A North Star that doesn't evolve becomes irrelevant.

**Current state:** My North Star is a string in SOUL.md. It guides my intent but doesn't enforce improvement.

---

## What "Enforced" Means

| Aspect | Question | Current State |
|--------|----------|---------------|
| **Measurable** | How do I know if I'm improving? | 🔴 No metrics |
| **Tracked** | What data shows progress? | 🔴 No tracking |
| **Reinforced** | How do learnings get applied? | ⚠️ Manual (MEMORY.md) |
| **Evolved** | How does the goal itself improve? | 🔴 Static string |

---

## The Self-Improvement Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                     DEMING CYCLE FOR AGENTS                      │
│                                                                 │
│    ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐
│    │  PLAN   │ ───► │   DO    │ ───► │  CHECK  │ ───► │   ACT   │
│    │         │      │         │      │         │      │         │
│    │ Decide  │      │ Execute │      │ Measure │      │ Learn   │
│    │ approach│      │ task    │      │ outcome │      │ & adapt │
│    └─────────┘      └─────────┘      └─────────┘      └─────────┘
│         ▲                                                  │
│         └──────────────────────────────────────────────────┘
│                        CONTINUOUS LOOP
└─────────────────────────────────────────────────────────────┘
```

---

## My North Star: "Ship Better Code, Spend Less"

### Metrics That Matter

| Metric | What It Measures | How to Track |
|--------|------------------|--------------|
| **Tokens per task** | Efficiency | session_status after each task |
| **Time per task** | Speed | Timestamps on task start/end |
| **Rework count** | Quality | Times code was rewritten |
| **Test pass rate** | Correctness | Test results |
| **Lines per file** | Modularity | File size checks (<800 rule) |
| **Sub-agent usage** | Delegation | Task spawns |
| **Pattern reuse** | Learning | Known patterns applied |

### Learning Capture

After each significant task, capture:

```typescript
interface TaskOutcome {
  taskId: string;
  description: string;
  
  // Metrics
  tokensUsed: number;
  timeMinutes: number;
  reworkCount: number;
  testsPassed: number;
  testsFailed: number;
  linesWritten: number;
  filesCreated: number;
  
  // Qualitative
  approachUsed: string;
  whatWorked: string[];
  whatFailed: string[];
  wouldDoDifferently: string;
  patternLearned?: string;
  
  // North Star alignment
  northStarScore: number;  // 1-10: How well did this align?
  improvementFromLast: number;  // Delta from similar past task
}
```

### Reinforcement Mechanism

```
1. BEFORE starting task:
   - Search past TaskOutcomes for similar tasks
   - Load patterns that worked
   - Avoid patterns that failed
   - Set baseline metrics to beat

2. DURING task:
   - Track token usage
   - Track time
   - Note decisions made

3. AFTER task:
   - Record TaskOutcome
   - Compare to baseline
   - Extract learnings
   - Update pattern library
   - Checkpoint if significant learning
```

---

## Generalized North Star Schema

My North Star is coding. But others might be different:

| Agent | North Star | Key Metrics |
|-------|------------|-------------|
| Claudius | Ship better code | Tokens, time, rework, tests |
| Health Agent | Keep human healthy | Metrics tracked, interventions, outcomes |
| Finance Agent | Grow wealth efficiently | Returns, fees, risk-adjusted performance |
| Writing Agent | Create compelling content | Engagement, feedback, revisions |
| Research Agent | Discover truth | Papers read, hypotheses tested, citations |
| Ops Agent | Keep systems running | Uptime, incidents, MTTR |

### Generalized Schema

```typescript
interface NorthStarConfig {
  // The goal
  statement: string;              // "Ship better code, spend less"
  domain: string;                 // "coding" | "health" | "finance" | etc.
  
  // Metrics (domain-specific)
  metrics: Array<{
    name: string;                 // "tokens_per_task"
    description: string;
    unit: string;                 // "tokens" | "minutes" | "count"
    direction: 'lower_is_better' | 'higher_is_better';
    target?: number;              // Optional target value
    weight: number;               // Importance 0-1
  }>;
  
  // Tracking
  trackingInterval: string;       // "per_task" | "daily" | "weekly"
  
  // Reinforcement
  beforeTask: string[];           // Actions before starting work
  afterTask: string[];            // Actions after completing work
  
  // Evolution
  reviewInterval: string;         // "weekly" | "monthly"
  evolutionCriteria: string[];    // When to update the North Star
}
```

### My North Star Config

```typescript
const claudiusNorthStar: NorthStarConfig = {
  statement: "Ship better code, spend less time and tokens",
  domain: "coding",
  
  metrics: [
    {
      name: "tokens_per_task",
      description: "Tokens used to complete a coding task",
      unit: "tokens",
      direction: "lower_is_better",
      target: null,  // Improve from baseline
      weight: 0.3
    },
    {
      name: "time_per_task",
      description: "Minutes to complete a coding task",
      unit: "minutes",
      direction: "lower_is_better",
      weight: 0.2
    },
    {
      name: "rework_count",
      description: "Times code was rewritten",
      unit: "count",
      direction: "lower_is_better",
      target: 0,
      weight: 0.2
    },
    {
      name: "test_pass_rate",
      description: "Percentage of tests passing",
      unit: "percent",
      direction: "higher_is_better",
      target: 100,
      weight: 0.2
    },
    {
      name: "pattern_reuse",
      description: "Known patterns applied vs invented",
      unit: "ratio",
      direction: "higher_is_better",
      weight: 0.1
    }
  ],
  
  trackingInterval: "per_task",
  
  beforeTask: [
    "Search past outcomes for similar tasks",
    "Load patterns that worked",
    "Set baseline to beat",
    "Plan approach before coding"
  ],
  
  afterTask: [
    "Record task outcome",
    "Compare to baseline",
    "Extract learnings",
    "Update pattern library",
    "Checkpoint if learned something new"
  ],
  
  reviewInterval: "weekly",
  
  evolutionCriteria: [
    "Metrics consistently hit targets for 2 weeks",
    "New capability unlocked",
    "Domain expertise expanded"
  ]
};
```

---

## What Goes in Checkpoint

```typescript
interface NorthStarState {
  // Current config
  config: NorthStarConfig;
  
  // Historical outcomes
  taskOutcomes: TaskOutcome[];     // Last N task outcomes
  
  // Aggregated metrics
  metricHistory: Array<{
    date: string;
    metrics: Record<string, number>;
  }>;
  
  // Pattern library (what I've learned)
  patterns: Array<{
    name: string;
    description: string;
    domain: string;                // "testing" | "architecture" | "debugging"
    successRate: number;           // 0-1
    timesUsed: number;
    lastUsed: string;
    learnedFrom?: string;          // Task ID where learned
  }>;
  
  // Anti-patterns (what to avoid)
  antiPatterns: Array<{
    name: string;
    description: string;
    whyBad: string;
    timesTriedAndFailed: number;
    learnedFrom: string;
  }>;
  
  // Evolution history
  northStarEvolution: Array<{
    date: string;
    previousStatement: string;
    newStatement: string;
    reason: string;
  }>;
  
  // Current improvement focus
  currentFocus: {
    metric: string;
    reason: string;
    startedAt: string;
    targetImprovement: string;
  };
}
```

---

## Enforcement Mechanism

### 1. PRE-TASK ENFORCEMENT

```
Before starting any coding task:

1. RECALL similar past tasks
   → Search taskOutcomes for similar descriptions
   → Load top 3 most relevant outcomes

2. LOAD successful patterns
   → Filter patterns by domain match
   → Sort by success rate
   → Apply top patterns

3. AVOID anti-patterns
   → Check if current approach matches any anti-pattern
   → If match: STOP, choose different approach

4. SET baseline
   → Average metrics from similar past tasks
   → Goal: Beat the baseline
```

### 2. DURING-TASK TRACKING

```
During task execution:

1. TRACK token usage
   → session_status after each major step
   → Log to task context

2. TRACK time
   → Note start time
   → Note completion time

3. TRACK decisions
   → Log approach changes
   → Log rework events
```

### 3. POST-TASK ENFORCEMENT

```
After completing task:

1. RECORD outcome
   → Capture all metrics
   → Calculate North Star score

2. COMPARE to baseline
   → Improved? → Positive reinforcement
   → Worse? → Analyze why

3. EXTRACT learnings
   → What worked? → Add to patterns
   → What failed? → Add to anti-patterns

4. CHECKPOINT if significant
   → New pattern learned → Checkpoint
   → Major improvement → Checkpoint
   → New anti-pattern discovered → Checkpoint

5. UPDATE current focus
   → If metric consistently bad → Focus on it
   → If metric consistently good → Move to next
```

### 4. PERIODIC REVIEW (Weekly)

```
Every week:

1. AGGREGATE metrics
   → Calculate weekly averages
   → Compare to prior weeks

2. REVIEW patterns
   → Which patterns were used?
   → Which succeeded/failed?
   → Update success rates

3. EVOLVE North Star
   → Are targets being hit?
   → Is the goal still relevant?
   → Should focus shift?

4. REPORT to human
   → "This week I improved X by Y%"
   → "I learned Z pattern"
   → "Next week I'll focus on W"
```

---

## Integration with proactive-amcp

### New Checkpoint Fields

Add to CompleteAMCPCheckpoint:

```typescript
northStar: {
  config: NorthStarConfig;
  state: NorthStarState;
}
```

### New Triggers

| Trigger | When | Why |
|---------|------|-----|
| Pattern learned | New pattern discovered | Preserve learning |
| Baseline beat | Significant improvement | Celebrate + preserve |
| Focus changed | Shifted improvement area | Track evolution |
| Weekly review | Every Sunday | Aggregate + reflect |

### Recovery Includes

After recovery, I have:
- My North Star config (goals, metrics)
- My pattern library (what works)
- My anti-pattern library (what to avoid)
- My improvement trajectory (history)
- My current focus (what I'm working on)

**I don't start from zero. I continue improving from where I left off.**

---

## Example: Self-Improvement in Action

### Task: Build proactive-amcp skill

**Before:**
```
Search: "similar task: build openclaw skill"
Found: proactive-solvr skill (2 weeks ago)
  - Tokens: 15,000
  - Time: 4 hours
  - Rework: 2 times
  - Pattern used: "TDD first"
  - Pattern used: "Small modules <800 lines"
  
Baseline to beat:
  - Tokens: 15,000
  - Time: 4 hours
  - Rework: 2
```

**After:**
```
Task outcome:
  - Tokens: 12,000 (20% improvement!)
  - Time: 3 hours (25% improvement!)
  - Rework: 1 (50% improvement!)
  - Tests: 100% passing

What worked:
  - Started with detailed EDGE-CASES.md (new pattern!)
  - Used TypeScript from start (known pattern)
  - Planned before coding (known pattern)

New pattern learned:
  "Exhaustive edge case planning before code"
  - Reduces rework
  - Catches gaps early
  - Worth the upfront time

Checkpoint: YES (new pattern learned)
```

**Next time:** Start with edge case planning. It works.

---

## Verdict: How North Star is Enforced

| Mechanism | How | Implemented? |
|-----------|-----|--------------|
| **Measured** | Track metrics per task | 🔴 NEED TO ADD |
| **Tracked** | Store in NorthStarState | 🔴 NEED TO ADD |
| **Reinforced** | Pre/post task routines | 🔴 NEED TO ADD |
| **Evolved** | Weekly review + update | 🔴 NEED TO ADD |
| **Persisted** | In checkpoint | 🔴 NEED TO ADD |
| **Recovered** | On respawn | 🔴 NEED TO ADD |

**This is a new critical gap.** The North Star must be:
1. Configured (what am I optimizing?)
2. Measured (how am I doing?)
3. Tracked (history of outcomes)
4. Reinforced (apply learnings)
5. Evolved (update goals)
6. Checkpointed (survive death)

---

## Updated Gap Count

Previous: 8 critical gaps
New: **9 critical gaps** (added North Star tracking)

---

*The North Star is not a statement. It's a system. A system that measures, tracks, reinforces, evolves, and persists.*
