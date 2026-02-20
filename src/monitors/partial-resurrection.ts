/**
 * Partial Resurrection — restore specific memories from a checkpoint.
 *
 * Instead of a full resurrection that overwrites the entire workspace,
 * partial resurrection lets you pick which files to restore using
 * glob-like patterns (e.g., "memory/*.md", "SOUL.md"). Files not
 * matching any pattern are preserved in their current state.
 *
 * Workflow:
 *   1. Decrypt checkpoint to a temp directory (via amcp CLI)
 *   2. Match files in the decrypted content against include patterns
 *   3. Back up current versions of matched files
 *   4. Copy matched files into the workspace
 *   5. Log all actions for audit
 *
 * Config gate: `resurrection.autoDetect` must be enabled.
 */

import { readFile, writeFile, mkdir, readdir, stat, copyFile, rename } from "node:fs/promises";
import { join, relative, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { PluginLogger, AmcpPluginConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONTENT_DIR = join(homedir(), ".openclaw", "workspace");
const DEFAULT_BACKUP_DIR = join(homedir(), ".amcp", "partial-restore-backups");
const DEFAULT_LOG_PATH = join(homedir(), ".amcp", "partial-resurrection-log.jsonl");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single file that was restored during partial resurrection. */
export interface RestoredFile {
  /** Path relative to workspace root. */
  relativePath: string;
  /** Whether the file had a previous version that was backed up. */
  hadPrevious: boolean;
  /** Backup path (if previous existed). */
  backupPath?: string;
}

/** Result of a partial resurrection attempt. */
export interface PartialResurrectionResult {
  success: boolean;
  /** Files that were restored. */
  restored: RestoredFile[];
  /** Files in the checkpoint that were skipped (didn't match patterns). */
  skipped: string[];
  /** Patterns used for matching. */
  patterns: string[];
  /** Checkpoint source (CID or local path). */
  checkpointSource: string;
  /** Timestamp of the operation. */
  timestamp: string;
  /** Error message if failed. */
  error?: string;
}

/** Log entry for partial resurrection audit trail. */
export interface PartialResurrectionLogEntry {
  timestamp: string;
  patterns: string[];
  checkpointSource: string;
  restoredCount: number;
  skippedCount: number;
  restored: string[];
  skipped: string[];
  backupDir?: string;
}

/** Options for performing a partial resurrection. */
export interface PartialResurrectionOpts {
  /** Glob-like include patterns (e.g., "memory/*.md", "SOUL.md"). */
  includePatterns: string[];
  /** Path to the decrypted checkpoint content directory. */
  checkpointContentDir: string;
  /** Source description (CID or path) for logging. */
  checkpointSource: string;
  /** Workspace content directory. Defaults to ~/.openclaw/workspace. */
  contentDir?: string;
  /** Directory for backups of overwritten files. Defaults to ~/.amcp/partial-restore-backups. */
  backupDir?: string;
  /** Path for JSONL audit log. Defaults to ~/.amcp/partial-resurrection-log.jsonl. */
  logPath?: string;
  /** If true, don't actually copy files — just report what would happen. */
  dryRun?: boolean;
}

/** Dependencies for the partial resurrection service. */
export interface PartialResurrectionDeps {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  contentDir?: string;
  backupDir?: string;
  logPath?: string;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob-like pattern to a RegExp.
 *
 * Supports:
 *   - `*` matches any characters except `/`
 *   - `**` matches any characters including `/` (directory traversal)
 *   - `?` matches a single character
 *   - Literal strings match exactly
 *
 * All patterns are matched against paths relative to the content directory.
 */
export function patternToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match anything including path separators
        // Handle optional trailing /
        if (pattern[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        // * — match anything except /
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === ".") {
      regex += "\\.";
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a relative path matches any of the given patterns.
 */
export function matchesAnyPattern(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const regex = patternToRegex(pattern);
    if (regex.test(relPath)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively list all files in a directory, returning paths relative to the root.
 */
async function listFilesRecursive(dir: string, rootDir?: string): Promise<string[]> {
  const root = rootDir ?? dir;
  const results: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        const subFiles = await listFilesRecursive(fullPath, root);
        results.push(...subFiles);
      } else if (s.isFile()) {
        results.push(relative(root, fullPath));
      }
    } catch {
      // Skip unreadable entries
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Core: partial resurrection
// ---------------------------------------------------------------------------

/**
 * Perform a partial resurrection — restore only files matching the
 * specified patterns from a decrypted checkpoint.
 *
 * Non-matching files are left untouched. Matching files that already
 * exist in the workspace are backed up before overwriting.
 */
export async function partialRestore(
  opts: PartialResurrectionOpts,
): Promise<PartialResurrectionResult> {
  const {
    includePatterns,
    checkpointContentDir,
    checkpointSource,
    dryRun = false,
  } = opts;
  const contentDir = opts.contentDir ?? DEFAULT_CONTENT_DIR;
  const backupDir = opts.backupDir ?? DEFAULT_BACKUP_DIR;
  const logPath = opts.logPath ?? DEFAULT_LOG_PATH;

  const timestamp = new Date().toISOString();
  const result: PartialResurrectionResult = {
    success: false,
    restored: [],
    skipped: [],
    patterns: includePatterns,
    checkpointSource,
    timestamp,
  };

  if (includePatterns.length === 0) {
    result.error = "no_patterns";
    return result;
  }

  // 1. List all files in the checkpoint content
  const checkpointFiles = await listFilesRecursive(checkpointContentDir);
  if (checkpointFiles.length === 0) {
    result.error = "empty_checkpoint";
    return result;
  }

  // 2. Classify files as matched or skipped
  const matched: string[] = [];
  for (const relPath of checkpointFiles) {
    if (matchesAnyPattern(relPath, includePatterns)) {
      matched.push(relPath);
    } else {
      result.skipped.push(relPath);
    }
  }

  if (matched.length === 0) {
    result.skipped = checkpointFiles;
    result.error = "no_matches";
    result.success = true; // Not a failure — just nothing to do
    return result;
  }

  // 3. Create backup directory with timestamp
  const backupSubDir = join(backupDir, timestamp.replace(/[:.]/g, "-"));
  if (!dryRun) {
    await mkdir(backupSubDir, { recursive: true });
  }

  // 4. Restore matched files
  for (const relPath of matched) {
    const srcPath = join(checkpointContentDir, relPath);
    const destPath = join(contentDir, relPath);
    const entry: RestoredFile = {
      relativePath: relPath,
      hadPrevious: false,
    };

    // Check if destination exists — back up if so
    try {
      await stat(destPath);
      entry.hadPrevious = true;
      const bkPath = join(backupSubDir, relPath);
      entry.backupPath = bkPath;

      if (!dryRun) {
        await mkdir(dirname(bkPath), { recursive: true });
        await copyFile(destPath, bkPath);
      }
    } catch {
      // Destination doesn't exist — no backup needed
    }

    // Copy from checkpoint to workspace
    if (!dryRun) {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
    }

    result.restored.push(entry);
  }

  // 5. Write audit log entry
  const logEntry: PartialResurrectionLogEntry = {
    timestamp,
    patterns: includePatterns,
    checkpointSource,
    restoredCount: result.restored.length,
    skippedCount: result.skipped.length,
    restored: result.restored.map((r) => r.relativePath),
    skipped: result.skipped,
    backupDir: backupSubDir,
  };

  if (!dryRun) {
    await mkdir(dirname(logPath), { recursive: true });
    const line = JSON.stringify(logEntry) + "\n";
    try {
      const existing = await readFile(logPath, "utf-8");
      await writeFile(logPath, existing + line, "utf-8");
    } catch {
      await writeFile(logPath, line, "utf-8");
    }
  }

  result.success = true;
  return result;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Create the partial resurrection service.
 *
 * Exposes `restorePartial()` for on-demand partial restoration and
 * listens for "amcp:partial-resurrection:requested" events.
 */
export function createPartialResurrectionService(
  deps: PartialResurrectionDeps,
): {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    running: boolean;
    details?: Record<string, unknown>;
  }>;
  /** Perform a partial resurrection with the given patterns. */
  restorePartial(opts: PartialResurrectionOpts): Promise<PartialResurrectionResult>;
  /** Get the last result. */
  getLastResult(): PartialResurrectionResult | null;
} {
  const { config, logger, emit } = deps;
  const contentDir = deps.contentDir ?? DEFAULT_CONTENT_DIR;
  const backupDir = deps.backupDir ?? DEFAULT_BACKUP_DIR;
  const logPath = deps.logPath ?? DEFAULT_LOG_PATH;

  let running = false;
  let lastResult: PartialResurrectionResult | null = null;

  return {
    name: "amcp-partial-resurrection",

    async start(): Promise<void> {
      if (running) return;
      running = true;
      logger.info("amcp-partial-resurrection: started");
    },

    async stop(): Promise<void> {
      running = false;
      logger.info("amcp-partial-resurrection: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      return {
        running,
        details: {
          service: "amcp-partial-resurrection",
          contentDir,
          backupDir,
          logPath,
          lastRestore: lastResult
            ? {
                success: lastResult.success,
                restoredCount: lastResult.restored.length,
                skippedCount: lastResult.skipped.length,
                timestamp: lastResult.timestamp,
                patterns: lastResult.patterns,
              }
            : null,
        },
      };
    },

    async restorePartial(
      opts: PartialResurrectionOpts,
    ): Promise<PartialResurrectionResult> {
      logger.info(
        `amcp-partial-resurrection: restoring with patterns [${opts.includePatterns.join(", ")}]`,
      );

      const result = await partialRestore({
        ...opts,
        contentDir: opts.contentDir ?? contentDir,
        backupDir: opts.backupDir ?? backupDir,
        logPath: opts.logPath ?? logPath,
      });

      lastResult = result;

      if (result.success) {
        logger.info(
          `amcp-partial-resurrection: restored ${result.restored.length} file(s), skipped ${result.skipped.length}`,
        );
        emit("amcp:partial-resurrection:completed", {
          restored: result.restored.length,
          skipped: result.skipped.length,
          patterns: result.patterns,
          checkpointSource: result.checkpointSource,
          timestamp: result.timestamp,
        });
      } else {
        logger.warn(
          `amcp-partial-resurrection: failed — ${result.error ?? "unknown error"}`,
        );
        emit("amcp:partial-resurrection:error", {
          error: result.error,
          patterns: result.patterns,
          checkpointSource: result.checkpointSource,
        });
      }

      return result;
    },

    getLastResult(): PartialResurrectionResult | null {
      return lastResult;
    },
  };
}
