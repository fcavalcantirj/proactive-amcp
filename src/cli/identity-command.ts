/**
 * CLI Identity Command — 'openclaw amcp identity'
 *
 * Identity management subcommands:
 *   show    — display current identity (AID, public key, created, KEL)
 *   rotate  — rotate to next key (delegates to amcp CLI)
 *   verify  — verify identity integrity (KERI format, KEL chain, secrets check)
 *   export  — export identity for backup (copies to specified path)
 *
 * P4-CLI-04: Register 'amcp identity' CLI command with real execution.
 */

import { readFile, copyFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { constants } from "node:fs";
import {
  validateIdentity,
  type IdentityValidationResult,
} from "../identity-manager.js";
import {
  rotateKey,
  detectRotationNeed,
  readNextKeyHash,
  loadRotationHistory,
} from "../key-rotation.js";
import type {
  PluginLogger,
  AmcpPluginConfig,
  AmcpIdentity,
  RotationTrigger,
} from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the identity show subcommand. */
export interface IdentityShowResult {
  valid: boolean;
  aid: string | null;
  publicKey: string | null;
  created: string | null;
  nextKeyHash: string | null;
  kelLength: number;
  rotationHistory: number;
  path: string;
}

/** Result of the identity verify subcommand. */
export interface IdentityVerifyResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: VerifyCheck[];
}

/** Individual verification check. */
export interface VerifyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Result of the identity rotate subcommand. */
export interface IdentityRotateResult {
  success: boolean;
  previousAid: string | null;
  newAid: string | null;
  kelSequenceNumber: number | null;
  error: string | null;
}

/** Result of the identity export subcommand. */
export interface IdentityExportResult {
  success: boolean;
  sourcePath: string;
  exportPath: string | null;
  error: string | null;
}

/** Dependencies injected by the plugin registration layer. */
export interface IdentityCommandDeps {
  logger: PluginLogger;
  config: AmcpPluginConfig;
  identityPath: string;
  /** Path to the scripts directory (for amcp CLI fallback). */
  scriptDir: string;
}

// ---------------------------------------------------------------------------
// Subcommand: show
// ---------------------------------------------------------------------------

/**
 * Gather identity info for display.
 */
export async function gatherIdentityInfo(
  deps: IdentityCommandDeps,
): Promise<IdentityShowResult> {
  const result = await validateIdentity(deps.identityPath);
  const rotations = await loadRotationHistory();

  if (!result.valid || !result.identity) {
    return {
      valid: false,
      aid: null,
      publicKey: null,
      created: null,
      nextKeyHash: null,
      kelLength: 0,
      rotationHistory: rotations.length,
      path: deps.identityPath,
    };
  }

  const identity = result.identity;
  return {
    valid: true,
    aid: identity.aid,
    publicKey: identity.publicKey,
    created: identity.created,
    nextKeyHash: readNextKeyHash(identity),
    kelLength: Array.isArray(identity.kel) ? identity.kel.length : 0,
    rotationHistory: rotations.length,
    path: deps.identityPath,
  };
}

/**
 * Format identity info as human-readable text.
 */
export function formatIdentityShow(info: IdentityShowResult): string {
  const lines: string[] = [];

  lines.push("=== AMCP Identity ===");
  lines.push("");

  if (info.valid) {
    lines.push(`AID:           ${info.aid}`);
    lines.push(`Public Key:    ${info.publicKey}`);
    if (info.created) {
      lines.push(`Created:       ${info.created}`);
    }
    lines.push(`KEL Events:    ${info.kelLength}`);
    lines.push(`Pre-rotation:  ${info.nextKeyHash ? "committed" : "none"}`);
    if (info.nextKeyHash) {
      lines.push(`Next Key Hash: ${info.nextKeyHash}`);
    }
    lines.push(`Rotations:     ${info.rotationHistory}`);
    lines.push(`Path:          ${info.path}`);
    lines.push("");
    lines.push("Status: VALID");
  } else {
    lines.push("Status: INVALID or MISSING");
    lines.push(`Path:   ${info.path}`);
    lines.push("");
    lines.push("Run 'amcp identity create' to create a new identity.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: verify
// ---------------------------------------------------------------------------

/**
 * Run full identity verification with detailed checks.
 */
export async function verifyIdentity(
  deps: IdentityCommandDeps,
): Promise<IdentityVerifyResult> {
  const checks: VerifyCheck[] = [];
  const result = await validateIdentity(deps.identityPath);

  // Check 1: File exists and is readable
  let fileReadable = false;
  try {
    await access(deps.identityPath, constants.R_OK);
    fileReadable = true;
  } catch {
    // file not readable
  }
  checks.push({
    name: "file-readable",
    passed: fileReadable,
    detail: fileReadable
      ? `Identity file readable at ${deps.identityPath}`
      : `Identity file not found or not readable at ${deps.identityPath}`,
  });

  // Check 2: Valid JSON
  let validJson = false;
  let rawData: Record<string, unknown> | null = null;
  if (fileReadable) {
    try {
      const content = await readFile(deps.identityPath, "utf-8");
      rawData = JSON.parse(content) as Record<string, unknown>;
      validJson = true;
    } catch {
      // invalid JSON
    }
  }
  checks.push({
    name: "valid-json",
    passed: validJson,
    detail: validJson
      ? "Identity file is valid JSON"
      : "Identity file is not valid JSON",
  });

  // Check 3: KERI AID format
  const hasValidAid =
    rawData !== null &&
    typeof rawData.aid === "string" &&
    /^B[A-Za-z0-9_-]{43,44}$/.test(rawData.aid);
  checks.push({
    name: "keri-aid-format",
    passed: hasValidAid,
    detail: hasValidAid
      ? `AID has valid KERI format: ${(rawData?.aid as string)?.substring(0, 12)}...`
      : "AID missing or does not match KERI format (B + base64url Ed25519 pubkey)",
  });

  // Check 4: Not a legacy sha256 identity
  const isLegacy =
    rawData !== null &&
    typeof rawData.aid === "string" &&
    /^[a-f0-9]{64}$/i.test(rawData.aid);
  checks.push({
    name: "not-legacy-sha256",
    passed: !isLegacy,
    detail: isLegacy
      ? "AID is a sha256 hash — legacy identity from openclaw-deploy"
      : "AID is not a legacy sha256 hash",
  });

  // Check 5: Public key present
  const hasPublicKey =
    rawData !== null &&
    typeof rawData.publicKey === "string" &&
    rawData.publicKey.length > 0;
  checks.push({
    name: "public-key-present",
    passed: hasPublicKey,
    detail: hasPublicKey
      ? "Public key is present and non-empty"
      : "Public key is missing or empty",
  });

  // Check 6: No secrets embedded
  const secretFields = [
    "pinata_jwt", "pinata_api_key", "solvr_api_key",
    "api_key", "apiKey", "jwt", "token", "secret",
    "password", "mnemonic",
  ];
  const foundSecrets = rawData
    ? Object.keys(rawData).filter((k) => secretFields.includes(k))
    : [];
  checks.push({
    name: "no-embedded-secrets",
    passed: foundSecrets.length === 0,
    detail:
      foundSecrets.length === 0
        ? "No secrets found in identity file"
        : `Secrets found in identity file: ${foundSecrets.join(", ")}`,
  });

  // Check 7: KEL chain integrity (from the validateIdentity result)
  const kelValid = result.errors.filter(
    (e) => e.includes("KEL"),
  ).length === 0;
  checks.push({
    name: "kel-chain-integrity",
    passed: kelValid,
    detail: kelValid
      ? "KEL chain integrity check passed"
      : `KEL chain issues: ${result.errors.filter((e) => e.includes("KEL")).join("; ")}`,
  });

  return {
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    checks,
  };
}

/**
 * Format verification result as human-readable text.
 */
export function formatVerifyResult(result: IdentityVerifyResult): string {
  const lines: string[] = [];

  lines.push("=== Identity Verification ===");
  lines.push("");

  for (const check of result.checks) {
    const icon = check.passed ? "PASS" : "FAIL";
    lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
  }

  lines.push("");

  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push("");
  }

  const passed = result.checks.filter((c) => c.passed).length;
  const total = result.checks.length;
  lines.push(
    `Result: ${passed}/${total} checks passed — ${result.valid ? "VALID" : "INVALID"}`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: rotate
// ---------------------------------------------------------------------------

/**
 * Execute key rotation.
 */
export async function executeRotation(
  deps: IdentityCommandDeps,
  trigger: RotationTrigger = "manual",
): Promise<IdentityRotateResult> {
  // First validate current identity
  const currentResult = await validateIdentity(deps.identityPath);
  if (!currentResult.valid || !currentResult.identity) {
    return {
      success: false,
      previousAid: null,
      newAid: null,
      kelSequenceNumber: null,
      error: `Current identity invalid: ${currentResult.errors.join(", ")}`,
    };
  }

  const previousAid = currentResult.identity.aid;

  // Check if rotation is possible (needs nextKeyHash)
  const nkh = readNextKeyHash(currentResult.identity);
  if (!nkh) {
    return {
      success: false,
      previousAid,
      newAid: null,
      kelSequenceNumber: null,
      error: "No pre-rotation commitment (nextKeyHash) — cannot rotate",
    };
  }

  // Delegate to key-rotation module
  const rotationResult = await rotateKey(trigger, {
    identityPath: deps.identityPath,
    logger: deps.logger,
  });

  if (!rotationResult.success || !rotationResult.record) {
    return {
      success: false,
      previousAid,
      newAid: null,
      kelSequenceNumber: null,
      error: rotationResult.error ?? "Rotation failed",
    };
  }

  return {
    success: true,
    previousAid: rotationResult.record.previousAid,
    newAid: rotationResult.record.newAid,
    kelSequenceNumber: rotationResult.record.kelSequenceNumber,
    error: null,
  };
}

/**
 * Format rotation result as human-readable text.
 */
export function formatRotateResult(result: IdentityRotateResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("=== Key Rotation Complete ===");
    lines.push("");
    lines.push(`Previous AID:       ${result.previousAid}`);
    lines.push(`New AID:            ${result.newAid}`);
    if (result.kelSequenceNumber !== null) {
      lines.push(`KEL sequence:       ${result.kelSequenceNumber}`);
    }
  } else {
    lines.push("=== Key Rotation Failed ===");
    lines.push("");
    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }
    if (result.previousAid) {
      lines.push(`Current AID: ${result.previousAid}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: export
// ---------------------------------------------------------------------------

/**
 * Export identity file to a backup location.
 */
export async function exportIdentity(
  deps: IdentityCommandDeps,
  exportPath: string,
): Promise<IdentityExportResult> {
  // Verify source exists
  try {
    await access(deps.identityPath, constants.R_OK);
  } catch {
    return {
      success: false,
      sourcePath: deps.identityPath,
      exportPath: null,
      error: `Identity file not found: ${deps.identityPath}`,
    };
  }

  // Validate the identity before exporting
  const result = await validateIdentity(deps.identityPath);
  if (!result.valid) {
    return {
      success: false,
      sourcePath: deps.identityPath,
      exportPath: null,
      error: `Identity is invalid — fix before exporting: ${result.errors.join(", ")}`,
    };
  }

  // Ensure target directory exists
  try {
    await mkdir(dirname(exportPath), { recursive: true });
  } catch {
    return {
      success: false,
      sourcePath: deps.identityPath,
      exportPath,
      error: `Cannot create export directory: ${dirname(exportPath)}`,
    };
  }

  // Copy the file
  try {
    await copyFile(deps.identityPath, exportPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      sourcePath: deps.identityPath,
      exportPath,
      error: `Export failed: ${message}`,
    };
  }

  return {
    success: true,
    sourcePath: deps.identityPath,
    exportPath,
    error: null,
  };
}

/**
 * Format export result as human-readable text.
 */
export function formatExportResult(result: IdentityExportResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("=== Identity Exported ===");
    lines.push("");
    lines.push(`Source: ${result.sourcePath}`);
    lines.push(`Export: ${result.exportPath}`);
    lines.push("");
    lines.push("Keep this backup safe — loss of identity.json means");
    lines.push("you cannot decrypt any existing checkpoints.");
  } else {
    lines.push("=== Identity Export Failed ===");
    lines.push("");
    if (result.error) {
      lines.push(`Error: ${result.error}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Arg parsing helper
// ---------------------------------------------------------------------------

/**
 * Extract a named argument value from an args array.
 * Returns the value following the flag, or undefined if not found.
 */
function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Command handler factory
// ---------------------------------------------------------------------------

/**
 * Create the 'amcp identity' CLI command handler.
 *
 * Subcommands:
 *   show                     Display current identity
 *   verify                   Verify identity integrity
 *   rotate [--trigger <t>]   Rotate to next key (triggers: manual, compromise, scheduled)
 *   export --out <path>      Export identity for backup
 *   (no subcommand)          Same as 'show'
 *
 * Global flags:
 *   --json                   Output result as JSON
 */
export function createIdentityHandler(
  deps: IdentityCommandDeps,
): (args: string[]) => Promise<void> {
  return async (args: string[]) => {
    const jsonMode = args.includes("--json");
    const subcommand = args.find(
      (a) => !a.startsWith("--") && a !== "identity",
    ) ?? "show";

    switch (subcommand) {
      case "show": {
        const info = await gatherIdentityInfo(deps);
        if (jsonMode) {
          deps.logger.info(JSON.stringify(info, null, 2));
        } else {
          deps.logger.info(formatIdentityShow(info));
        }
        break;
      }

      case "verify": {
        const result = await verifyIdentity(deps);
        if (jsonMode) {
          deps.logger.info(JSON.stringify(result, null, 2));
        } else {
          deps.logger.info(formatVerifyResult(result));
        }
        break;
      }

      case "rotate": {
        const trigger =
          (extractArg(args, "--trigger") as RotationTrigger) ?? "manual";
        deps.logger.info(
          `amcp identity rotate: rotating key (trigger: ${trigger})...`,
        );
        const result = await executeRotation(deps, trigger);
        if (jsonMode) {
          deps.logger.info(JSON.stringify(result, null, 2));
        } else {
          deps.logger.info(formatRotateResult(result));
        }
        break;
      }

      case "export": {
        const outPath = extractArg(args, "--out");
        if (!outPath) {
          deps.logger.error(
            "amcp identity export: --out <path> is required",
          );
          return;
        }
        const result = await exportIdentity(deps, outPath);
        if (jsonMode) {
          deps.logger.info(JSON.stringify(result, null, 2));
        } else {
          deps.logger.info(formatExportResult(result));
        }
        break;
      }

      default: {
        deps.logger.info(
          `Unknown identity subcommand: ${subcommand}\n\n` +
            "Usage: amcp identity <show|verify|rotate|export>\n" +
            "  show                     Display current identity\n" +
            "  verify                   Verify identity integrity\n" +
            "  rotate [--trigger <t>]   Rotate to next key\n" +
            "  export --out <path>      Export identity for backup",
        );
      }
    }
  };
}
