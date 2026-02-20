/**
 * Multi-Identity Manager — support multiple agent identities at plugin level.
 *
 * Stores identities by agent ID in ~/.amcp/identities/<aid>/identity.json.
 * Each identity has its own checkpoint history (last-checkpoint.json).
 * Supports switching between identities via CLI.
 * Prevents cross-identity resurrection (checkpoint AID must match active AID).
 */

import { readFile, writeFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateIdentity } from "./identity-manager.js";
import type { AmcpIdentity, PluginLogger, PluginService } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Base directory for per-identity storage. */
const DEFAULT_IDENTITIES_DIR = join(homedir(), ".amcp", "identities");

/** Default active identity symlink/file path. */
const DEFAULT_IDENTITY_PATH = join(homedir(), ".amcp", "identity.json");

/** Active identity marker file — stores the AID of the currently active identity. */
const DEFAULT_ACTIVE_MARKER = join(homedir(), ".amcp", "active-identity");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredIdentity {
  aid: string;
  identity: AmcpIdentity;
  /** Path to this identity's directory under identities/. */
  dirPath: string;
  /** Path to this identity's last-checkpoint.json. */
  lastCheckpointPath: string;
}

export interface MultiIdentityDeps {
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  identitiesDir?: string;
  identityPath?: string;
  activeMarkerPath?: string;
}

// ---------------------------------------------------------------------------
// Helper: sanitize AID for directory name
// ---------------------------------------------------------------------------

/**
 * Convert an AID to a filesystem-safe directory name.
 * KERI AIDs are "B" + base64url chars which are already safe, but we
 * truncate to a reasonable length for practical use.
 */
function aidToDirName(aid: string): string {
  // AID is already filesystem-safe (B + base64url), just use it directly.
  // Max 45 chars which is fine for directory names.
  return aid;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * List all stored identities in the identities directory.
 */
export async function listIdentities(
  identitiesDir?: string,
): Promise<StoredIdentity[]> {
  const dir = identitiesDir ?? DEFAULT_IDENTITIES_DIR;
  const results: StoredIdentity[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist — no stored identities
    return results;
  }

  for (const entry of entries) {
    const idPath = join(dir, entry, "identity.json");
    const result = await validateIdentity(idPath);
    if (result.valid && result.identity) {
      results.push({
        aid: result.identity.aid,
        identity: result.identity,
        dirPath: join(dir, entry),
        lastCheckpointPath: join(dir, entry, "last-checkpoint.json"),
      });
    }
  }

  return results;
}

/**
 * Get the AID of the currently active identity.
 * Reads from the active-identity marker file.
 * Falls back to reading the main identity.json if no marker exists.
 */
export async function getActiveAid(
  activeMarkerPath?: string,
  identityPath?: string,
): Promise<string | null> {
  const markerPath = activeMarkerPath ?? DEFAULT_ACTIVE_MARKER;
  const mainPath = identityPath ?? DEFAULT_IDENTITY_PATH;

  // Try marker file first
  try {
    const content = await readFile(markerPath, "utf-8");
    const aid = content.trim();
    if (aid.length > 0) return aid;
  } catch {
    // No marker — fall through
  }

  // Fall back to reading the main identity.json
  const result = await validateIdentity(mainPath);
  if (result.valid && result.identity) {
    return result.identity.aid;
  }

  return null;
}

/**
 * Store an identity in the identities directory.
 * Copies the identity file to identities/<aid>/identity.json.
 */
export async function storeIdentity(
  sourcePath: string,
  identitiesDir?: string,
): Promise<StoredIdentity | null> {
  const dir = identitiesDir ?? DEFAULT_IDENTITIES_DIR;

  const result = await validateIdentity(sourcePath);
  if (!result.valid || !result.identity) {
    return null;
  }

  const aid = result.identity.aid;
  const dirName = aidToDirName(aid);
  const idDir = join(dir, dirName);

  await mkdir(idDir, { recursive: true });
  await copyFile(sourcePath, join(idDir, "identity.json"));

  return {
    aid,
    identity: result.identity,
    dirPath: idDir,
    lastCheckpointPath: join(idDir, "last-checkpoint.json"),
  };
}

/**
 * Switch the active identity to a different agent.
 *
 * 1. Validates the target identity exists in identities/
 * 2. Copies target identity.json to the main identity path
 * 3. Updates the active-identity marker
 *
 * Returns the switched-to identity, or null on failure.
 */
export async function switchIdentity(
  targetAid: string,
  deps: {
    identitiesDir?: string;
    identityPath?: string;
    activeMarkerPath?: string;
  } = {},
): Promise<StoredIdentity | null> {
  const dir = deps.identitiesDir ?? DEFAULT_IDENTITIES_DIR;
  const mainPath = deps.identityPath ?? DEFAULT_IDENTITY_PATH;
  const markerPath = deps.activeMarkerPath ?? DEFAULT_ACTIVE_MARKER;

  // Find the target identity
  const stored = await listIdentities(dir);
  const target = stored.find((s) => s.aid === targetAid);
  if (!target) {
    return null;
  }

  // Copy to main identity path
  const targetIdPath = join(target.dirPath, "identity.json");
  await mkdir(join(mainPath, ".."), { recursive: true });
  await copyFile(targetIdPath, mainPath);

  // Update marker
  await writeFile(markerPath, targetAid, "utf-8");

  return target;
}

/**
 * Get the per-identity last-checkpoint.json path for a given AID.
 */
export function getCheckpointPathForAid(
  aid: string,
  identitiesDir?: string,
): string {
  const dir = identitiesDir ?? DEFAULT_IDENTITIES_DIR;
  return join(dir, aidToDirName(aid), "last-checkpoint.json");
}

/**
 * Validate that a checkpoint CID belongs to the expected identity.
 * Reads the checkpoint metadata and compares the AID.
 *
 * Returns true if the checkpoint belongs to the given AID, false otherwise.
 * Returns true if checkpoint has no AID field (legacy format — no cross-identity check possible).
 */
export async function validateCheckpointOwnership(
  checkpointPath: string,
  expectedAid: string,
): Promise<{ valid: boolean; checkpointAid?: string; reason?: string }> {
  try {
    const content = await readFile(checkpointPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    // Check nested identity.aid or top-level aid
    let checkpointAid: string | undefined;
    if (typeof data.aid === "string") {
      checkpointAid = data.aid;
    } else if (
      data.identity &&
      typeof data.identity === "object" &&
      typeof (data.identity as Record<string, unknown>).aid === "string"
    ) {
      checkpointAid = (data.identity as Record<string, unknown>).aid as string;
    }

    if (!checkpointAid) {
      // Legacy checkpoint — no AID recorded, allow (can't verify)
      return { valid: true, reason: "no-aid-in-checkpoint" };
    }

    if (checkpointAid !== expectedAid) {
      return {
        valid: false,
        checkpointAid,
        reason: `checkpoint belongs to ${checkpointAid}, not ${expectedAid}`,
      };
    }

    return { valid: true, checkpointAid };
  } catch {
    // Can't read checkpoint — allow (file may not exist yet)
    return { valid: true, reason: "checkpoint-unreadable" };
  }
}

// ---------------------------------------------------------------------------
// Plugin Service
// ---------------------------------------------------------------------------

/**
 * Create the multi-identity manager service for the plugin.
 *
 * On start: stores the current identity, reads the active marker.
 * Exposes list, switch, store, and cross-identity guard functions.
 */
export function createMultiIdentityService(deps: MultiIdentityDeps): PluginService & {
  listIdentities(): Promise<StoredIdentity[]>;
  switchIdentity(targetAid: string): Promise<StoredIdentity | null>;
  getActiveAid(): Promise<string | null>;
  validateCheckpointOwnership(
    checkpointPath: string,
  ): Promise<{ valid: boolean; checkpointAid?: string; reason?: string }>;
} {
  const {
    logger,
    emit,
    identitiesDir = DEFAULT_IDENTITIES_DIR,
    identityPath = DEFAULT_IDENTITY_PATH,
    activeMarkerPath = DEFAULT_ACTIVE_MARKER,
  } = deps;

  let running = false;
  let activeAid: string | null = null;

  return {
    name: "amcp-multi-identity",

    async start(): Promise<void> {
      running = true;
      logger.info("amcp-multi-identity: starting...");

      // Store current identity if it exists and is valid
      const result = await validateIdentity(identityPath);
      if (result.valid && result.identity) {
        await storeIdentity(identityPath, identitiesDir);
        activeAid = result.identity.aid;

        // Update marker
        await mkdir(join(activeMarkerPath, ".."), { recursive: true });
        await writeFile(activeMarkerPath, activeAid, "utf-8");

        logger.info(
          `amcp-multi-identity: active identity ${activeAid}`,
        );
      } else {
        activeAid = await getActiveAid(activeMarkerPath, identityPath);
        if (activeAid) {
          logger.info(
            `amcp-multi-identity: active identity from marker ${activeAid}`,
          );
        } else {
          logger.warn("amcp-multi-identity: no valid identity found");
        }
      }

      const stored = await listIdentities(identitiesDir);
      logger.info(
        `amcp-multi-identity: ${stored.length} stored identity(ies)`,
      );

      emit("amcp:multi-identity:started", {
        activeAid,
        storedCount: stored.length,
      });
    },

    async stop(): Promise<void> {
      running = false;
      logger.info("amcp-multi-identity: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      const stored = await listIdentities(identitiesDir);
      return {
        running,
        details: {
          service: "amcp-multi-identity",
          activeAid,
          storedCount: stored.length,
          storedAids: stored.map((s) => s.aid),
        },
      };
    },

    async listIdentities(): Promise<StoredIdentity[]> {
      return listIdentities(identitiesDir);
    },

    async switchIdentity(targetAid: string): Promise<StoredIdentity | null> {
      const result = await switchIdentity(targetAid, {
        identitiesDir,
        identityPath,
        activeMarkerPath,
      });

      if (result) {
        const previousAid = activeAid;
        activeAid = targetAid;
        logger.info(
          `amcp-multi-identity: switched from ${previousAid ?? "none"} to ${targetAid}`,
        );
        emit("amcp:identity:switched", {
          previousAid,
          newAid: targetAid,
        });
      } else {
        logger.error(
          `amcp-multi-identity: identity ${targetAid} not found in store`,
        );
      }

      return result;
    },

    async getActiveAid(): Promise<string | null> {
      return activeAid;
    },

    async validateCheckpointOwnership(
      checkpointPath: string,
    ): Promise<{ valid: boolean; checkpointAid?: string; reason?: string }> {
      if (!activeAid) {
        return { valid: false, reason: "no-active-identity" };
      }

      const result = await validateCheckpointOwnership(
        checkpointPath,
        activeAid,
      );

      if (!result.valid) {
        logger.error(
          `amcp-multi-identity: cross-identity resurrection blocked — ${result.reason}`,
        );
        emit("amcp:identity:cross-identity-blocked", {
          activeAid,
          checkpointAid: result.checkpointAid,
          reason: result.reason,
        });
      }

      return result;
    },
  };
}
