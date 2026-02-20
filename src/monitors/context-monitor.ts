/**
 * Context Monitor — tracks session context usage in real-time.
 *
 * Interfaces with OpenClaw session API to poll token counts,
 * computes context % as (usedTokens / maxTokens) * 100,
 * stores readings in .amcp/context-history.jsonl,
 * enforces cooldown between checkpoint triggers, logs triggers
 * to .amcp/checkpoint-log.jsonl, and emits checkpoint events
 * when thresholds are crossed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  PluginService,
  ContextReading,
  CheckpointLogEntry,
  ContextMonitorDeps,
} from "../types.js";

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Append a context reading as a JSON line to the history file.
 */
async function appendReading(
  historyPath: string,
  reading: ContextReading,
): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  await appendFile(historyPath, JSON.stringify(reading) + "\n", "utf-8");
}

/**
 * Append a checkpoint trigger entry to the checkpoint log.
 */
async function appendCheckpointLog(
  logPath: string,
  entry: CheckpointLogEntry,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Create a context monitor service that polls session context usage.
 */
export function createContextMonitor(deps: ContextMonitorDeps): PluginService {
  const { config, logger, emit, sessionApi, historyPath, checkpointLogPath } =
    deps;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastReading: ContextReading | null = null;
  let lastCheckpointTriggerTime = 0;

  async function poll(): Promise<void> {
    try {
      const { usedTokens, maxTokens } = await sessionApi.getContextUsage();
      const contextPercent =
        maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;

      const reading: ContextReading = {
        timestamp: new Date().toISOString(),
        usedTokens,
        maxTokens,
        contextPercent: Math.round(contextPercent * 100) / 100,
      };

      lastReading = reading;
      logger.info(
        `amcp-context-monitor: context ${reading.contextPercent}% (${usedTokens}/${maxTokens})`,
      );

      await appendReading(historyPath, reading);

      if (contextPercent >= config.contextThreshold) {
        const now = Date.now();
        const elapsed = now - lastCheckpointTriggerTime;
        const cooldownMs = config.checkpointCooldownMs;

        if (elapsed >= cooldownMs) {
          lastCheckpointTriggerTime = now;

          logger.warn(
            `amcp-context-monitor: threshold ${config.contextThreshold}% exceeded — ${reading.contextPercent}%`,
          );

          const logEntry: CheckpointLogEntry = {
            timestamp: reading.timestamp,
            trigger: "context_threshold",
            contextPercent: reading.contextPercent,
            usedTokens,
            maxTokens,
            cooldownMs,
          };
          await appendCheckpointLog(checkpointLogPath, logEntry);

          emit("amcp:checkpoint:requested", {
            trigger: "context_threshold",
            contextPercent: reading.contextPercent,
          });
        } else {
          const remainingMs = cooldownMs - elapsed;
          logger.info(
            `amcp-context-monitor: threshold exceeded but in cooldown (${Math.round(remainingMs / 1000)}s remaining)`,
          );
        }
      }
    } catch (err) {
      logger.error(
        `amcp-context-monitor: poll failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    name: "amcp-context-monitor",

    async start() {
      if (running) return;
      running = true;
      logger.info("amcp-context-monitor: started");
      // Initial poll, then repeat at interval
      await poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      running = false;
      logger.info("amcp-context-monitor: stopped");
    },

    async status() {
      return {
        running,
        details: {
          service: "amcp-context-monitor",
          lastReading: lastReading ?? undefined,
          pollIntervalMs: POLL_INTERVAL_MS,
          thresholdPercent: config.contextThreshold,
          cooldownMs: config.checkpointCooldownMs,
          lastCheckpointTriggerTime:
            lastCheckpointTriggerTime > 0
              ? new Date(lastCheckpointTriggerTime).toISOString()
              : undefined,
        },
      };
    },
  };
}
