/**
 * CLI History Command — 'openclaw amcp history'
 *
 * Lists recent checkpoints with CID, timestamp, and trigger reason.
 * Reads from checkpoint-log.jsonl (trigger log) and last-checkpoint.json.
 *
 * P4-CLI-05: Register 'amcp history' CLI command with checkpoint log reading.
 */

import { readFile } from "node:fs/promises";
import type { PluginLogger, AmcpPluginConfig, CheckpointLogEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single history entry combining checkpoint log data with optional CID. */
export interface HistoryEntry {
  timestamp: string;
  trigger: string;
  contextPercent: number;
  usedTokens: number;
  maxTokens: number;
  cooldownMs: number;
  cid: string | null;
}

/** Result of the history command — structured for display or JSON output. */
export interface HistoryResult {
  success: boolean;
  entries: HistoryEntry[];
  total: number;
  showing: number;
  error: string | null;
}

/** Dependencies injected by the plugin registration layer. */
export interface HistoryCommandDeps {
  logger: PluginLogger;
  config: AmcpPluginConfig;
  checkpointLogPath: string;
  lastCheckpointPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load all entries from the checkpoint-log.jsonl file.
 * Returns entries in file order (oldest first).
 */
async function loadCheckpointLog(
  logPath: string,
): Promise<CheckpointLogEntry[]> {
  try {
    const content = await readFile(logPath, "utf-8");
    const entries: CheckpointLogEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          entries.push(JSON.parse(trimmed) as CheckpointLogEntry);
        } catch {
          // Skip malformed lines
        }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Load the last checkpoint metadata for CID enrichment.
 */
async function loadLastCheckpoint(
  lastCheckpointPath: string,
): Promise<{ cid: string | null; timestamp: string | null }> {
  try {
    const content = await readFile(lastCheckpointPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    const cid =
      (typeof data.cid === "string" && data.cid) ||
      (typeof data.pinataCid === "string" && data.pinataCid) ||
      (typeof data.solvrCid === "string" && data.solvrCid) ||
      null;
    const timestamp =
      typeof data.timestamp === "string" ? data.timestamp : null;

    return { cid, timestamp };
  } catch {
    return { cid: null, timestamp: null };
  }
}

/**
 * Convert CheckpointLogEntry[] to HistoryEntry[], enriching the most recent
 * entry with CID from last-checkpoint.json if timestamps match.
 */
function enrichEntries(
  logEntries: CheckpointLogEntry[],
  lastCheckpoint: { cid: string | null; timestamp: string | null },
): HistoryEntry[] {
  return logEntries.map((entry) => {
    // Try to match last checkpoint CID to entry by timestamp
    let cid: string | null = null;
    if (lastCheckpoint.cid && lastCheckpoint.timestamp === entry.timestamp) {
      cid = lastCheckpoint.cid;
    }

    return {
      timestamp: entry.timestamp,
      trigger: entry.trigger,
      contextPercent: entry.contextPercent,
      usedTokens: entry.usedTokens,
      maxTokens: entry.maxTokens,
      cooldownMs: entry.cooldownMs,
      cid,
    };
  });
}

/**
 * Extract a named argument value from the args array.
 * Returns undefined if flag is not found or has no value after it.
 */
function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Core: run history query
// ---------------------------------------------------------------------------

/**
 * Gather checkpoint history from the log file and last-checkpoint.json.
 *
 * Returns entries in reverse chronological order (newest first).
 * The `limit` option controls how many entries to return (default: 10).
 */
export async function runHistory(
  deps: HistoryCommandDeps,
  options: { limit?: number } = {},
): Promise<HistoryResult> {
  const limit = options.limit ?? 10;

  try {
    const [logEntries, lastCheckpoint] = await Promise.all([
      loadCheckpointLog(deps.checkpointLogPath),
      loadLastCheckpoint(deps.lastCheckpointPath),
    ]);

    const enriched = enrichEntries(logEntries, lastCheckpoint);

    // Reverse to show newest first
    const reversed = [...enriched].reverse();

    // Apply limit
    const limited = reversed.slice(0, limit);

    return {
      success: true,
      entries: limited,
      total: enriched.length,
      showing: limited.length,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      entries: [],
      total: 0,
      showing: 0,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a trigger string for display (replace underscores, title case).
 */
function formatTrigger(trigger: string): string {
  return trigger.replace(/_/g, " ");
}

/**
 * Format a timestamp for human-readable display.
 * Shows date + time, e.g. "2025-01-20 10:30:00".
 */
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  } catch {
    return iso;
  }
}

/**
 * Format the history result as human-readable text for CLI output.
 */
export function formatHistoryResult(result: HistoryResult): string {
  const lines: string[] = [];

  if (!result.success) {
    lines.push("=== Checkpoint History ===");
    lines.push("");
    lines.push(`Error: ${result.error}`);
    return lines.join("\n");
  }

  if (result.total === 0) {
    lines.push("=== Checkpoint History ===");
    lines.push("");
    lines.push("No checkpoints recorded yet.");
    return lines.join("\n");
  }

  lines.push("=== Checkpoint History ===");
  lines.push("");
  lines.push(
    `Showing ${result.showing} of ${result.total} checkpoint${result.total !== 1 ? "s" : ""}`,
  );
  lines.push("");

  // Table header
  const header = padRow("Timestamp", "Trigger", "Context %", "CID");
  const separator = padRow(
    "-------------------",
    "-------------------------",
    "---------",
    "----",
  );
  lines.push(header);
  lines.push(separator);

  for (const entry of result.entries) {
    const ts = formatTimestamp(entry.timestamp);
    const trigger = formatTrigger(entry.trigger);
    const ctx = `${entry.contextPercent}%`;
    const cid = entry.cid ? truncateCid(entry.cid) : "-";
    lines.push(padRow(ts, trigger, ctx, cid));
  }

  return lines.join("\n");
}

/**
 * Truncate a CID for display (first 12 + last 4 chars with ... in between).
 */
function truncateCid(cid: string): string {
  if (cid.length <= 20) return cid;
  return `${cid.slice(0, 12)}...${cid.slice(-4)}`;
}

/**
 * Pad columns for table output.
 */
function padRow(
  timestamp: string,
  trigger: string,
  contextPct: string,
  cid: string,
): string {
  return [
    timestamp.padEnd(24),
    trigger.padEnd(28),
    contextPct.padEnd(12),
    cid,
  ].join("");
}

// ---------------------------------------------------------------------------
// Command handler factory
// ---------------------------------------------------------------------------

/**
 * Create the 'amcp history' CLI command handler.
 *
 * Supports flags:
 *   --limit N    Number of entries to show (default: 10)
 *   --json       Output result as JSON
 */
export function createHistoryHandler(
  deps: HistoryCommandDeps,
): (args: string[]) => Promise<void> {
  return async (args: string[]) => {
    const jsonMode = args.includes("--json");
    const limitStr = extractArg(args, "--limit");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    if (limitStr !== undefined && (limit === undefined || isNaN(limit) || limit < 1)) {
      deps.logger.error("amcp history: --limit must be a positive integer");
      return;
    }

    const result = await runHistory(deps, { limit });

    if (jsonMode) {
      deps.logger.info(JSON.stringify(result, null, 2));
    } else {
      const formatted = formatHistoryResult(result);
      deps.logger.info(formatted);
    }
  };
}
