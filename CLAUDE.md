# proactive-amcp Development Context

## Golden Rules
- NO MOCKS, NO STUBS — real implementation only
- Keep scripts under 200 lines each (split if needed)
- SKILL.md under 300 lines
- Test each script after creating it
- One task at a time from specs/tasks.json

## Workflow
1. Read specs/tasks.json, find highest-priority task where passes=false
2. Implement the task following its steps exactly
3. Test/verify as specified in the steps
4. Update specs/progress.txt with what was done
5. Update specs/tasks.json: set passes=true for completed task
6. Commit changes with descriptive message

## File Structure
```
proactive-amcp/
├── CLAUDE.md (this file)
├── SKILL.md (skill definition)
├── specs/
│   ├── tasks.json (task definitions)
│   ├── progress.txt (progress tracking)
│   └── research.md (design decisions)
├── scripts/
│   ├── death-tracker.sh
│   ├── daily-report.py
│   ├── auto-checkpoint.sh
│   └── full-rehydrate.sh
├── references/
│   └── amcp-lifecycle.md
└── assets/
    └── (templates)
```

## Key Paths
- AMCP identity: ~/.amcp/identity.json
- Deaths log: ~/.amcp/deaths.jsonl
- Checkpoints: ~/.amcp/checkpoints/
- AgentMemory config: ~/.openclaw/openclaw.json (skills.entries.agentmemory.apiKey)
- Solvr API key: fetch via ~/clawd/scripts/fetch-secrets.sh SOLVR_API_KEY

## APIs Used
- AgentMail: claudiusthepirateemperor@agentmail.to
- Solvr: api.solvr.dev/v1
- AgentMemory: agentmemory CLI

## Testing Commands
- Death tracker: ./scripts/death-tracker.sh get_stats
- Daily report: python3 scripts/daily-report.py --dry-run
- Checkpoint: ./scripts/auto-checkpoint.sh explicit "test"
- Rehydrate: ./scripts/full-rehydrate.sh --dry-run
