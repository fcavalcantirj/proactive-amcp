/**
 * Resurrection Detector — detect context wipe / compaction at plugin level.
 *
 * Monitors session context usage via the SessionApi and detects:
 * 1. Sudden context drop (>50% reduction between consecutive readings)
 * 2. Session restart without explicit command (context drops to 0)
 *
 * On detection, emits "amcp:resurrection:detected" and logs to
 * ~/.amcp/resurrection-log.jsonl for audit.
 *
 * This module detects the wipe event itself. The companion module
 * resurrection-identity.ts handles post-resurrection identity verification.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PluginLogger, SessionApi, AmcpPluginConfig } from "../types.js";

/** Default poll interval for context monitoring (10 seconds). */
const POLL_INTERVAL_MS = 10_000;

/** Default minimum context drop ratio to trigger detection (50%). */
const DEFAULT_DROP_THRESHOLD = 0.5;

/**
 * Minimum usedTokens the previous reading must have for a "sudden drop"
 * to be meaningful. Avoids false positives from idle sessions.
 */
const MIN_TOKENS_FOR_DROP = 1000;

/** Default path for resurrection detection log. */
const DEFAULT_LOG_PATH = join(
  homedir(),
  ".amcp",
  "resurrection-log.jsonl",
);

/** A single resurrection detection event. */
export interface ResurrectionLogEntry {
  timestamp: string;
  type: "context_drop" | "session_restart";
  previousTokens: number;
  currentTokens: number;
  maxTokens: number;
  dropPercent: number;
  details: string;
}

/** Dependencies for the resurrection detector. */
export interface ResurrectionDetectorDeps {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  sessionApi: SessionApi;
  logPath?: string;
  /** Override drop threshold (0-1). Default 0.5 = 50%. */
  dropThreshold?: number;
  /** Override poll interval in ms. Default 10_000. */
  pollIntervalMs?: number;
}

/**
 * Append a resurrection detection entry to the JSONL log file.
 */
async function appendLog(
  logPath: string,
  entry: ResurrectionLogEntry,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Determine if a context drop has occurred.
 *
 * Returns null if no significant drop, or a ResurrectionLogEntry describing it.
 */
function detectDrop(
  prevTokens: number,
  currTokens: number,
  maxTokens: number,
  dropThreshold: number,
): ResurrectionLogEntry | null {
  // Session restart: context goes to 0 from a meaningful amount
  if (currTokens === 0 && prevTokens >= MIN_TOKENS_FOR_DROP) {
    return {
      timestamp: new Date().toISOString(),
      type: "session_restart",
      previousTokens: prevTokens,
      currentTokens: currTokens,
      maxTokens,
      dropPercent: 100,
      details: `Context dropped from ${prevTokens} to 0 tokens — session restart detected`,
    };
  }

  // Sudden drop: context decreases by more than threshold
  if (prevTokens >= MIN_TOKENS_FOR_DROP && currTokens < prevTokens) {
    const dropRatio = (prevTokens - currTokens) / prevTokens;
    if (dropRatio >= dropThreshold) {
      const dropPct = Math.round(dropRatio * 10000) / 100;
      return {
        timestamp: new Date().toISOString(),
        type: "context_drop",
        previousTokens: prevTokens,
        currentTokens: currTokens,
        maxTokens,
        dropPercent: dropPct,
        details: `Context dropped ${dropPct}% (${prevTokens} → ${currTokens} tokens) — compaction or wipe detected`,
      };
    }
  }

  return null;
}

/**
 * Create a resurrection detector service for the plugin.
 *
 * Polls session context at a fixed interval and compares consecutive
 * readings. When a significant drop is detected, emits an event and
 * logs to disk.
 */
export function createResurrectionDetector(
  deps: ResurrectionDetectorDeps,
): {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    running: boolean;
    details?: Record<string, unknown>;
  }>;
  /** Wait for any in-flight poll to complete (for tests). */
  waitForPendingPoll(): Promise<void>;
  /** Get all detections since service started. */
  getDetections(): ResurrectionLogEntry[];
} {
  const { config, logger, emit, sessionApi } = deps;
  const logPath = deps.logPath ?? DEFAULT_LOG_PATH;
  const dropThreshold = deps.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
  const pollInterval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;

  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let previousTokens: number | null = null;
  const detections: ResurrectionLogEntry[] = [];
  let pollChain: Promise<void> = Promise.resolve();

  async function poll(): Promise<void> {
    if (!config.resurrection.autoDetect) return;

    try {
      const { usedTokens, maxTokens } =
        await sessionApi.getContextUsage();

      // First reading — establish baseline only
      if (previousTokens === null) {
        previousTokens = usedTokens;
        logger.debug(
          `amcp-resurrection-detector: baseline ${usedTokens}/${maxTokens} tokens`,
        );
        return;
      }

      const entry = detectDrop(
        previousTokens,
        usedTokens,
        maxTokens,
        dropThreshold,
      );

      if (entry) {
        detections.push(entry);
        logger.warn(
          `amcp-resurrection-detector: ${entry.type} — ${entry.details}`,
        );

        await appendLog(logPath, entry);

        emit("amcp:resurrection:detected", {
          type: entry.type,
          previousTokens: entry.previousTokens,
          currentTokens: entry.currentTokens,
          maxTokens: entry.maxTokens,
          dropPercent: entry.dropPercent,
        });
      }

      previousTokens = usedTokens;
    } catch (err) {
      logger.error(
        `amcp-resurrection-detector: poll failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    name: "amcp-resurrection-detector",

    async start(): Promise<void> {
      if (running) return;
      running = true;
      logger.info("amcp-resurrection-detector: started");

      if (!config.resurrection.autoDetect) {
        logger.info(
          "amcp-resurrection-detector: autoDetect disabled — monitoring inactive",
        );
        return;
      }

      // Initial poll to capture baseline
      await poll();

      pollTimer = setInterval(() => {
        pollChain = pollChain.then(() => poll());
      }, pollInterval);
    },

    async stop(): Promise<void> {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      running = false;
      logger.info("amcp-resurrection-detector: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      return {
        running,
        details: {
          service: "amcp-resurrection-detector",
          autoDetect: config.resurrection.autoDetect,
          pollIntervalMs: pollInterval,
          dropThreshold,
          previousTokens: previousTokens ?? undefined,
          totalDetections: detections.length,
          lastDetection:
            detections.length > 0
              ? detections[detections.length - 1]
              : undefined,
        },
      };
    },

    async waitForPendingPoll(): Promise<void> {
      await pollChain;
    },

    getDetections(): ResurrectionLogEntry[] {
      return [...detections];
    },
  };
}
