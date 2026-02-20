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
  ContentHasher,
  ContextWarningSeverity,
} from "../types.js";

/** Default context warning thresholds (%). */
const WARNING_THRESHOLD = 60;
const CRITICAL_THRESHOLD = 80;

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
 * Trigger a checkpoint and update shared cooldown state.
 * Returns true if checkpoint was triggered, false if blocked by cooldown.
 */
async function triggerCheckpoint(
  trigger: string,
  reading: ContextReading | null,
  cooldownMs: number,
  state: { lastCheckpointTriggerTime: number },
  logger: ContextMonitorDeps["logger"],
  emit: ContextMonitorDeps["emit"],
  checkpointLogPath: string,
  extra?: Record<string, unknown>,
): Promise<boolean> {
  const now = Date.now();
  const elapsed = now - state.lastCheckpointTriggerTime;

  if (elapsed < cooldownMs) {
    const remainingMs = cooldownMs - elapsed;
    logger.info(
      `amcp-context-monitor: ${trigger} but in cooldown (${Math.round(remainingMs / 1000)}s remaining)`,
    );
    return false;
  }

  state.lastCheckpointTriggerTime = now;

  const timestamp = reading?.timestamp ?? new Date().toISOString();
  const logEntry: CheckpointLogEntry = {
    timestamp,
    trigger,
    contextPercent: reading?.contextPercent ?? 0,
    usedTokens: reading?.usedTokens ?? 0,
    maxTokens: reading?.maxTokens ?? 0,
    cooldownMs,
  };
  await appendCheckpointLog(checkpointLogPath, logEntry);

  const eventData: Record<string, unknown> = { trigger, ...extra };
  if (reading) {
    eventData.contextPercent = reading.contextPercent;
  }
  emit("amcp:checkpoint:requested", eventData);

  return true;
}

/**
 * Create a context monitor service that polls session context usage.
 * Supports both threshold-based and time-based checkpoint triggers.
 *
 * Time-based triggers are checked during the regular poll cycle
 * (every 30s) rather than via a separate timer, ensuring reliable
 * async behavior with fake timers in tests.
 */
export function createContextMonitor(deps: ContextMonitorDeps): PluginService {
  const { config, logger, emit, sessionApi, historyPath, checkpointLogPath } =
    deps;
  const contentHasher: ContentHasher | undefined = deps.contentHasher;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastReading: ContextReading | null = null;
  const cooldownState = { lastCheckpointTriggerTime: 0 };
  let lastCheckpointContentHash: string | null = null;
  let lastIntervalCheckTime = 0;
  let intervalEnabled = false;
  /** Last emitted context warning severity (to avoid duplicate emissions). */
  let lastWarningSeverity: ContextWarningSeverity | null = null;
  /** Chain of poll promises — each poll awaits the previous to prevent concurrency. */
  let pollChain: Promise<void> = Promise.resolve();

  /**
   * Check if a time-based interval checkpoint is due.
   * Called during each poll() to avoid fire-and-forget async issues.
   */
  async function checkIntervalTrigger(): Promise<void> {
    if (!intervalEnabled || config.checkpointIntervalMs <= 0) return;

    const now = Date.now();
    const elapsed = now - lastIntervalCheckTime;
    if (elapsed < config.checkpointIntervalMs) return;

    // Check for meaningful changes via content hash
    if (contentHasher) {
      const currentHash = await contentHasher.getContentHash();
      if (
        lastCheckpointContentHash !== null &&
        currentHash === lastCheckpointContentHash
      ) {
        logger.info(
          "amcp-context-monitor: interval — skipping, no changes since last checkpoint",
        );
        // Still update the interval check time so we check again next period
        lastIntervalCheckTime = now;
        return;
      }
    }

    const triggered = await triggerCheckpoint(
      "time_interval",
      lastReading,
      config.checkpointCooldownMs,
      cooldownState,
      logger,
      emit,
      checkpointLogPath,
      { intervalMs: config.checkpointIntervalMs },
    );
    if (triggered) {
      lastIntervalCheckTime = now;
      logger.info(
        `amcp-context-monitor: time-based checkpoint triggered (every ${Math.round(config.checkpointIntervalMs / 60_000)}min)`,
      );
      if (contentHasher) {
        try {
          lastCheckpointContentHash =
            await contentHasher.getContentHash();
        } catch {
          // non-fatal
        }
      }
    } else {
      // Cooldown blocked the trigger — still update interval check time
      lastIntervalCheckTime = now;
    }
  }

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

      // Context warning emissions — two-tier alert system
      // Emit warnings at 60% and critical at 80% (only on severity escalation)
      let currentSeverity: ContextWarningSeverity | null = null;
      if (contextPercent >= CRITICAL_THRESHOLD) {
        currentSeverity = "critical";
      } else if (contextPercent >= WARNING_THRESHOLD) {
        currentSeverity = "warning";
      }

      if (currentSeverity !== null && currentSeverity !== lastWarningSeverity) {
        const threshold = currentSeverity === "critical"
          ? CRITICAL_THRESHOLD
          : WARNING_THRESHOLD;
        logger.warn(
          `amcp-context-monitor: context ${currentSeverity} — ${reading.contextPercent}% (threshold: ${threshold}%)`,
        );
        emit("amcp:context:warning", {
          severity: currentSeverity,
          contextPercent: reading.contextPercent,
          usedTokens,
          maxTokens,
          threshold,
        });
      }
      lastWarningSeverity = currentSeverity;

      // Threshold-based trigger
      if (contextPercent >= config.contextThreshold) {
        const triggered = await triggerCheckpoint(
          "context_threshold",
          reading,
          config.checkpointCooldownMs,
          cooldownState,
          logger,
          emit,
          checkpointLogPath,
        );
        if (triggered) {
          logger.warn(
            `amcp-context-monitor: threshold ${config.contextThreshold}% exceeded — ${reading.contextPercent}%`,
          );
          if (contentHasher) {
            try {
              lastCheckpointContentHash =
                await contentHasher.getContentHash();
            } catch {
              // non-fatal
            }
          }
        }
      }

      // Time-based interval trigger (checked during poll)
      await checkIntervalTrigger();
    } catch (err) {
      logger.error(
        `amcp-context-monitor: poll failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const service: PluginService & { waitForPendingPoll(): Promise<void> } = {
    name: "amcp-context-monitor",

    /** Await all pending poll operations (for test use). */
    async waitForPendingPoll() {
      await pollChain;
    },

    async start() {
      if (running) return;
      running = true;
      logger.info("amcp-context-monitor: started");

      // Set up time-based interval tracking
      if (config.checkpointIntervalMs > 0) {
        intervalEnabled = true;
        lastIntervalCheckTime = Date.now();
        logger.info(
          `amcp-context-monitor: time-based checkpoints enabled (every ${Math.round(config.checkpointIntervalMs / 60_000)}min)`,
        );
        // Capture initial content hash for change detection
        if (contentHasher) {
          try {
            lastCheckpointContentHash =
              await contentHasher.getContentHash();
          } catch {
            // non-fatal — hash comparison will be skipped
          }
        }
      }

      // Initial poll, then repeat at interval
      await poll();
      pollTimer = setInterval(() => {
        // Chain polls sequentially to prevent concurrency issues
        pollChain = pollChain.then(() => poll());
      }, POLL_INTERVAL_MS);
    },

    async stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
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
          checkpointIntervalMs: config.checkpointIntervalMs,
          intervalEnabled,
          lastCheckpointTriggerTime:
            cooldownState.lastCheckpointTriggerTime > 0
              ? new Date(
                  cooldownState.lastCheckpointTriggerTime,
                ).toISOString()
              : undefined,
          lastCheckpointContentHash:
            lastCheckpointContentHash ?? undefined,
        },
      };
    },
  };

  return service;
}
