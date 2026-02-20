/**
 * CLI Checkpoint Command — 'openclaw amcp checkpoint'
 *
 * Manual checkpoint trigger that delegates to the bash checkpoint engine
 * (full-checkpoint.sh). Shows progress via log output and reports the
 * resulting CID on completion.
 *
 * P4-CLI-02: Register 'amcp checkpoint' CLI command with real execution.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { constants } from "node:fs";
import type { PluginLogger, AmcpPluginConfig } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a checkpoint execution. */
export interface CheckpointResult {
  success: boolean;
  cid: string | null;
  localPath: string | null;
  secretCount: number | null;
  size: string | null;
  dryRun: boolean;
  output: string;
  error: string | null;
}

/** Dependencies injected by the plugin registration layer. */
export interface CheckpointCommandDeps {
  logger: PluginLogger;
  config: AmcpPluginConfig;
  lastCheckpointPath: string;
  /** Path to the scripts directory containing full-checkpoint.sh. */
  scriptDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to full-checkpoint.sh from the script directory.
 */
function resolveCheckpointScript(scriptDir: string): string {
  return join(scriptDir, "full-checkpoint.sh");
}

/**
 * Parse checkpoint output for the CID line.
 * Looks for patterns like:
 *   CID: bafkrei...
 *   Pinata: Qm...
 *   Solvr: bafkrei...
 */
function parseCidFromOutput(output: string): string | null {
  // Try the final summary CID line first
  const cidLine = output.match(/^CID:\s+(\S+)/m);
  if (cidLine && cidLine[1] !== "'(local" && cidLine[1] !== "(local") {
    return cidLine[1];
  }

  // Try pinned CID
  const pinnedLine = output.match(/^\s+CID:\s+(\S+)/m);
  if (pinnedLine) {
    return pinnedLine[1];
  }

  // Try Pinata/Solvr lines
  const providerLine = output.match(/(?:Pinata|Solvr):\s+(\S+)/m);
  if (providerLine) {
    return providerLine[1];
  }

  return null;
}

/**
 * Parse secret count from checkpoint output.
 * Looks for: "Found N secrets" or "Would checkpoint N secrets"
 */
function parseSecretCount(output: string): number | null {
  const match = output.match(
    /(?:Found|Would checkpoint)\s+(\d+)\s+secret/i,
  );
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse checkpoint size from output.
 * Looks for: "Size: 42M" in the final summary block.
 */
function parseSize(output: string): string | null {
  const match = output.match(/^Size:\s+(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Parse local checkpoint path from output.
 * Looks for: "Path: /home/.../.amcp/checkpoints/..."
 */
function parseLocalPath(output: string): string | null {
  const match = output.match(/^Path:\s+(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Read the last checkpoint file to get CID after successful checkpoint.
 * This is more reliable than parsing stdout because the script writes it
 * as structured JSON.
 */
async function readLastCheckpoint(
  lastCheckpointPath: string,
): Promise<{ cid: string | null; secretCount: number | null; size: string | null; localPath: string | null }> {
  try {
    const content = await readFile(lastCheckpointPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    const cid =
      (typeof data.cid === "string" && data.cid) ||
      (typeof data.pinataCid === "string" && data.pinataCid) ||
      (typeof data.solvrCid === "string" && data.solvrCid) ||
      null;
    const secretCount =
      typeof data.secretCount === "number" ? data.secretCount : null;
    const size =
      typeof data.checkpointSize === "string" ? data.checkpointSize : null;
    const localPath =
      typeof data.localPath === "string" ? data.localPath : null;

    return { cid, secretCount, size, localPath };
  } catch {
    return { cid: null, secretCount: null, size: null, localPath: null };
  }
}

// ---------------------------------------------------------------------------
// Core: run checkpoint
// ---------------------------------------------------------------------------

/**
 * Execute a checkpoint via the bash engine.
 *
 * Delegates to `full-checkpoint.sh` with appropriate flags, captures output,
 * and parses the result for CID and metadata.
 */
export async function runCheckpoint(
  deps: CheckpointCommandDeps,
  options: {
    dryRun?: boolean;
    force?: boolean;
    smart?: boolean;
    notify?: boolean;
    skipEvolution?: boolean;
  } = {},
): Promise<CheckpointResult> {
  const scriptPath = resolveCheckpointScript(deps.scriptDir);

  // Verify script exists
  try {
    await access(scriptPath, constants.R_OK);
  } catch {
    return {
      success: false,
      cid: null,
      localPath: null,
      secretCount: null,
      size: null,
      dryRun: options.dryRun ?? false,
      output: "",
      error: `Checkpoint script not found: ${scriptPath}`,
    };
  }

  // Build args
  const args: string[] = [];
  if (options.dryRun) args.push("--dry-run");
  if (options.force) args.push("--force");
  if (options.smart) args.push("--smart");
  if (options.notify) args.push("--notify");
  if (options.skipEvolution) args.push("--skip-evolution");

  const dryRun = options.dryRun ?? false;

  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath, ...args], {
      timeout: 300_000, // 5 minute timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const output = stdout + (stderr ? `\n${stderr}` : "");

    if (dryRun) {
      // For dry-run, parse what would be included from the output
      const secretCount = parseSecretCount(output);
      return {
        success: true,
        cid: null,
        localPath: null,
        secretCount,
        size: parseSize(output) ?? parseDryRunSize(output),
        dryRun: true,
        output,
        error: null,
      };
    }

    // For real checkpoint, prefer reading the structured last-checkpoint.json
    const checkpointInfo = await readLastCheckpoint(deps.lastCheckpointPath);
    const cidFromOutput = parseCidFromOutput(output);

    return {
      success: true,
      cid: checkpointInfo.cid ?? cidFromOutput,
      localPath: checkpointInfo.localPath ?? parseLocalPath(output),
      secretCount: checkpointInfo.secretCount ?? parseSecretCount(output),
      size: checkpointInfo.size ?? parseSize(output),
      dryRun: false,
      output,
      error: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const output = (err as { stdout?: string })?.stdout ?? "";
    return {
      success: false,
      cid: null,
      localPath: null,
      secretCount: null,
      size: null,
      dryRun,
      output: typeof output === "string" ? output : "",
      error: message,
    };
  }
}

/**
 * Parse dry-run content size from "Would checkpoint N secrets and SIZE of content".
 */
function parseDryRunSize(output: string): string | null {
  const match = output.match(/Would checkpoint\s+\d+\s+secrets\s+and\s+(\S+)/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format checkpoint result as human-readable text.
 */
export function formatCheckpointResult(result: CheckpointResult): string {
  const lines: string[] = [];

  if (result.dryRun) {
    lines.push("=== Checkpoint Dry Run ===");
    lines.push("");
    if (result.secretCount !== null) {
      lines.push(`Secrets to include: ${result.secretCount}`);
    }
    if (result.size) {
      lines.push(`Content size: ${result.size}`);
    }
    lines.push("");
    lines.push("No checkpoint was created (dry-run mode).");
  } else if (result.success) {
    lines.push("=== Checkpoint Complete ===");
    lines.push("");
    if (result.cid) {
      lines.push(`CID:     ${result.cid}`);
    } else {
      lines.push("CID:     (local only — no IPFS pinning configured or available)");
    }
    if (result.localPath) {
      lines.push(`Path:    ${result.localPath}`);
    }
    if (result.secretCount !== null) {
      lines.push(`Secrets: ${result.secretCount}`);
    }
    if (result.size) {
      lines.push(`Size:    ${result.size}`);
    }
  } else {
    lines.push("=== Checkpoint Failed ===");
    lines.push("");
    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command handler factory
// ---------------------------------------------------------------------------

/**
 * Create the 'amcp checkpoint' CLI command handler.
 *
 * Supports flags:
 *   --dry-run         Show what would be included without creating a checkpoint
 *   --force           Force checkpoint even if cleartext secrets detected
 *   --smart           Use Groq for intelligent content selection
 *   --notify          Send notification on completion
 *   --skip-evolution  Skip memory evolution step
 *   --json            Output result as JSON
 */
export function createCheckpointHandler(
  deps: CheckpointCommandDeps,
): (args: string[]) => Promise<void> {
  return async (args: string[]) => {
    const jsonMode = args.includes("--json");
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");
    const smart = args.includes("--smart");
    const notify = args.includes("--notify");
    const skipEvolution = args.includes("--skip-evolution");

    deps.logger.info(
      `amcp checkpoint: ${dryRun ? "dry-run" : "creating"}${smart ? " (smart)" : ""}...`,
    );

    const result = await runCheckpoint(deps, {
      dryRun,
      force,
      smart,
      notify,
      skipEvolution,
    });

    if (jsonMode) {
      deps.logger.info(JSON.stringify(result, null, 2));
    } else {
      const formatted = formatCheckpointResult(result);
      deps.logger.info(formatted);

      // Log progress lines from the bash script output for visibility
      if (result.output) {
        const stageLines = result.output
          .split("\n")
          .filter((l) => l.startsWith("===") || l.includes("Pinned to IPFS"));
        for (const line of stageLines) {
          deps.logger.debug(line);
        }
      }
    }
  };
}
