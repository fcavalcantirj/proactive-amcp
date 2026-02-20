/**
 * Memory Integrity Monitor — baseline hashing + unauthorized change alerting.
 *
 * Hashes all memory files (SOUL.md, MEMORY.md, memory/*.md) and stores
 * a baseline in ~/.amcp/memory-baseline.json. On each poll, compares
 * current hashes to baseline. On valid checkpoint events, updates the
 * baseline with current hashes.
 *
 * P4-MEM-01: Create baseline of memory file hashes.
 * P4-MEM-02: Alert on unauthorized memory changes — periodic polling,
 *            change detection, event emission, diff summary logging.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, appendFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  scanMemoryFiles as scanForInjections,
  processInjectionResults,
} from "./prompt-injection-scanner.js";
import {
  autoRestore,
  saveAllSnapshots,
  DEFAULT_SNAPSHOT_DIR,
  DEFAULT_QUARANTINE_DIR,
  DEFAULT_RESTORE_LOG_PATH,
} from "./memory-auto-restore.js";
import type { AutoRestoreResult } from "./memory-auto-restore.js";
import type {
  AmcpPluginConfig,
  PluginLogger,
  PluginService,
} from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFileHash {
  /** SHA-256 hex hash of the file content. */
  hash: string;
  /** File size in bytes at baseline time. */
  size: number;
  /** ISO-8601 timestamp when this hash was recorded. */
  recordedAt: string;
}

export interface MemoryBaseline {
  /** When this baseline was created/updated. */
  createdAt: string;
  /** When this baseline was last updated. */
  updatedAt: string;
  /** Map of relative file path -> hash info. */
  files: Record<string, MemoryFileHash>;
}

/** A single unauthorized change alert entry (logged to change log). */
export interface MemoryChangeAlert {
  /** ISO-8601 timestamp when the change was detected. */
  timestamp: string;
  /** Files whose content hash changed since baseline. */
  changed: string[];
  /** Files added since baseline. */
  added: string[];
  /** Files removed since baseline. */
  removed: string[];
  /** Brief human-readable summary. */
  summary: string;
}

export interface MemoryIntegrityDeps {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  /** Directory containing memory files (SOUL.md, MEMORY.md, memory/). */
  contentDir: string;
  /** Path to store baseline JSON. */
  baselinePath: string;
  /** Path to append change alert log entries (JSONL). */
  changeLogPath?: string;
  /** Polling interval in milliseconds (default: 60000). */
  pollIntervalMs?: number;
  /** Path to append injection alert log entries (JSONL). */
  injectionLogPath?: string;
  /** Directory for clean file snapshots (auto-restore source). */
  snapshotDir?: string;
  /** Directory for quarantined tampered files. */
  quarantineDir?: string;
  /** Path to append restore log entries (JSONL). */
  restoreLogPath?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTENT_DIR = join(homedir(), ".openclaw", "workspace");
const DEFAULT_BASELINE_PATH = join(homedir(), ".amcp", "memory-baseline.json");
const DEFAULT_CHANGE_LOG_PATH = join(homedir(), ".amcp", "memory-changes.jsonl");
const DEFAULT_POLL_INTERVAL_MS = 60_000; // 60 seconds
const DEFAULT_INJECTION_LOG_PATH = join(homedir(), ".amcp", "injection-alerts.jsonl");

/** Top-level memory files to hash. */
const TOP_LEVEL_FILES = [
  "SOUL.md",
  "MEMORY.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
];

/** Subdirectory containing daily notes / extra memory files. */
const MEMORY_SUBDIR = "memory";

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex hash of a string.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Discover all memory files in the content directory.
 * Returns paths relative to contentDir.
 */
export async function discoverMemoryFiles(
  contentDir: string,
): Promise<string[]> {
  const files: string[] = [];

  // Check top-level files
  for (const name of TOP_LEVEL_FILES) {
    const fullPath = join(contentDir, name);
    try {
      const s = await stat(fullPath);
      if (s.isFile()) {
        files.push(name);
      }
    } catch {
      // File doesn't exist — skip
    }
  }

  // Scan memory/ subdirectory for *.md files
  const memoryDir = join(contentDir, MEMORY_SUBDIR);
  try {
    const entries = await readdir(memoryDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const fullPath = join(memoryDir, entry);
      try {
        const s = await stat(fullPath);
        if (s.isFile()) {
          files.push(join(MEMORY_SUBDIR, entry));
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // memory/ directory doesn't exist — that's fine
  }

  return files.sort();
}

/**
 * Hash all discovered memory files.
 * Returns a map of relative path -> MemoryFileHash.
 */
export async function hashMemoryFiles(
  contentDir: string,
  filePaths: string[],
): Promise<Record<string, MemoryFileHash>> {
  const now = new Date().toISOString();
  const result: Record<string, MemoryFileHash> = {};

  for (const relPath of filePaths) {
    const fullPath = join(contentDir, relPath);
    try {
      const content = await readFile(fullPath, "utf-8");
      const s = await stat(fullPath);
      result[relPath] = {
        hash: sha256(content),
        size: s.size,
        recordedAt: now,
      };
    } catch {
      // File disappeared between discovery and hashing — skip
    }
  }

  return result;
}

/**
 * Create a new baseline from the current state of memory files.
 */
export async function createBaseline(
  contentDir: string,
): Promise<MemoryBaseline> {
  const files = await discoverMemoryFiles(contentDir);
  const hashes = await hashMemoryFiles(contentDir, files);
  const now = new Date().toISOString();

  return {
    createdAt: now,
    updatedAt: now,
    files: hashes,
  };
}

/**
 * Load baseline from disk. Returns null if not found or corrupt.
 */
export async function loadBaseline(
  baselinePath: string,
): Promise<MemoryBaseline | null> {
  try {
    const raw = await readFile(baselinePath, "utf-8");
    const parsed = JSON.parse(raw) as MemoryBaseline;
    if (!parsed.files || typeof parsed.files !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save baseline to disk (atomic: write to .tmp then rename not needed
 * for this use case — single writer, non-critical).
 */
export async function saveBaseline(
  baselinePath: string,
  baseline: MemoryBaseline,
): Promise<void> {
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

/**
 * Compare current file hashes against a baseline.
 * Returns arrays of changed, added, and removed file paths.
 */
export function compareToBaseline(
  baseline: MemoryBaseline,
  current: Record<string, MemoryFileHash>,
): { changed: string[]; added: string[]; removed: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Check for changed and added files
  for (const [path, info] of Object.entries(current)) {
    const baselineEntry = baseline.files[path];
    if (!baselineEntry) {
      added.push(path);
    } else if (baselineEntry.hash !== info.hash) {
      changed.push(path);
    }
  }

  // Check for removed files
  for (const path of Object.keys(baseline.files)) {
    if (!(path in current)) {
      removed.push(path);
    }
  }

  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

// ---------------------------------------------------------------------------
// Change Alerting (P4-MEM-02)
// ---------------------------------------------------------------------------

/**
 * Build a human-readable summary of the changes detected.
 */
export function buildChangeSummary(diff: {
  changed: string[];
  added: string[];
  removed: string[];
}): string {
  const parts: string[] = [];
  if (diff.changed.length > 0) {
    parts.push(`modified: ${diff.changed.join(", ")}`);
  }
  if (diff.added.length > 0) {
    parts.push(`added: ${diff.added.join(", ")}`);
  }
  if (diff.removed.length > 0) {
    parts.push(`removed: ${diff.removed.join(", ")}`);
  }
  return parts.join("; ");
}

/**
 * Append an alert entry to the change log (JSONL).
 */
export async function appendChangeLog(
  logPath: string,
  alert: MemoryChangeAlert,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(alert) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Plugin Service
// ---------------------------------------------------------------------------

/** Extended service type returned by createMemoryIntegrityMonitor. */
export type MemoryIntegrityMonitor = PluginService & {
  /** Get the current baseline (null if not yet created). */
  getBaseline(): MemoryBaseline | null;
  /** Force refresh the baseline from current file state. */
  refreshBaseline(): Promise<MemoryBaseline>;
  /** Compare current files to baseline. */
  checkIntegrity(): Promise<{
    changed: string[];
    added: string[];
    removed: string[];
  }>;
  /** Run a single poll cycle (check + alert if changes found). */
  pollOnce(): Promise<MemoryChangeAlert | null>;
  /** Get the last auto-restore result (null if never triggered). */
  getLastRestoreResult(): AutoRestoreResult | null;
};

/**
 * Create the memory integrity monitor service.
 *
 * On start: creates baseline if none exists, or loads existing.
 * Polls periodically to detect unauthorized changes (P4-MEM-02).
 * On checkpoint events: updates baseline with current hashes.
 * Exposes createBaseline/compare for use by other P4-MEM tasks.
 */
export function createMemoryIntegrityMonitor(
  deps: MemoryIntegrityDeps,
): MemoryIntegrityMonitor {
  const { config, logger, emit, contentDir, baselinePath } = deps;
  const changeLogPath = deps.changeLogPath ?? DEFAULT_CHANGE_LOG_PATH;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const injectionLogPath = deps.injectionLogPath ?? DEFAULT_INJECTION_LOG_PATH;
  const snapshotDir = deps.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const quarantineDir = deps.quarantineDir ?? DEFAULT_QUARANTINE_DIR;
  const restoreLogPath = deps.restoreLogPath ?? DEFAULT_RESTORE_LOG_PATH;
  let baseline: MemoryBaseline | null = null;
  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastRestoreResult: AutoRestoreResult | null = null;

  /**
   * Run prompt injection scan on all discovered memory files (P4-MEM-03).
   * Logs and emits alert if injection patterns found.
   */
  async function scanForPromptInjections(): Promise<void> {
    if (!config.memoryIntegrity.promptInjectionScan) return;

    const files = await discoverMemoryFiles(contentDir);
    const result = await scanForInjections(contentDir, files);
    await processInjectionResults(result, logger, emit, injectionLogPath);
  }

  /**
   * Run a single poll cycle: compare current files to baseline,
   * emit alert + log if unauthorized changes detected.
   * Also runs prompt injection scan (P4-MEM-03).
   * Returns the alert if changes found, null otherwise.
   */
  async function pollOnce(): Promise<MemoryChangeAlert | null> {
    // Run prompt injection scan regardless of baseline state (P4-MEM-03)
    await scanForPromptInjections();

    if (!baseline) return null;

    const files = await discoverMemoryFiles(contentDir);
    const current = await hashMemoryFiles(contentDir, files);
    const diff = compareToBaseline(baseline, current);

    const totalChanges = diff.changed.length + diff.added.length + diff.removed.length;
    if (totalChanges === 0) return null;

    // Build alert
    const alert: MemoryChangeAlert = {
      timestamp: new Date().toISOString(),
      changed: diff.changed,
      added: diff.added,
      removed: diff.removed,
      summary: buildChangeSummary(diff),
    };

    // Log the alert
    logger.warn(
      `amcp-memory-integrity: unauthorized change detected — ${alert.summary}`,
    );
    await appendChangeLog(changeLogPath, alert);

    // Emit event for other services to react to
    emit("amcp:memory:unauthorized_change", {
      changed: diff.changed,
      added: diff.added,
      removed: diff.removed,
      summary: alert.summary,
      timestamp: alert.timestamp,
    });

    // Auto-restore from snapshot if enabled (P4-MEM-04)
    if (config.memoryIntegrity.autoRestore) {
      try {
        const restoreResult = await autoRestore(
          contentDir,
          diff.changed,
          diff.added,
          diff.removed,
          snapshotDir,
          quarantineDir,
          restoreLogPath,
          logger,
        );
        lastRestoreResult = restoreResult;

        emit("amcp:memory:auto_restored", {
          restoredCount: restoreResult.restoredCount,
          quarantinedOnlyCount: restoreResult.quarantinedOnlyCount,
          removedFilesRestored: diff.removed.length,
          timestamp: restoreResult.timestamp,
          success: restoreResult.success,
        });
      } catch (err) {
        logger.error(
          `amcp-memory-integrity: auto-restore failed — ${String(err)}`,
        );
      }
    }

    return alert;
  }

  return {
    name: "amcp-memory-integrity",

    getBaseline() {
      return baseline;
    },

    async refreshBaseline(): Promise<MemoryBaseline> {
      baseline = await createBaseline(contentDir);
      baseline.updatedAt = new Date().toISOString();
      await saveBaseline(baselinePath, baseline);
      // Update snapshots for auto-restore (P4-MEM-04)
      if (config.memoryIntegrity.autoRestore) {
        await saveAllSnapshots(contentDir, Object.keys(baseline.files), snapshotDir);
      }
      logger.info(
        `amcp-memory-integrity: baseline updated — ${Object.keys(baseline.files).length} file(s)`,
      );
      emit("amcp:memory:baseline_updated", {
        fileCount: Object.keys(baseline.files).length,
      });
      return baseline;
    },

    async checkIntegrity() {
      if (!baseline) {
        return { changed: [], added: [], removed: [] };
      }
      const files = await discoverMemoryFiles(contentDir);
      const current = await hashMemoryFiles(contentDir, files);
      return compareToBaseline(baseline, current);
    },

    pollOnce,

    getLastRestoreResult() {
      return lastRestoreResult;
    },

    async start() {
      if (running) return;
      if (!config.memoryIntegrity.enabled) {
        logger.info("amcp-memory-integrity: disabled via config");
        return;
      }
      running = true;

      // Load or create baseline
      baseline = await loadBaseline(baselinePath);
      if (baseline) {
        logger.info(
          `amcp-memory-integrity: loaded baseline — ${Object.keys(baseline.files).length} file(s)`,
        );
        // Ensure snapshots exist for auto-restore (P4-MEM-04)
        if (config.memoryIntegrity.autoRestore) {
          await saveAllSnapshots(contentDir, Object.keys(baseline.files), snapshotDir);
        }
      } else {
        baseline = await createBaseline(contentDir);
        await saveBaseline(baselinePath, baseline);
        // Save clean snapshots for auto-restore (P4-MEM-04)
        if (config.memoryIntegrity.autoRestore) {
          await saveAllSnapshots(contentDir, Object.keys(baseline.files), snapshotDir);
        }
        logger.info(
          `amcp-memory-integrity: created baseline — ${Object.keys(baseline.files).length} file(s)`,
        );
        emit("amcp:memory:baseline_created", {
          fileCount: Object.keys(baseline.files).length,
          files: Object.keys(baseline.files),
        });
      }

      // Run initial prompt injection scan (P4-MEM-03)
      await scanForPromptInjections();

      // Start periodic polling for unauthorized changes (P4-MEM-02) + injection scan (P4-MEM-03)
      pollTimer = setInterval(() => {
        pollOnce().catch((err) => {
          logger.error(`amcp-memory-integrity: poll error — ${String(err)}`);
        });
      }, pollIntervalMs);
      logger.info(
        `amcp-memory-integrity: polling every ${pollIntervalMs / 1000}s for unauthorized changes`,
      );
    },

    async stop() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      running = false;
      logger.info("amcp-memory-integrity: stopped");
    },

    async status() {
      return {
        running,
        details: {
          service: "amcp-memory-integrity",
          baselinePath,
          changeLogPath,
          contentDir,
          fileCount: baseline ? Object.keys(baseline.files).length : 0,
          hasBaseline: baseline !== null,
          polling: pollTimer !== null,
          pollIntervalMs,
          autoRestore: config.memoryIntegrity.autoRestore,
          snapshotDir,
          quarantineDir,
          lastRestore: lastRestoreResult
            ? {
                timestamp: lastRestoreResult.timestamp,
                restoredCount: lastRestoreResult.restoredCount,
                success: lastRestoreResult.success,
              }
            : null,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Defaults export for index.ts wiring
// ---------------------------------------------------------------------------

export { DEFAULT_CONTENT_DIR, DEFAULT_BASELINE_PATH, DEFAULT_CHANGE_LOG_PATH, DEFAULT_POLL_INTERVAL_MS };
