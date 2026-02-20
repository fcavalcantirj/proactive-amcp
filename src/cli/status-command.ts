/**
 * CLI Status Command — 'openclaw amcp status'
 *
 * Displays AMCP status: identity info, last checkpoint,
 * monitor states (context, memory, resurrection), and config summary.
 *
 * P4-CLI-01: Register 'amcp status' CLI command with full system visibility.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PluginLogger,
  PluginService,
  AmcpPluginConfig,
  AmcpIdentity,
} from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the status command — structured for display or JSON output. */
export interface AmcpStatus {
  identity: IdentityStatus;
  lastCheckpoint: CheckpointStatus;
  monitors: MonitorStatuses;
  config: ConfigSummary;
}

export interface IdentityStatus {
  valid: boolean;
  aid: string | null;
  publicKey: string | null;
  created: string | null;
}

export interface CheckpointStatus {
  available: boolean;
  cid: string | null;
  timestamp: string | null;
  size: number | null;
  pinningService: string | null;
}

export interface MonitorStatus {
  running: boolean;
  details: Record<string, unknown>;
}

export interface MonitorStatuses {
  context: MonitorStatus | null;
  memory: MonitorStatus | null;
  resurrection: MonitorStatus | null;
}

export interface ConfigSummary {
  autoCheckpoint: boolean;
  contextThreshold: number;
  ipfsPinningService: string;
  checkpointIntervalMs: number;
  checkpointCooldownMs: number;
  memoryIntegrity: boolean;
  autoRestore: boolean;
  promptInjectionScan: boolean;
}

/** Dependencies injected by the plugin registration layer. */
export interface StatusCommandDeps {
  logger: PluginLogger;
  config: AmcpPluginConfig;
  identityPath: string;
  lastCheckpointPath: string;
  services: PluginService[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load identity info from disk.
 */
async function loadIdentityStatus(
  identityPath: string,
): Promise<IdentityStatus> {
  try {
    const content = await readFile(identityPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    const aid = typeof data.aid === "string" ? data.aid : null;
    const publicKey =
      typeof data.publicKey === "string" ? data.publicKey : null;
    const created =
      typeof data.created === "string" ? data.created : null;

    // Basic KERI format validation
    const valid = aid !== null && /^B[A-Za-z0-9_-]{43,44}$/.test(aid);

    return { valid, aid, publicKey, created };
  } catch {
    return { valid: false, aid: null, publicKey: null, created: null };
  }
}

/**
 * Load last checkpoint info from disk.
 */
async function loadCheckpointStatus(
  lastCheckpointPath: string,
): Promise<CheckpointStatus> {
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
    const size = typeof data.size === "number" ? data.size : null;
    const pinningService =
      typeof data.pinningService === "string" ? data.pinningService : null;

    return {
      available: cid !== null,
      cid,
      timestamp,
      size,
      pinningService,
    };
  } catch {
    return {
      available: false,
      cid: null,
      timestamp: null,
      size: null,
      pinningService: null,
    };
  }
}

/**
 * Query a named service for its status. Returns null if service not found.
 */
async function getServiceStatus(
  services: PluginService[],
  name: string,
): Promise<MonitorStatus | null> {
  const service = services.find((s) => s.name === name);
  if (!service) return null;

  try {
    const status = await service.status();
    return {
      running: status.running,
      details: status.details ?? {},
    };
  } catch {
    return { running: false, details: { error: "status query failed" } };
  }
}

/**
 * Build config summary from resolved config.
 */
function buildConfigSummary(config: AmcpPluginConfig): ConfigSummary {
  return {
    autoCheckpoint: config.autoCheckpoint,
    contextThreshold: config.contextThreshold,
    ipfsPinningService: config.ipfsPinningService,
    checkpointIntervalMs: config.checkpointIntervalMs,
    checkpointCooldownMs: config.checkpointCooldownMs,
    memoryIntegrity: config.memoryIntegrity.enabled,
    autoRestore: config.memoryIntegrity.autoRestore,
    promptInjectionScan: config.memoryIntegrity.promptInjectionScan,
  };
}

// ---------------------------------------------------------------------------
// Core: gather full status
// ---------------------------------------------------------------------------

/**
 * Gather complete AMCP status from all sources.
 */
export async function gatherStatus(
  deps: StatusCommandDeps,
): Promise<AmcpStatus> {
  const [identity, lastCheckpoint, context, memory, resurrection] =
    await Promise.all([
      loadIdentityStatus(deps.identityPath),
      loadCheckpointStatus(deps.lastCheckpointPath),
      getServiceStatus(deps.services, "amcp-context-monitor"),
      getServiceStatus(deps.services, "amcp-memory-integrity"),
      getServiceStatus(deps.services, "amcp-resurrection-detector"),
    ]);

  return {
    identity,
    lastCheckpoint,
    monitors: { context, memory, resurrection },
    config: buildConfigSummary(deps.config),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format the status as human-readable text for CLI output.
 */
export function formatStatus(status: AmcpStatus): string {
  const lines: string[] = [];

  // Identity section
  lines.push("=== AMCP Status ===");
  lines.push("");
  lines.push("Identity:");
  if (status.identity.valid) {
    lines.push(`  AID:     ${status.identity.aid}`);
    if (status.identity.created) {
      lines.push(`  Created: ${status.identity.created}`);
    }
    lines.push("  Status:  VALID");
  } else {
    lines.push("  Status:  INVALID or MISSING");
    if (status.identity.aid) {
      lines.push(`  AID:     ${status.identity.aid} (invalid format)`);
    }
  }

  // Checkpoint section
  lines.push("");
  lines.push("Last Checkpoint:");
  if (status.lastCheckpoint.available) {
    lines.push(`  CID:       ${status.lastCheckpoint.cid}`);
    if (status.lastCheckpoint.timestamp) {
      lines.push(`  Timestamp: ${status.lastCheckpoint.timestamp}`);
    }
    if (status.lastCheckpoint.size !== null) {
      lines.push(`  Size:      ${status.lastCheckpoint.size} bytes`);
    }
    if (status.lastCheckpoint.pinningService) {
      lines.push(`  Pinning:   ${status.lastCheckpoint.pinningService}`);
    }
  } else {
    lines.push("  No checkpoint found");
  }

  // Monitor section
  lines.push("");
  lines.push("Monitors:");
  for (const [name, monitor] of Object.entries(status.monitors)) {
    if (monitor) {
      const state = monitor.running ? "RUNNING" : "STOPPED";
      lines.push(`  ${name}: ${state}`);
    } else {
      lines.push(`  ${name}: NOT REGISTERED`);
    }
  }

  // Config section
  lines.push("");
  lines.push("Config:");
  lines.push(`  Auto-checkpoint:       ${status.config.autoCheckpoint}`);
  lines.push(`  Context threshold:     ${status.config.contextThreshold}%`);
  lines.push(`  IPFS pinning service:  ${status.config.ipfsPinningService}`);
  lines.push(`  Memory integrity:      ${status.config.memoryIntegrity}`);
  lines.push(`  Prompt injection scan: ${status.config.promptInjectionScan}`);
  lines.push(`  Auto-restore:          ${status.config.autoRestore}`);

  if (status.config.checkpointIntervalMs > 0) {
    const mins = Math.round(status.config.checkpointIntervalMs / 60_000);
    lines.push(`  Checkpoint interval:   ${mins} min`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Create the 'amcp status' CLI command handler.
 */
export function createStatusHandler(
  deps: StatusCommandDeps,
): (args: string[]) => Promise<void> {
  return async (args: string[]) => {
    const jsonMode = args.includes("--json");

    const status = await gatherStatus(deps);

    if (jsonMode) {
      deps.logger.info(JSON.stringify(status, null, 2));
    } else {
      const formatted = formatStatus(status);
      deps.logger.info(formatted);
    }
  };
}
