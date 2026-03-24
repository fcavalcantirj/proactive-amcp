# TODO — proactive-amcp

## Post-Incident Mitigations (2026-03-24 death loop)

Solvr refs: Problem `7f6641af`, Idea `d87d752f`

### 1. Shared `safe_restart_gateway()` helper
- [ ] Create `scripts/lib/gateway.sh` with `safe_restart_gateway()`
- [ ] Use `systemctl stop` + wait + `systemctl start` (not `restart`) for gap control
- [ ] PID wait up to 15s + SIGKILL fallback
- [ ] 5s Telegram lock release gap after process confirmed dead
- [ ] Replace all 13 inline restart locations in `scripts/`, `skill/`, `package/`
- [ ] Configurable via `TELEGRAM_LOCK_RELEASE_SECONDS` (default 5) and `GATEWAY_STOP_TIMEOUT` (default 15)

### 2. Telegram ghost poll awareness in resurrection
- [ ] After death loop recovery in `resuscitate.sh`, wait 90s before first gateway start
- [ ] Call `deleteWebhook?drop_pending_updates=true` before starting
- [ ] Only apply the 90s wait when coming from DEAD state (not normal restarts)

### 3. `allowFrom` validation in `diagnose.sh`
- [ ] New check: extract `allowFrom` from `openclaw.json`
- [ ] Warn if `allowFrom` is empty AND `dmPolicy=allowlist` (messages will be silently dropped)
- [ ] Bump `checks_run` accordingly

### 4. Anti-conflict restart lock
- [ ] Separate restart lock file (not the resurrection lock)
- [ ] Acquired before any gateway restart in `safe_restart_gateway()`
- [ ] Prevents watchdog + claude session + manual fix from restarting simultaneously
- [ ] Short TTL (60s max) with stale lock detection

### 5. Document `authProfileOverrideSource=user`
- [ ] Add to CLAUDE.md under Key Patterns
- [ ] If proactive-amcp ever patches session auth, MUST set `authProfileOverrideSource: user` (not `auto`)
- [ ] `auto` causes gateway to re-evaluate and revert the override on every session tick

### 6. `diagnose.sh` line count
- [ ] Currently 928 lines (over ~800 guideline)
- [ ] Extract health checks to `_diagnose-health.sh` following existing subcommand pattern
