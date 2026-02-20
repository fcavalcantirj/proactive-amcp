/**
 * Memory Auto-Restore — quarantine tampered files and restore from clean snapshot.
 *
 * When the memory integrity monitor detects unauthorized changes and
 * `autoRestore` is enabled, this module:
 *   1. Quarantines the tampered files to ~/.amcp/quarantine/<timestamp>/
 *   2. Restores original content from the clean snapshot (saved alongside baseline)
 *   3. Logs every restore action with reason to ~/.amcp/restore-log.jsonl
 *   4. Emits amcp:memory:auto_restored event
 *
 * P4-MEM-04: Auto-restore from checkpoint on tampering detection.
 *
 * The "clean snapshot" is a directory of file copies created each time
 * the baseline is updated (on valid checkpoint or initial baseline creation).
 * This avoids needing to decrypt IPFS checkpoints for fast local restore.
 */

import {
  readFile,
  writeFile,
  copyFile,
  rename,
  mkdir,
  stat,
  appendFile,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single file that was quarantined and restored. */
export interface RestoredFileEntry {
  /** Relative path within the content directory. */
  relativePath: string;
  /** Where the tampered file was moved to. */
  quarantinePath: string;
  /** Whether restore succeeded (snapshot existed). */
  restored: boolean;
  /** Reason for quarantine. */
  reason: "modified" | "added";
}

/** Result of an auto-restore operation. */
export interface AutoRestoreResult {
  /** ISO-8601 timestamp of the operation. */
  timestamp: string;
  /** Files that were quarantined and restored. */
  files: RestoredFileEntry[];
  /** Files that were removed externally (cannot quarantine, noted for logging). */
  removedFiles: string[];
  /** Number of files successfully restored from snapshot. */
  restoredCount: number;
  /** Number of files quarantined but not restored (no snapshot available). */
  quarantinedOnlyCount: number;
  /** Whether the operation completed without errors. */
  success: boolean;
  /** Error message if the operation failed. */
  error?: string;
}

/** Log entry appended to the restore log (JSONL). */
export interface RestoreLogEntry {
  timestamp: string;
  action: "auto_restore";
  filesRestored: string[];
  filesQuarantinedOnly: string[];
  removedFiles: string[];
  quarantineDir: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_QUARANTINE_DIR = join(homedir(), ".amcp", "quarantine");
const DEFAULT_RESTORE_LOG_PATH = join(homedir(), ".amcp", "restore-log.jsonl");
const DEFAULT_SNAPSHOT_DIR = join(homedir(), ".amcp", "memory-snapshot");

// ---------------------------------------------------------------------------
// Snapshot Management
// ---------------------------------------------------------------------------

/**
 * Save a clean snapshot of a memory file.
 *
 * Called when a baseline is created/updated so that the auto-restore
 * has a local copy to restore from without decrypting IPFS checkpoints.
 */
export async function saveSnapshot(
  contentDir: string,
  relativePath: string,
  snapshotDir?: string,
): Promise<void> {
  const snapDir = snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const srcPath = join(contentDir, relativePath);
  const destPath = join(snapDir, relativePath);

  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(srcPath, destPath);
}

/**
 * Save snapshots for all files in a baseline.
 * Called during baseline creation/update.
 */
export async function saveAllSnapshots(
  contentDir: string,
  filePaths: string[],
  snapshotDir?: string,
): Promise<void> {
  const snapDir = snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  for (const relPath of filePaths) {
    try {
      await saveSnapshot(contentDir, relPath, snapDir);
    } catch {
      // File may have disappeared — skip
    }
  }
}

/**
 * Check if a snapshot exists for a given file.
 */
export async function hasSnapshot(
  relativePath: string,
  snapshotDir?: string,
): Promise<boolean> {
  const snapDir = snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  try {
    const s = await stat(join(snapDir, relativePath));
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Remove a snapshot (e.g. when a file is legitimately removed).
 */
export async function removeSnapshot(
  relativePath: string,
  snapshotDir?: string,
): Promise<void> {
  const snapDir = snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  try {
    await rm(join(snapDir, relativePath));
  } catch {
    // Already gone — fine
  }
}

// ---------------------------------------------------------------------------
// Quarantine + Restore
// ---------------------------------------------------------------------------

/**
 * Quarantine a tampered file by moving it to the quarantine directory.
 * The file is moved (not copied) so the workspace has no tampered version.
 */
async function quarantineFile(
  contentDir: string,
  relativePath: string,
  quarantineSubDir: string,
): Promise<string> {
  const srcPath = join(contentDir, relativePath);
  const destPath = join(quarantineSubDir, relativePath);

  await mkdir(dirname(destPath), { recursive: true });
  // Copy then remove (rename fails across filesystems)
  await copyFile(srcPath, destPath);
  await rm(srcPath);

  return destPath;
}

/**
 * Restore a file from the clean snapshot.
 */
async function restoreFromSnapshot(
  contentDir: string,
  relativePath: string,
  snapshotDir: string,
): Promise<boolean> {
  const snapshotPath = join(snapshotDir, relativePath);
  const destPath = join(contentDir, relativePath);

  try {
    await stat(snapshotPath);
  } catch {
    return false; // No snapshot available
  }

  await mkdir(dirname(destPath), { recursive: true });
  await copyFile(snapshotPath, destPath);
  return true;
}

/**
 * Perform auto-restore: quarantine tampered files and restore from snapshot.
 *
 * @param contentDir     Directory containing the memory files.
 * @param changed        Files that were modified (relative paths).
 * @param added          Files that were added externally (relative paths).
 * @param removed        Files that were removed externally (relative paths).
 * @param snapshotDir    Directory containing clean file snapshots.
 * @param quarantineDir  Base directory for quarantine storage.
 * @param restoreLogPath Path for the JSONL restore log.
 * @param logger         Plugin logger for messages.
 */
export async function autoRestore(
  contentDir: string,
  changed: string[],
  added: string[],
  removed: string[],
  snapshotDir?: string,
  quarantineDir?: string,
  restoreLogPath?: string,
  logger?: PluginLogger,
): Promise<AutoRestoreResult> {
  const snapDir = snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const qDir = quarantineDir ?? DEFAULT_QUARANTINE_DIR;
  const logPath = restoreLogPath ?? DEFAULT_RESTORE_LOG_PATH;
  const timestamp = new Date().toISOString();

  // Create a timestamped quarantine subdirectory
  const qSubDir = join(qDir, timestamp.replace(/[:.]/g, "-"));
  await mkdir(qSubDir, { recursive: true });

  const result: AutoRestoreResult = {
    timestamp,
    files: [],
    removedFiles: removed,
    restoredCount: 0,
    quarantinedOnlyCount: 0,
    success: true,
  };

  // 1. Quarantine + restore MODIFIED files
  for (const relPath of changed) {
    try {
      const quarantinePath = await quarantineFile(contentDir, relPath, qSubDir);
      const restored = await restoreFromSnapshot(contentDir, relPath, snapDir);

      const entry: RestoredFileEntry = {
        relativePath: relPath,
        quarantinePath,
        restored,
        reason: "modified",
      };
      result.files.push(entry);

      if (restored) {
        result.restoredCount++;
        logger?.info(
          `amcp-auto-restore: restored ${relPath} from snapshot (tampered version quarantined)`,
        );
      } else {
        result.quarantinedOnlyCount++;
        logger?.warn(
          `amcp-auto-restore: quarantined ${relPath} but no snapshot available for restore`,
        );
      }
    } catch (err) {
      logger?.error(
        `amcp-auto-restore: failed to process ${relPath} — ${String(err)}`,
      );
      result.success = false;
      result.error = `Failed to process ${relPath}: ${String(err)}`;
    }
  }

  // 2. Quarantine ADDED files (not part of baseline — should not exist)
  for (const relPath of added) {
    try {
      const quarantinePath = await quarantineFile(contentDir, relPath, qSubDir);

      const entry: RestoredFileEntry = {
        relativePath: relPath,
        quarantinePath,
        restored: false,
        reason: "added",
      };
      result.files.push(entry);
      result.quarantinedOnlyCount++;

      logger?.info(
        `amcp-auto-restore: quarantined externally added file ${relPath}`,
      );
    } catch (err) {
      logger?.error(
        `amcp-auto-restore: failed to quarantine ${relPath} — ${String(err)}`,
      );
    }
  }

  // 3. Restore REMOVED files from snapshot (if available)
  for (const relPath of removed) {
    try {
      const restored = await restoreFromSnapshot(contentDir, relPath, snapDir);
      if (restored) {
        result.restoredCount++;
        logger?.info(
          `amcp-auto-restore: restored removed file ${relPath} from snapshot`,
        );
      } else {
        logger?.warn(
          `amcp-auto-restore: file ${relPath} was removed but no snapshot available`,
        );
      }
    } catch (err) {
      logger?.error(
        `amcp-auto-restore: failed to restore ${relPath} — ${String(err)}`,
      );
    }
  }

  // 4. Log restore action
  const logEntry: RestoreLogEntry = {
    timestamp,
    action: "auto_restore",
    filesRestored: result.files
      .filter((f) => f.restored)
      .map((f) => f.relativePath),
    filesQuarantinedOnly: result.files
      .filter((f) => !f.restored)
      .map((f) => f.relativePath),
    removedFiles: removed,
    quarantineDir: qSubDir,
    reason: `Unauthorized changes detected: ${changed.length} modified, ${added.length} added, ${removed.length} removed`,
  };

  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(logEntry) + "\n", "utf-8");
  } catch (err) {
    logger?.error(
      `amcp-auto-restore: failed to write restore log — ${String(err)}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  DEFAULT_QUARANTINE_DIR,
  DEFAULT_RESTORE_LOG_PATH,
  DEFAULT_SNAPSHOT_DIR,
};
