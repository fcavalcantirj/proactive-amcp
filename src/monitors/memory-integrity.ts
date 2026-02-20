/**
 * Memory Integrity Monitor — baseline hashing of memory files.
 *
 * Hashes all memory files (SOUL.md, MEMORY.md, memory/*.md) and stores
 * a baseline in ~/.amcp/memory-baseline.json. On each poll, compares
 * current hashes to baseline. On valid checkpoint events, updates the
 * baseline with current hashes.
 *
 * Part of P4-MEM-01: Create baseline of memory file hashes.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
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

export interface MemoryIntegrityDeps {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  /** Directory containing memory files (SOUL.md, MEMORY.md, memory/). */
  contentDir: string;
  /** Path to store baseline JSON. */
  baselinePath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONTENT_DIR = join(homedir(), ".openclaw", "workspace");
const DEFAULT_BASELINE_PATH = join(homedir(), ".amcp", "memory-baseline.json");

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
// Plugin Service
// ---------------------------------------------------------------------------

/**
 * Create the memory integrity monitor service.
 *
 * On start: creates baseline if none exists, or loads existing.
 * On checkpoint events: updates baseline with current hashes.
 * Exposes createBaseline/compare for use by other P4-MEM tasks.
 */
export function createMemoryIntegrityMonitor(
  deps: MemoryIntegrityDeps,
): PluginService & {
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
} {
  const { config, logger, emit, contentDir, baselinePath } = deps;
  let baseline: MemoryBaseline | null = null;
  let running = false;

  return {
    name: "amcp-memory-integrity",

    getBaseline() {
      return baseline;
    },

    async refreshBaseline(): Promise<MemoryBaseline> {
      baseline = await createBaseline(contentDir);
      baseline.updatedAt = new Date().toISOString();
      await saveBaseline(baselinePath, baseline);
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
      } else {
        baseline = await createBaseline(contentDir);
        await saveBaseline(baselinePath, baseline);
        logger.info(
          `amcp-memory-integrity: created baseline — ${Object.keys(baseline.files).length} file(s)`,
        );
        emit("amcp:memory:baseline_created", {
          fileCount: Object.keys(baseline.files).length,
          files: Object.keys(baseline.files),
        });
      }
    },

    async stop() {
      running = false;
      logger.info("amcp-memory-integrity: stopped");
    },

    async status() {
      return {
        running,
        details: {
          service: "amcp-memory-integrity",
          baselinePath,
          contentDir,
          fileCount: baseline ? Object.keys(baseline.files).length : 0,
          hasBaseline: baseline !== null,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Defaults export for index.ts wiring
// ---------------------------------------------------------------------------

export { DEFAULT_CONTENT_DIR, DEFAULT_BASELINE_PATH };
