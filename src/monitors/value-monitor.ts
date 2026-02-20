/**
 * Value Monitor — triggers checkpoint when high-value content changes detected.
 *
 * Monitors memory files (SOUL.md, MEMORY.md, identity.json, memory/*.md) for
 * patterns that indicate high-value content: new secrets, identity changes,
 * important decisions. Triggers checkpoint on detection, respects cooldown,
 * logs trigger reason with content summary (secrets redacted).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import type {
  PluginService,
  CheckpointLogEntry,
  ValueMonitorDeps,
  ValuePattern,
  ValueDetection,
  FileWatcher,
} from "../types.js";

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Built-in patterns for high-value content detection.
 * Secrets are redacted in log summaries to avoid leaking credentials.
 */
export const BUILTIN_PATTERNS: ValuePattern[] = [
  {
    name: "identity_change",
    pattern: /(?:"aid"|"publicKey"|"kel"|"nextKeyHash")\s*:/,
    redact: false,
  },
  {
    name: "secret_api_key",
    pattern: /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|solvr_[a-zA-Z0-9]{32,}|am_[a-zA-Z0-9]{32,})/,
    redact: true,
  },
  {
    name: "secret_jwt",
    pattern: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
    redact: true,
  },
  {
    name: "secret_bot_token",
    pattern: /[0-9]{8,}:AA[a-zA-Z0-9_-]{30,}/,
    redact: true,
  },
  {
    name: "important_decision",
    pattern: /(?:DECISION|IMPORTANT|CRITICAL|BREAKING CHANGE|NEVER|ALWAYS):\s*.+/i,
    redact: false,
  },
  {
    name: "soul_change",
    pattern: /(?:north\s*star|identity|principles?|voice|who\s+(?:i|you)\s+(?:am|are))/i,
    redact: false,
  },
];

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
 * Generate a safe content summary for logging (no secrets).
 */
function makeSummary(
  filePath: string,
  patternName: string,
  redact: boolean,
  matchedText: string,
): string {
  const file = basename(filePath);
  if (redact) {
    return `${file}: ${patternName} detected [REDACTED]`;
  }
  // Truncate matched text to 80 chars
  const truncated =
    matchedText.length > 80 ? matchedText.slice(0, 77) + "..." : matchedText;
  return `${file}: ${patternName} — ${truncated}`;
}

/**
 * Scan file content for high-value patterns.
 * Returns all detections found.
 */
export function scanForValuePatterns(
  filePath: string,
  content: string,
  patterns: ValuePattern[],
): ValueDetection[] {
  const detections: ValueDetection[] = [];
  const timestamp = new Date().toISOString();

  for (const pat of patterns) {
    const match = pat.pattern.exec(content);
    if (match) {
      detections.push({
        timestamp,
        filePath,
        patternName: pat.name,
        summary: makeSummary(filePath, pat.name, pat.redact, match[0]),
      });
    }
  }

  return detections;
}

/**
 * Create a value monitor service that watches files for high-value changes.
 *
 * Polls file hashes every 30s. When a file changes, scans its new content
 * for high-value patterns. On detection, triggers a checkpoint (respecting
 * cooldown) and logs the trigger reason with a safe summary.
 */
export function createValueMonitor(deps: ValueMonitorDeps): PluginService {
  const { config, logger, emit, fileWatcher, checkpointLogPath, watchPaths } =
    deps;
  const patterns: ValuePattern[] = [
    ...BUILTIN_PATTERNS,
    ...(deps.extraPatterns ?? []),
  ];

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastFileHashes: Map<string, string> = new Map();
  let lastDetections: ValueDetection[] = [];
  const cooldownState = { lastCheckpointTriggerTime: 0 };
  let pollChain: Promise<void> = Promise.resolve();

  /**
   * Trigger a checkpoint from a value detection.
   * Returns true if triggered, false if blocked by cooldown.
   */
  async function triggerCheckpoint(
    detections: ValueDetection[],
  ): Promise<boolean> {
    const now = Date.now();
    const elapsed = now - cooldownState.lastCheckpointTriggerTime;

    if (elapsed < config.checkpointCooldownMs) {
      const remainingMs = config.checkpointCooldownMs - elapsed;
      logger.info(
        `amcp-value-monitor: high-value change detected but in cooldown (${Math.round(remainingMs / 1000)}s remaining)`,
      );
      return false;
    }

    cooldownState.lastCheckpointTriggerTime = now;

    const trigger = "value_content";
    const summaries = detections.map((d) => d.summary);

    const logEntry: CheckpointLogEntry = {
      timestamp: new Date().toISOString(),
      trigger,
      contextPercent: 0,
      usedTokens: 0,
      maxTokens: 0,
      cooldownMs: config.checkpointCooldownMs,
    };
    await appendCheckpointLog(checkpointLogPath, logEntry);

    emit("amcp:checkpoint:requested", {
      trigger,
      detections: summaries,
      fileCount: new Set(detections.map((d) => d.filePath)).size,
    });

    logger.warn(
      `amcp-value-monitor: checkpoint triggered — ${detections.length} high-value change(s): ${summaries.join("; ")}`,
    );

    return true;
  }

  /**
   * Poll watched files for changes and scan changed files for patterns.
   */
  async function poll(): Promise<void> {
    try {
      const currentHashes = await fileWatcher.getFileHashes();
      const allDetections: ValueDetection[] = [];

      for (const filePath of watchPaths) {
        const currentHash = currentHashes.get(filePath);
        const previousHash = lastFileHashes.get(filePath);

        // File missing — skip
        if (!currentHash) continue;

        // No change — skip
        if (currentHash === previousHash) continue;

        // File changed — scan for patterns
        const content = await fileWatcher.readFile(filePath);
        if (!content) continue;

        const detections = scanForValuePatterns(filePath, content, patterns);
        if (detections.length > 0) {
          allDetections.push(...detections);
          logger.info(
            `amcp-value-monitor: ${basename(filePath)} changed — ${detections.length} pattern(s) matched`,
          );
        } else {
          logger.info(
            `amcp-value-monitor: ${basename(filePath)} changed — no high-value patterns`,
          );
        }
      }

      // Update hashes after scanning
      lastFileHashes = currentHashes;

      if (allDetections.length > 0) {
        lastDetections = allDetections;
        await triggerCheckpoint(allDetections);
      }
    } catch (err) {
      logger.error(
        `amcp-value-monitor: poll failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const service: PluginService & { waitForPendingPoll(): Promise<void> } = {
    name: "amcp-value-monitor",

    async waitForPendingPoll() {
      await pollChain;
    },

    async start() {
      if (running) return;
      running = true;
      logger.info(
        `amcp-value-monitor: started — watching ${watchPaths.length} path(s)`,
      );

      // Capture initial file hashes (no checkpoint on first scan)
      try {
        lastFileHashes = await fileWatcher.getFileHashes();
      } catch {
        // non-fatal — will be populated on first poll
      }

      // Start polling
      pollTimer = setInterval(() => {
        pollChain = pollChain.then(() => poll());
      }, POLL_INTERVAL_MS);
    },

    async stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      running = false;
      logger.info("amcp-value-monitor: stopped");
    },

    async status() {
      return {
        running,
        details: {
          service: "amcp-value-monitor",
          watchPaths,
          patternCount: patterns.length,
          pollIntervalMs: POLL_INTERVAL_MS,
          cooldownMs: config.checkpointCooldownMs,
          lastDetections:
            lastDetections.length > 0 ? lastDetections : undefined,
          lastCheckpointTriggerTime:
            cooldownState.lastCheckpointTriggerTime > 0
              ? new Date(
                  cooldownState.lastCheckpointTriggerTime,
                ).toISOString()
              : undefined,
        },
      };
    },
  };

  return service;
}
