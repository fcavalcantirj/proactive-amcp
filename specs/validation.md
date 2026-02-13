# Task Validation — proactive-amcp

## Vision Checklist

| Goal | Task Coverage | Gap? |
|------|--------------|------|
| Death tracking | ✅ Task 3 (death-tracker.sh) | - |
| Semi-loud output | ✅ Task 7 (integration with watchdog) | - |
| Daily summary email | ✅ Task 4 (daily-report.py) | - |
| Auto-checkpoint triggers | ✅ Task 5 (auto-checkpoint.sh) | - |
| Full machine rehydration | ✅ Task 6 (full-rehydrate.sh) | - |
| Unified identity (keys) | ✅ Task 2 (extend identity.json) | - |
| Heartbeat integration | ✅ Task 7 | - |
| Solvr integration | ⚠️ Implicit | **Need explicit task** |
| Onboarding flow | ❌ Missing | **Need task** |
| Quick start for new users | ❌ Missing | **Need task** |
| Verification scripts | ❌ Missing | **Need task** |
| Files reference in SKILL.md | ⚠️ Partial in Task 9 | Expand |
| Integration with proactive-solvr | ❌ Missing | **Need task** |
| Credits/License | ❌ Missing | **Need task** |

## Gaps Identified

### 1. No Onboarding Flow
**proactive-solvr pattern:** Conditional onboarding based on technical level
**Need:** ONBOARDING.md template + onboarding detection in SKILL.md

### 2. No Quick Start
**proactive-solvr pattern:** `cp -r assets/* ./` + auto-detection
**Need:** Clear 3-step quick start in SKILL.md

### 3. No Verification Scripts
**proactive-solvr pattern:** `onboarding-check.sh`, `config-enforce.sh`, `security-audit.sh`
**Need:** `verify-setup.sh` to check AMCP is properly configured

### 4. No proactive-solvr Integration
**Reality:** Many users will have proactive-solvr installed
**Need:** Detect and enhance if present, work standalone if not

### 5. No assets/ for Quick Start
**proactive-solvr pattern:** assets/ contains template files user copies
**Need:** assets/AMCP-ONBOARDING.md, assets/identity-template.json

## Revised Task List (14 tasks)

### Phase 1: Scaffold (3 tasks)
1. ~~Initialize skill directory structure~~ → Keep
2. **NEW: Create assets/ templates** (AMCP-ONBOARDING.md, identity-template.json)
3. ~~Extend identity.json with services~~ → Keep

### Phase 2: Core Scripts (4 tasks)
4. ~~death-tracker.sh~~ → Keep
5. ~~daily-report.py~~ → Keep
6. ~~auto-checkpoint.sh~~ → Keep
7. ~~full-rehydrate.sh~~ → Keep

### Phase 3: Verification (2 tasks)
8. **NEW: verify-setup.sh** — check AMCP is configured correctly
9. ~~verify-identity.sh~~ → Already in task 2

### Phase 4: Integration (2 tasks)
10. ~~Integrate with amcp-watchdog.sh~~ → Keep
11. ~~Add daily report cron~~ → Keep
12. **NEW: Detect and integrate with proactive-solvr** if present

### Phase 5: Documentation (2 tasks)
13. ~~Write SKILL.md body~~ → Expand with quick start, files reference
14. ~~Write references/amcp-lifecycle.md~~ → Keep

### Phase 6: Polish (1 task)
15. **NEW: Add credits, license, final validation**

## Best Practices from proactive-solvr (400 users)

| Practice | Apply to proactive-amcp |
|----------|------------------------|
| Clear Quick Start section | Add to SKILL.md |
| "What You Get" table | Add feature table |
| Files Reference table | Add files table |
| Conditional onboarding | Add AMCP-ONBOARDING.md |
| Verification scripts | Add verify-setup.sh |
| Credits section | Add credits |
| MIT License | Add LICENSE |
| Solvr integration patterns | Document explicitly |
| Token efficiency guidance | Add to SKILL.md |

## Conclusion

**Current tasks: 11**
**Needed tasks: 14** (+3 for gaps)

Gaps:
1. Create assets/ templates
2. verify-setup.sh 
3. proactive-solvr integration detection
4. Credits/license (can combine with SKILL.md task)
