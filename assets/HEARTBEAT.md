# AMCP Heartbeat Checks

> Add these to your main HEARTBEAT.md or use standalone.

---

## 🔄 Checkpoint Health (every heartbeat)

### Last Checkpoint Age
```bash
# Check when last checkpoint was created
LAST=$(cat ~/.amcp/last-checkpoint.json 2>/dev/null | jq -r '.timestamp')
if [ -n "$LAST" ]; then
  AGE_HOURS=$(( ($(date +%s) - $(date -d "$LAST" +%s)) / 3600 ))
  if [ "$AGE_HOURS" -gt 24 ]; then
    echo "⚠️ Last checkpoint is ${AGE_HOURS}h old"
  fi
fi
```

### Identity File Exists
```bash
[ -f ~/.amcp/identity.json ] || echo "❌ CRITICAL: identity.json missing!"
```

### Pinata Connection
```bash
JWT=$(cat ~/.amcp/config.json 2>/dev/null | jq -r '.pinata.jwt')
if [ -n "$JWT" ]; then
  curl -s "https://api.pinata.cloud/data/testAuthentication" \
    -H "Authorization: Bearer $JWT" | grep -q "Congratulations" || echo "⚠️ Pinata auth failed"
fi
```

---

## 📊 Checkpoint Stats

Track in `memory/amcp-stats.json`:
```json
{
  "totalCheckpoints": 0,
  "lastCID": "",
  "lastTimestamp": "",
  "totalDeaths": 0,
  "totalRecoveries": 0
}
```

Update after each checkpoint/recovery.

---

## 🚨 When to Alert

| Condition | Action |
|-----------|--------|
| No checkpoint in 24h+ | Warn human |
| identity.json missing | **CRITICAL** — cannot recover |
| Pinata auth fails | Check JWT, may have expired |
| Disk > 90% full | Checkpoints may fail |

---

## 💡 Proactive Checkpoint Triggers

Consider checkpointing after:
- Major task completion
- Learning something important  
- Before risky operations
- Before long idle periods

---

*Memory persists. Check your backups.*
