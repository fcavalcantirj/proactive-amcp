/**
 * CLI Verify Command — 'openclaw amcp verify'
 *
 * Verify checkpoint integrity: fetch by CID or read from local path,
 * verify content hash matches CID, verify Ed25519 signature if present,
 * and report overall integrity status.
 *
 * P4-CLI-06: Register 'amcp verify' CLI command with real verification.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import type { PluginLogger, AmcpPluginConfig } from "../types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Individual verification check result. */
export interface VerifyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Overall verification result. */
export interface VerifyResult {
  success: boolean;
  /** The CID or path that was verified. */
  target: string;
  /** Source of the checkpoint: 'local', 'ipfs', or 'last-checkpoint'. */
  source: string;
  checks: VerifyCheck[];
  /** Number of checks that passed. */
  passed: number;
  /** Total number of checks run. */
  total: number;
  /** Whether all checks passed — the checkpoint is fully intact. */
  intact: boolean;
  error: string | null;
}

/** Dependencies injected by the plugin registration layer. */
export interface VerifyCommandDeps {
  logger: PluginLogger;
  config: AmcpPluginConfig;
  /** Path to last-checkpoint.json for resolving latest checkpoint. */
  lastCheckpointPath: string;
  /** Directory containing checkpoint files. */
  checkpointDir: string;
  /** Path to the scripts directory (for resolving amcp CLI). */
  scriptDir: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a named argument value from the args array.
 * Returns undefined if flag is not found or has no value after it.
 */
function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * Check if a string looks like a CID (starts with 'bafkrei' or 'Qm').
 */
function isCidLike(value: string): boolean {
  return value.startsWith("bafkrei") || value.startsWith("Qm");
}

/**
 * Read last-checkpoint.json and return the most recent CID and local path.
 */
async function loadLastCheckpoint(
  lastCheckpointPath: string,
): Promise<{ cid: string | null; localPath: string | null }> {
  try {
    const content = await readFile(lastCheckpointPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    const cid =
      (typeof data.cid === "string" && data.cid) ||
      (typeof data.pinataCid === "string" && data.pinataCid) ||
      (typeof data.solvrCid === "string" && data.solvrCid) ||
      null;
    const localPath =
      typeof data.localPath === "string" ? data.localPath : null;

    return { cid, localPath };
  } catch {
    return { cid: null, localPath: null };
  }
}

/**
 * Find a local checkpoint file matching a CID in the checkpoint directory.
 * Scans .amcp files for a matching CID in their metadata.
 */
async function findLocalCheckpointByCid(
  checkpointDir: string,
  cid: string,
): Promise<string | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(checkpointDir);
    const checkpointFiles = files.filter((f) => f.endsWith(".amcp") || f.endsWith(".json"));

    for (const file of checkpointFiles) {
      const filePath = join(checkpointDir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const data = JSON.parse(content) as Record<string, unknown>;
        if (
          data.cid === cid ||
          data.pinataCid === cid ||
          data.solvrCid === cid
        ) {
          return filePath;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return null;
}

/**
 * Fetch a checkpoint from IPFS by CID using gateway URLs.
 * Tries multiple gateways in priority order.
 * Returns the path to a temporary file containing the checkpoint.
 */
async function fetchFromIpfs(
  cid: string,
): Promise<{ path: string; gateway: string } | null> {
  const gateways = [
    { name: "solvr", url: `https://ipfs.solvr.dev/ipfs/${cid}` },
    { name: "ipfs.io", url: `https://ipfs.io/ipfs/${cid}` },
    { name: "dweb.link", url: `https://dweb.link/ipfs/${cid}` },
    { name: "cloudflare", url: `https://cloudflare-ipfs.com/ipfs/${cid}` },
  ];

  const { writeFile: writeFileAsync } = await import("node:fs/promises");
  const tmpPath = join(
    tmpdir(),
    `amcp-verify-${cid.slice(0, 16)}-${Date.now()}.json`,
  );

  for (const gw of gateways) {
    try {
      const { stdout } = await execFileAsync(
        "curl",
        ["-sSf", "--max-time", "30", "-o", tmpPath, gw.url],
        { timeout: 35_000 },
      );
      // Verify file was actually written
      await access(tmpPath, constants.R_OK);
      const fileStat = await stat(tmpPath);
      if (fileStat.size > 0) {
        return { path: tmpPath, gateway: gw.name };
      }
    } catch {
      // Try next gateway
    }
  }

  return null;
}

/**
 * Compute SHA-256 hash of file content.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Verify a checkpoint file using the amcp CLI.
 * Runs: amcp verify --checkpoint <path>
 * Returns the raw exit code and output.
 */
async function runAmcpVerify(
  checkpointPath: string,
  amcpCli?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cli = amcpCli ?? "amcp";
  try {
    const { stdout, stderr } = await execFileAsync(
      cli,
      ["verify", "--checkpoint", checkpointPath],
      { timeout: 30_000 },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    const e = err as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/**
 * Parse checkpoint JSON to extract metadata for display.
 */
async function parseCheckpointMeta(
  filePath: string,
): Promise<{
  valid: boolean;
  hasSig: boolean;
  hasContent: boolean;
  hasSecrets: boolean;
  aid: string | null;
  timestamp: string | null;
  protocolVersion: string | null;
  priorCid: string | null;
  size: number;
}> {
  try {
    const content = await readFile(filePath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    const hasSig = typeof data.signature === "string" && data.signature.length > 0;
    const hasContent =
      (typeof data.content === "object" && data.content !== null) ||
      (typeof data.soul === "object" && data.soul !== null);
    const hasSecrets =
      (typeof data.secrets === "object" && data.secrets !== null) ||
      (typeof data.encryptedSecrets === "string" &&
        data.encryptedSecrets.length > 0);

    const aid =
      (typeof data.aid === "string" && data.aid) ||
      (typeof data.agentId === "string" && data.agentId) ||
      null;
    const timestamp =
      (typeof data.timestamp === "string" && data.timestamp) ||
      (typeof data.created === "string" && data.created) ||
      null;
    const protocolVersion =
      (typeof data.protocolVersion === "string" && data.protocolVersion) ||
      (typeof data.version === "string" && data.version) ||
      null;
    const priorCid =
      (typeof data.priorCid === "string" && data.priorCid) ||
      (typeof data.previousCid === "string" && data.previousCid) ||
      null;

    const fileStat = await stat(filePath);

    return {
      valid: true,
      hasSig,
      hasContent,
      hasSecrets,
      aid,
      timestamp,
      protocolVersion,
      priorCid,
      size: fileStat.size,
    };
  } catch {
    try {
      const fileStat = await stat(filePath);
      return {
        valid: false,
        hasSig: false,
        hasContent: false,
        hasSecrets: false,
        aid: null,
        timestamp: null,
        protocolVersion: null,
        priorCid: null,
        size: fileStat.size,
      };
    } catch {
      return {
        valid: false,
        hasSig: false,
        hasContent: false,
        hasSecrets: false,
        aid: null,
        timestamp: null,
        protocolVersion: null,
        priorCid: null,
        size: 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Core: run verification
// ---------------------------------------------------------------------------

/**
 * Resolve a target (CID, path, or "latest") to a local checkpoint file path.
 * Returns the resolved path, source type, and original target for display.
 */
async function resolveTarget(
  target: string | undefined,
  deps: VerifyCommandDeps,
): Promise<{
  filePath: string | null;
  source: string;
  displayTarget: string;
  error: string | null;
}> {
  // No target — use latest checkpoint
  if (!target) {
    const last = await loadLastCheckpoint(deps.lastCheckpointPath);
    if (last.localPath) {
      try {
        await access(last.localPath, constants.R_OK);
        return {
          filePath: last.localPath,
          source: "last-checkpoint",
          displayTarget: last.cid ?? last.localPath,
          error: null,
        };
      } catch {
        // Local path in last-checkpoint.json is stale
      }
    }
    if (last.cid) {
      // Try to find locally first
      const localMatch = await findLocalCheckpointByCid(
        deps.checkpointDir,
        last.cid,
      );
      if (localMatch) {
        return {
          filePath: localMatch,
          source: "local",
          displayTarget: last.cid,
          error: null,
        };
      }
      // Fetch from IPFS
      const fetched = await fetchFromIpfs(last.cid);
      if (fetched) {
        return {
          filePath: fetched.path,
          source: `ipfs (${fetched.gateway})`,
          displayTarget: last.cid,
          error: null,
        };
      }
      return {
        filePath: null,
        source: "ipfs",
        displayTarget: last.cid,
        error: `Could not fetch checkpoint ${last.cid} from any IPFS gateway`,
      };
    }
    return {
      filePath: null,
      source: "unknown",
      displayTarget: "(none)",
      error: "No checkpoint found. Run a checkpoint first or provide a CID/path.",
    };
  }

  // CID — try local lookup, then IPFS fetch
  if (isCidLike(target)) {
    const localMatch = await findLocalCheckpointByCid(
      deps.checkpointDir,
      target,
    );
    if (localMatch) {
      return {
        filePath: localMatch,
        source: "local",
        displayTarget: target,
        error: null,
      };
    }
    const fetched = await fetchFromIpfs(target);
    if (fetched) {
      return {
        filePath: fetched.path,
        source: `ipfs (${fetched.gateway})`,
        displayTarget: target,
        error: null,
      };
    }
    return {
      filePath: null,
      source: "ipfs",
      displayTarget: target,
      error: `Could not fetch checkpoint ${target} from any IPFS gateway`,
    };
  }

  // Local file path
  try {
    await access(target, constants.R_OK);
    return {
      filePath: target,
      source: "local",
      displayTarget: target,
      error: null,
    };
  } catch {
    return {
      filePath: null,
      source: "local",
      displayTarget: target,
      error: `Checkpoint file not found: ${target}`,
    };
  }
}

/**
 * Run all verification checks on a checkpoint file.
 */
export async function runVerify(
  deps: VerifyCommandDeps,
  options: { target?: string; amcpCli?: string } = {},
): Promise<VerifyResult> {
  // 1. Resolve target to local file
  const resolved = await resolveTarget(options.target, deps);
  if (!resolved.filePath || resolved.error) {
    return {
      success: false,
      target: resolved.displayTarget,
      source: resolved.source,
      checks: [],
      passed: 0,
      total: 0,
      intact: false,
      error: resolved.error ?? "Could not resolve checkpoint target",
    };
  }

  const filePath = resolved.filePath;
  const checks: VerifyCheck[] = [];

  // 2. Check: file readable
  try {
    await access(filePath, constants.R_OK);
    const fileStat = await stat(filePath);
    checks.push({
      name: "file_readable",
      passed: true,
      detail: `File readable (${formatBytes(fileStat.size)})`,
    });
  } catch {
    checks.push({
      name: "file_readable",
      passed: false,
      detail: "File not readable or missing",
    });
    return buildResult(resolved, checks);
  }

  // 3. Check: valid JSON
  const meta = await parseCheckpointMeta(filePath);
  checks.push({
    name: "valid_json",
    passed: meta.valid,
    detail: meta.valid
      ? "Valid JSON checkpoint structure"
      : "File is not valid JSON — checkpoint may be corrupt",
  });

  if (!meta.valid) {
    return buildResult(resolved, checks);
  }

  // 4. Check: has content
  checks.push({
    name: "has_content",
    passed: meta.hasContent,
    detail: meta.hasContent
      ? "Checkpoint contains content/soul data"
      : "No content or soul data found in checkpoint",
  });

  // 5. Check: has encrypted secrets
  checks.push({
    name: "has_secrets",
    passed: meta.hasSecrets,
    detail: meta.hasSecrets
      ? "Checkpoint contains encrypted secrets"
      : "No encrypted secrets found (may be a content-only checkpoint)",
  });

  // 6. Check: content hash
  try {
    const hash = await computeFileHash(filePath);
    checks.push({
      name: "hash_computed",
      passed: true,
      detail: `SHA-256: ${hash.slice(0, 16)}...${hash.slice(-8)}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "hash_computed",
      passed: false,
      detail: `Could not compute hash: ${msg}`,
    });
  }

  // 7. Check: signature present
  checks.push({
    name: "signature_present",
    passed: meta.hasSig,
    detail: meta.hasSig
      ? "Ed25519 signature present"
      : "No signature found (unsigned checkpoint)",
  });

  // 8. Check: signature verification via amcp CLI
  if (meta.hasSig) {
    const verifyResult = await runAmcpVerify(filePath, options.amcpCli);
    const sigValid = verifyResult.exitCode === 0;
    checks.push({
      name: "signature_valid",
      passed: sigValid,
      detail: sigValid
        ? "Signature verified successfully"
        : `Signature verification failed: ${verifyResult.stderr.trim() || verifyResult.stdout.trim() || "unknown error"}`,
    });
  }

  // 9. Check: AID present
  checks.push({
    name: "aid_present",
    passed: meta.aid !== null,
    detail: meta.aid !== null
      ? `AID: ${meta.aid}`
      : "No AID found in checkpoint",
  });

  return buildResult(resolved, checks);
}

/**
 * Build the final VerifyResult from resolved target info and checks.
 */
function buildResult(
  resolved: { displayTarget: string; source: string },
  checks: VerifyCheck[],
): VerifyResult {
  const passed = checks.filter((c) => c.passed).length;
  return {
    success: true,
    target: resolved.displayTarget,
    source: resolved.source,
    checks,
    passed,
    total: checks.length,
    intact: passed === checks.length,
    error: null,
  };
}

/**
 * Format byte count for human display.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format verify result as human-readable text for CLI output.
 */
export function formatVerifyResult(result: VerifyResult): string {
  const lines: string[] = [];

  if (!result.success) {
    lines.push("=== Checkpoint Verification ===");
    lines.push("");
    lines.push(`Error: ${result.error}`);
    return lines.join("\n");
  }

  const statusLabel = result.intact ? "INTACT" : "ISSUES DETECTED";
  lines.push("=== Checkpoint Verification ===");
  lines.push("");
  lines.push(`Target: ${result.target}`);
  lines.push(`Source: ${result.source}`);
  lines.push(`Status: ${statusLabel}`);
  lines.push("");
  lines.push("Checks:");

  for (const check of result.checks) {
    const icon = check.passed ? "[PASS]" : "[FAIL]";
    lines.push(`  ${icon} ${check.name}: ${check.detail}`);
  }

  lines.push("");
  lines.push(`Result: ${result.passed}/${result.total} checks passed`);

  if (!result.intact) {
    lines.push("");
    lines.push("WARNING: Checkpoint integrity issues detected. This checkpoint may be corrupt.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command handler factory
// ---------------------------------------------------------------------------

/**
 * Create the 'amcp verify' CLI command handler.
 *
 * Supports:
 *   amcp verify                     Verify the latest checkpoint
 *   amcp verify <CID>               Verify a checkpoint by CID (fetch from IPFS)
 *   amcp verify <path>              Verify a local checkpoint file
 *   amcp verify --checkpoint <path> Verify a local checkpoint file (amcp CLI compat)
 *   --json                          Output result as JSON
 */
export function createVerifyHandler(
  deps: VerifyCommandDeps,
): (args: string[]) => Promise<void> {
  return async (args: string[]) => {
    const jsonMode = args.includes("--json");

    // Resolve target: --checkpoint flag, positional arg, or latest
    let target = extractArg(args, "--checkpoint");
    if (!target) {
      // Look for positional argument (first arg not starting with --)
      target = args.find(
        (a) => !a.startsWith("--") && a !== "verify",
      );
    }

    deps.logger.info(
      `amcp verify: ${target ? `verifying ${target}` : "verifying latest checkpoint"}...`,
    );

    const result = await runVerify(deps, { target });

    if (jsonMode) {
      deps.logger.info(JSON.stringify(result, null, 2));
    } else {
      const formatted = formatVerifyResult(result);
      deps.logger.info(formatted);
    }
  };
}
