/**
 * Resurrection Identity — auto-inject and verify identity on resurrection.
 *
 * When a resurrection event is detected (via "amcp:resurrection:detected"
 * or last-recovery.json update), this module:
 *
 * 1. Loads identity from the checkpoint that was used for recovery
 * 2. Compares checkpoint identity with current on-disk identity
 * 3. Alerts on identity mismatch (possible impersonation)
 * 4. Injects verified identity into session context via emit
 *
 * Security: if the checkpoint identity AID does not match the current
 * identity AID, an "amcp:identity:mismatch" alert is emitted and the
 * resurrection is flagged. This prevents a scenario where a checkpoint
 * from a different agent is restored onto the wrong machine.
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { AmcpIdentity, PluginLogger } from "../types.js";
import { validateIdentity } from "../identity-manager.js";

/** Default path to last-recovery.json written by resuscitate.sh. */
const DEFAULT_LAST_RECOVERY_PATH = join(
  homedir(),
  ".amcp",
  "last-recovery.json",
);

/** Default path to last-checkpoint.json. */
const DEFAULT_LAST_CHECKPOINT_PATH = join(
  homedir(),
  ".amcp",
  "last-checkpoint.json",
);

/** Default identity path. */
const DEFAULT_IDENTITY_PATH = join(homedir(), ".amcp", "identity.json");

/** Result of identity verification during resurrection. */
export interface ResurrectionIdentityResult {
  verified: boolean;
  currentIdentity: AmcpIdentity | null;
  checkpointIdentity: AmcpIdentity | null;
  mismatch: boolean;
  mismatchDetails?: string;
  injected: boolean;
}

/** Recovery record written by resuscitate.sh. */
interface RecoveryRecord {
  method: string;
  cid?: string;
  downtime?: number;
  timestamp: string;
  log?: string;
}

/**
 * Load the last recovery record from disk.
 * Returns null if no recovery has occurred.
 */
async function loadRecoveryRecord(
  recoveryPath: string,
): Promise<RecoveryRecord | null> {
  try {
    const content = await readFile(recoveryPath, "utf-8");
    return JSON.parse(content) as RecoveryRecord;
  } catch {
    return null;
  }
}

/**
 * Load checkpoint identity from the checkpoint metadata.
 *
 * The checkpoint contains an embedded identity (AID + publicKey) in
 * its metadata. After resuscitate.sh restores content, the identity
 * from the checkpoint is available in the restored workspace's
 * amcp/identity.json or via the last-checkpoint.json metadata.
 */
async function loadCheckpointIdentity(
  lastCheckpointPath: string,
  identityPath: string,
): Promise<AmcpIdentity | null> {
  // Try reading checkpoint metadata for embedded identity info
  try {
    const content = await readFile(lastCheckpointPath, "utf-8");
    const meta = JSON.parse(content) as Record<string, unknown>;

    // Checkpoint metadata may embed the AID used during creation
    if (typeof meta.aid === "string" && typeof meta.publicKey === "string") {
      return {
        aid: meta.aid,
        publicKey: meta.publicKey,
        created: (meta.checkpointTimestamp as string) ?? new Date().toISOString(),
      };
    }
  } catch {
    // Checkpoint metadata not available or doesn't contain identity
  }

  // Fallback: validate the on-disk identity (which was restored from checkpoint)
  const result = await validateIdentity(identityPath);
  return result.identity;
}

/**
 * Verify that the current identity matches the checkpoint identity.
 *
 * Matching is based on AID (the self-certifying identifier).
 * A mismatch means either:
 * - A checkpoint from a different agent was restored (wrong checkpoint)
 * - The identity was rotated between checkpoint and recovery
 * - Possible impersonation attempt
 */
function verifyIdentityMatch(
  current: AmcpIdentity,
  checkpoint: AmcpIdentity,
): { match: boolean; details?: string } {
  if (current.aid === checkpoint.aid) {
    return { match: true };
  }

  // Check if this could be a key rotation (same public key lineage)
  // In KERI, key rotation changes the AID — but the KEL provides continuity
  return {
    match: false,
    details:
      `AID mismatch — current: ${current.aid}, checkpoint: ${checkpoint.aid}. ` +
      "This may indicate a wrong checkpoint restore or possible impersonation.",
  };
}

/**
 * Check if a resurrection has occurred recently.
 *
 * Compares the recovery record timestamp with the provided threshold.
 * Default: consider a recovery "recent" if within the last 5 minutes.
 */
function isRecentRecovery(
  record: RecoveryRecord,
  thresholdMs: number = 300_000,
  now: Date = new Date(),
): boolean {
  const recoveryTime = new Date(record.timestamp);
  if (isNaN(recoveryTime.getTime())) {
    return false;
  }
  return now.getTime() - recoveryTime.getTime() < thresholdMs;
}

/**
 * Perform identity verification and injection after resurrection.
 *
 * Called on plugin start (to detect prior resurrection) or on
 * "amcp:resurrection:detected" event.
 */
export async function verifyAndInjectIdentity(opts: {
  identityPath?: string;
  lastRecoveryPath?: string;
  lastCheckpointPath?: string;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  recentThresholdMs?: number;
}): Promise<ResurrectionIdentityResult> {
  const identityPath = opts.identityPath ?? DEFAULT_IDENTITY_PATH;
  const lastRecoveryPath =
    opts.lastRecoveryPath ?? DEFAULT_LAST_RECOVERY_PATH;
  const lastCheckpointPath =
    opts.lastCheckpointPath ?? DEFAULT_LAST_CHECKPOINT_PATH;

  const result: ResurrectionIdentityResult = {
    verified: false,
    currentIdentity: null,
    checkpointIdentity: null,
    mismatch: false,
    injected: false,
  };

  // 1. Check if a recent resurrection occurred
  const recovery = await loadRecoveryRecord(lastRecoveryPath);
  if (!recovery) {
    opts.logger.debug(
      "amcp-resurrection-identity: no recovery record found — skipping",
    );
    return result;
  }

  if (recovery.method === "failed") {
    opts.logger.warn(
      "amcp-resurrection-identity: last recovery failed — identity not verified",
    );
    return result;
  }

  if (!isRecentRecovery(recovery, opts.recentThresholdMs)) {
    opts.logger.debug(
      "amcp-resurrection-identity: recovery not recent — skipping injection",
    );
    return result;
  }

  opts.logger.info(
    `amcp-resurrection-identity: recent recovery detected (method: ${recovery.method})`,
  );

  // 2. Load current on-disk identity
  const currentResult = await validateIdentity(identityPath);
  if (!currentResult.valid || !currentResult.identity) {
    opts.logger.error(
      "amcp-resurrection-identity: current identity invalid — cannot verify",
    );
    opts.emit("amcp:identity:invalid", {
      source: "resurrection-verification",
      errors: currentResult.errors,
    });
    return result;
  }

  result.currentIdentity = currentResult.identity;

  // 3. Load checkpoint identity
  const checkpointId = await loadCheckpointIdentity(
    lastCheckpointPath,
    identityPath,
  );
  result.checkpointIdentity = checkpointId;

  if (!checkpointId) {
    opts.logger.warn(
      "amcp-resurrection-identity: checkpoint identity not available — using current identity",
    );
    // Still inject current identity — better than nothing
    result.verified = true;
    result.injected = true;
    opts.emit("amcp:identity:injected", {
      aid: result.currentIdentity.aid,
      source: "current",
      recoveryMethod: recovery.method,
    });
    return result;
  }

  // 4. Verify identity match
  const match = verifyIdentityMatch(result.currentIdentity, checkpointId);

  if (!match.match) {
    result.mismatch = true;
    result.mismatchDetails = match.details;

    opts.logger.error(
      `amcp-resurrection-identity: IDENTITY MISMATCH — ${match.details}`,
    );

    opts.emit("amcp:identity:mismatch", {
      currentAid: result.currentIdentity.aid,
      checkpointAid: checkpointId.aid,
      details: match.details,
      recoveryMethod: recovery.method,
    });

    return result;
  }

  // 5. Identity verified — inject into session context
  result.verified = true;
  result.injected = true;

  opts.logger.info(
    `amcp-resurrection-identity: identity verified and injected (AID: ${result.currentIdentity.aid})`,
  );

  opts.emit("amcp:identity:injected", {
    aid: result.currentIdentity.aid,
    source: "checkpoint-verified",
    recoveryMethod: recovery.method,
    checkpointCid: recovery.cid,
  });

  return result;
}

/**
 * Create the resurrection identity service for the plugin.
 *
 * On start: checks for recent recovery and auto-injects identity.
 * Listens for resurrection events to verify identity on-demand.
 */
export function createResurrectionIdentityService(deps: {
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  identityPath?: string;
  lastRecoveryPath?: string;
  lastCheckpointPath?: string;
  recentThresholdMs?: number;
}): {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    running: boolean;
    details?: Record<string, unknown>;
  }>;
  getLastResult(): ResurrectionIdentityResult | null;
  verifyNow(): Promise<ResurrectionIdentityResult>;
} {
  const { logger, emit } = deps;
  let running = false;
  let lastResult: ResurrectionIdentityResult | null = null;

  return {
    name: "amcp-resurrection-identity",

    async start(): Promise<void> {
      running = true;
      logger.info("amcp-resurrection-identity: started");

      // Check for recent recovery on startup
      lastResult = await verifyAndInjectIdentity({
        identityPath: deps.identityPath,
        lastRecoveryPath: deps.lastRecoveryPath,
        lastCheckpointPath: deps.lastCheckpointPath,
        logger,
        emit,
        recentThresholdMs: deps.recentThresholdMs,
      });

      if (lastResult.injected) {
        logger.info(
          "amcp-resurrection-identity: identity auto-injected from recent recovery",
        );
      }
    },

    async stop(): Promise<void> {
      running = false;
      logger.info("amcp-resurrection-identity: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      return {
        running,
        details: {
          service: "amcp-resurrection-identity",
          lastVerification: lastResult
            ? {
                verified: lastResult.verified,
                mismatch: lastResult.mismatch,
                injected: lastResult.injected,
                currentAid: lastResult.currentIdentity?.aid ?? null,
                checkpointAid: lastResult.checkpointIdentity?.aid ?? null,
                mismatchDetails: lastResult.mismatchDetails,
              }
            : null,
        },
      };
    },

    getLastResult(): ResurrectionIdentityResult | null {
      return lastResult;
    },

    async verifyNow(): Promise<ResurrectionIdentityResult> {
      lastResult = await verifyAndInjectIdentity({
        identityPath: deps.identityPath,
        lastRecoveryPath: deps.lastRecoveryPath,
        lastCheckpointPath: deps.lastCheckpointPath,
        logger,
        emit,
        recentThresholdMs: deps.recentThresholdMs,
      });
      return lastResult;
    },
  };
}
