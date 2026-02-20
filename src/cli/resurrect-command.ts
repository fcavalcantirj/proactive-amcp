/**
 * CLI Resurrect Command — 'openclaw amcp resurrect'
 *
 * Manual resurrection from checkpoint. Delegates to the bash resuscitate.sh
 * engine, which handles IPFS fetch, decryption, file restoration, and
 * secret injection.
 *
 * P4-CLI-03: Register 'amcp resurrect' CLI command with real execution.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import type { PluginLogger, AmcpPluginConfig } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a resurrection execution. */
export interface ResurrectResult {
  success: boolean;
  cid: string | null;
  tier: number | null;
  filesRestored: number | null;
  secretsInjected: number | null;
  output: string;
  error: string | null;
}

/** Dependencies injected by the plugin registration layer. */
export interface ResurrectCommandDeps {
  logger: PluginLogger;
  config: AmcpPluginConfig;
  lastCheckpointPath: string;
  /** Path to the scripts directory containing resuscitate.sh. */
  scriptDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the path to resuscitate.sh from the script directory.
 */
function resolveResurrectScript(scriptDir: string): string {
  return join(scriptDir, "resuscitate.sh");
}

/**
 * Parse the recovery tier from resuscitate.sh output.
 * Looks for: "Tier 1:", "Tier 2:", "Tier 3:", or "=== TIER N ==="
 */
function parseTier(output: string): number | null {
  // Look for the highest tier reached
  const tierMatches = output.matchAll(/(?:Tier|TIER)\s+(\d)/g);
  let highestTier: number | null = null;
  for (const match of tierMatches) {
    const tier = parseInt(match[1], 10);
    if (highestTier === null || tier > highestTier) {
      highestTier = tier;
    }
  }
  return highestTier;
}

/**
 * Parse the number of restored files from resuscitate.sh output.
 * Looks for: "Restored N files" or "N files restored"
 */
function parseFilesRestored(output: string): number | null {
  const match = output.match(/(?:Restored|restored)\s+(\d+)\s+file/i)
    ?? output.match(/(\d+)\s+files?\s+restored/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse the number of injected secrets from resuscitate.sh output.
 * Looks for: "Injected N secrets" or "N secrets injected"
 */
function parseSecretsInjected(output: string): number | null {
  const match = output.match(/(?:Injected|injected)\s+(\d+)\s+secret/i)
    ?? output.match(/(\d+)\s+secrets?\s+injected/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse CID from resuscitate.sh output.
 * Looks for: "from CID: bafkrei..." or "Fetching checkpoint: bafkrei..."
 */
function parseCidFromOutput(output: string): string | null {
  const match = output.match(/(?:from CID|Fetching checkpoint|CID):\s+(\S+)/i);
  return match ? match[1] : null;
}

/**
 * Read the latest checkpoint CID from last-checkpoint.json.
 */
async function readLatestCid(
  lastCheckpointPath: string,
): Promise<string | null> {
  try {
    const content = await readFile(lastCheckpointPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    return (
      (typeof data.cid === "string" && data.cid) ||
      (typeof data.pinataCid === "string" && data.pinataCid) ||
      (typeof data.solvrCid === "string" && data.solvrCid) ||
      null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core: run resurrection
// ---------------------------------------------------------------------------

/**
 * Execute a resurrection via the bash engine.
 *
 * Delegates to `resuscitate.sh` with appropriate flags, captures output,
 * and parses the result for tier, files restored, and secrets injected.
 */
export async function runResurrect(
  deps: ResurrectCommandDeps,
  options: {
    fromCid?: string;
    gateway?: string;
    contentDir?: string;
    agentName?: string;
  } = {},
): Promise<ResurrectResult> {
  const scriptPath = resolveResurrectScript(deps.scriptDir);

  // Verify script exists
  try {
    await access(scriptPath, constants.R_OK);
  } catch {
    return {
      success: false,
      cid: null,
      tier: null,
      filesRestored: null,
      secretsInjected: null,
      output: "",
      error: `Resurrect script not found: ${scriptPath}`,
    };
  }

  // Resolve CID: explicit > last-checkpoint.json
  let cid = options.fromCid ?? null;
  if (!cid) {
    cid = await readLatestCid(deps.lastCheckpointPath);
  }

  // Build args
  const args: string[] = [];
  if (cid) args.push("--from-cid", cid);
  if (options.gateway) args.push("--gateway", options.gateway);
  if (options.contentDir) args.push("--content-dir", options.contentDir);
  if (options.agentName) args.push("--agent-name", options.agentName);

  try {
    const { stdout, stderr } = await execFileAsync("bash", [scriptPath, ...args], {
      timeout: 600_000, // 10 minute timeout — resurrection can be slow
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const output = stdout + (stderr ? `\n${stderr}` : "");

    return {
      success: true,
      cid: cid ?? parseCidFromOutput(output),
      tier: parseTier(output),
      filesRestored: parseFilesRestored(output),
      secretsInjected: parseSecretsInjected(output),
      output,
      error: null,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stdout = (err as { stdout?: string })?.stdout ?? "";
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    const output = stdout + (stderr ? `\n${stderr}` : "");

    return {
      success: false,
      cid,
      tier: parseTier(typeof output === "string" ? output : ""),
      filesRestored: null,
      secretsInjected: null,
      output: typeof output === "string" ? output : "",
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format resurrection result as human-readable text.
 */
export function formatResurrectResult(result: ResurrectResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("=== Resurrection Complete ===");
    lines.push("");
    if (result.cid) {
      lines.push(`CID:              ${result.cid}`);
    }
    if (result.tier !== null) {
      lines.push(`Recovery tier:    ${result.tier}`);
    }
    if (result.filesRestored !== null) {
      lines.push(`Files restored:   ${result.filesRestored}`);
    }
    if (result.secretsInjected !== null) {
      lines.push(`Secrets injected: ${result.secretsInjected}`);
    }
    if (!result.cid && !result.tier && result.filesRestored === null) {
      lines.push("Recovery completed via local tier (no IPFS fetch needed).");
    }
  } else {
    lines.push("=== Resurrection Failed ===");
    lines.push("");
    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }
    if (result.tier !== null) {
      lines.push(`Last tier attempted: ${result.tier}`);
    }
    if (result.cid) {
      lines.push(`CID: ${result.cid}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Recovery prompt injection
// ---------------------------------------------------------------------------

/**
 * Build a recovery prompt summarizing what was restored.
 * This is injected into the new session after resurrection.
 */
export function buildRecoveryPrompt(result: ResurrectResult): string | null {
  if (!result.success) return null;

  const parts: string[] = [
    "You have been resurrected from an AMCP checkpoint.",
  ];

  if (result.cid) {
    parts.push(`Checkpoint CID: ${result.cid}`);
  }
  if (result.tier !== null) {
    parts.push(`Recovery tier: ${result.tier} (1=restart, 2=config fix, 3=full rehydrate)`);
  }
  if (result.filesRestored !== null) {
    parts.push(`${result.filesRestored} files were restored to your workspace.`);
  }
  if (result.secretsInjected !== null) {
    parts.push(`${result.secretsInjected} secrets were re-injected into config.`);
  }
  parts.push("Review your SOUL.md and MEMORY.md to reorient.");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Command handler factory
// ---------------------------------------------------------------------------

/**
 * Create the 'amcp resurrect' CLI command handler.
 *
 * Supports flags:
 *   --from-cid <CID>      Resurrect from specific checkpoint CID
 *   --gateway <name>       Prefer specific IPFS gateway (solvr, pinata, ipfs.io)
 *   --content-dir <path>   Override workspace restore path
 *   --agent-name <name>    Agent name for logging
 *   --json                 Output result as JSON
 */
export function createResurrectHandler(
  deps: ResurrectCommandDeps,
): (args: string[]) => Promise<void> {
  return async (args: string[]) => {
    const jsonMode = args.includes("--json");

    // Parse named arguments
    const fromCid = extractArg(args, "--from-cid");
    const gateway = extractArg(args, "--gateway");
    const contentDir = extractArg(args, "--content-dir");
    const agentName = extractArg(args, "--agent-name");

    const cidDisplay = fromCid ?? "latest";
    deps.logger.info(`amcp resurrect: restoring from ${cidDisplay}...`);

    const result = await runResurrect(deps, {
      fromCid,
      gateway,
      contentDir,
      agentName,
    });

    if (jsonMode) {
      deps.logger.info(JSON.stringify(result, null, 2));
    } else {
      const formatted = formatResurrectResult(result);
      deps.logger.info(formatted);

      // Inject recovery prompt on success
      if (result.success) {
        const prompt = buildRecoveryPrompt(result);
        if (prompt) {
          deps.logger.debug("Recovery prompt:\n" + prompt);
        }
      }

      // Log progress lines from the bash script output for visibility
      if (result.output) {
        const stageLines = result.output
          .split("\n")
          .filter((l) => l.startsWith("===") || l.includes("Tier"));
        for (const line of stageLines) {
          deps.logger.debug(line);
        }
      }
    }
  };
}

/**
 * Extract a named argument value from an args array.
 * Returns the value following the flag, or undefined if not found.
 */
function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
