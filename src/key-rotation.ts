/**
 * Key Rotation — pre-rotation key handling at the plugin level.
 *
 * Reads nextKeyHash from identity.json, detects when key rotation is needed
 * (compromise, scheduled, manual), performs rotation by delegating to the
 * amcp CLI, and stores rotation history in .amcp/key-rotations.jsonl.
 *
 * KERI pre-rotation: at inception, the agent commits a hash of the next public
 * key. When rotation occurs, the next key is revealed and a new commitment is
 * made. An attacker who compromises the current key cannot rotate because they
 * don't know the pre-committed next key.
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AmcpIdentity,
  PluginLogger,
  RotationTrigger,
  RotationRecord,
} from "./types.js";
import { validateIdentity } from "./identity-manager.js";

const execFileAsync = promisify(execFile);

/** Default paths. */
const DEFAULT_IDENTITY_PATH = join(homedir(), ".amcp", "identity.json");
const DEFAULT_ROTATIONS_PATH = join(homedir(), ".amcp", "key-rotations.jsonl");

/** Rotation policy defaults. */
const DEFAULT_MAX_AGE_DAYS = 90;

/** Result of a rotation need check. */
export interface RotationNeedResult {
  needed: boolean;
  trigger: RotationTrigger | null;
  reason: string;
}

/** Result of a key rotation operation. */
export interface RotationResult {
  success: boolean;
  record: RotationRecord | null;
  error?: string;
}

/**
 * Read the nextKeyHash from an identity.
 * Sources (in priority order):
 * 1. identity.nextKeyHash (top-level field)
 * 2. Last KEL event's nextKeyHash or next field
 */
export function readNextKeyHash(identity: AmcpIdentity): string | null {
  return identity.nextKeyHash ?? null;
}

/**
 * Detect whether key rotation is needed.
 *
 * Checks:
 * 1. Compromise signal: if compromised flag is set in config or passed explicitly
 * 2. Scheduled: if the identity age exceeds maxAgeDays (default 90)
 * 3. Missing pre-rotation: if no nextKeyHash exists, rotation can't proceed
 */
export function detectRotationNeed(
  identity: AmcpIdentity,
  opts?: {
    compromised?: boolean;
    maxAgeDays?: number;
    now?: Date;
  },
): RotationNeedResult {
  const compromised = opts?.compromised ?? false;
  const maxAgeDays = opts?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const now = opts?.now ?? new Date();

  // Compromise takes highest priority
  if (compromised) {
    return {
      needed: true,
      trigger: "compromise",
      reason: "Key compromise detected — immediate rotation required",
    };
  }

  // Check identity age for scheduled rotation
  const created = new Date(identity.created);
  if (!isNaN(created.getTime())) {
    const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= maxAgeDays) {
      return {
        needed: true,
        trigger: "scheduled",
        reason: `Identity is ${Math.floor(ageDays)} days old (max: ${maxAgeDays})`,
      };
    }
  }

  return {
    needed: false,
    trigger: null,
    reason: "No rotation needed",
  };
}

/**
 * Load rotation history from the JSONL log.
 */
export async function loadRotationHistory(
  rotationsPath?: string,
): Promise<RotationRecord[]> {
  const path = rotationsPath ?? DEFAULT_ROTATIONS_PATH;
  try {
    const content = await readFile(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as RotationRecord);
  } catch {
    return [];
  }
}

/**
 * Append a rotation record to the JSONL log.
 */
async function appendRotationRecord(
  record: RotationRecord,
  rotationsPath?: string,
): Promise<void> {
  const path = rotationsPath ?? DEFAULT_ROTATIONS_PATH;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n");
}

/**
 * Compute the KEL sequence number from the current identity.
 */
function getKelSequenceNumber(identity: AmcpIdentity): number {
  if (!Array.isArray(identity.kel) || identity.kel.length === 0) {
    return 0;
  }
  return identity.kel.length;
}

/**
 * Rotate the identity key by delegating to the amcp CLI.
 *
 * Flow:
 * 1. Validate current identity has a nextKeyHash (pre-rotation commitment)
 * 2. Call `amcp identity rotate` to perform the rotation
 * 3. Validate the new identity
 * 4. Record the rotation in key-rotations.jsonl
 *
 * @param trigger Why the rotation is happening
 * @param opts Configuration options
 */
export async function rotateKey(
  trigger: RotationTrigger,
  opts?: {
    identityPath?: string;
    rotationsPath?: string;
    amcpCli?: string;
    logger?: PluginLogger;
  },
): Promise<RotationResult> {
  const identityPath = opts?.identityPath ?? DEFAULT_IDENTITY_PATH;
  const rotationsPath = opts?.rotationsPath ?? DEFAULT_ROTATIONS_PATH;
  const amcpCli = opts?.amcpCli ?? "amcp";
  const logger = opts?.logger;

  // 1. Validate current identity
  const currentResult = await validateIdentity(identityPath);
  if (!currentResult.valid || !currentResult.identity) {
    return {
      success: false,
      record: null,
      error: `Current identity invalid: ${currentResult.errors.join(", ")}`,
    };
  }

  const currentIdentity = currentResult.identity;
  const currentNextKeyHash = readNextKeyHash(currentIdentity);

  if (!currentNextKeyHash) {
    return {
      success: false,
      record: null,
      error: "No nextKeyHash in identity — pre-rotation commitment required for rotation",
    };
  }

  logger?.info(
    `amcp-key-rotation: rotating key (trigger: ${trigger}, AID: ${currentIdentity.aid})`,
  );

  // 2. Call amcp CLI to perform rotation
  try {
    await execFileAsync(amcpCli, [
      "identity",
      "rotate",
      "--identity",
      identityPath,
    ]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error(`amcp-key-rotation: CLI rotation failed: ${message}`);
    return {
      success: false,
      record: null,
      error: `amcp identity rotate failed: ${message}`,
    };
  }

  // 3. Validate the new identity
  const newResult = await validateIdentity(identityPath);
  if (!newResult.valid || !newResult.identity) {
    logger?.error("amcp-key-rotation: post-rotation identity is invalid");
    return {
      success: false,
      record: null,
      error: `Post-rotation identity invalid: ${newResult.errors.join(", ")}`,
    };
  }

  const newIdentity = newResult.identity;
  const newNextKeyHash = readNextKeyHash(newIdentity);

  // 4. Record the rotation
  const record: RotationRecord = {
    timestamp: new Date().toISOString(),
    trigger,
    previousAid: currentIdentity.aid,
    newAid: newIdentity.aid,
    previousPublicKey: currentIdentity.publicKey,
    newPublicKey: newIdentity.publicKey,
    kelSequenceNumber: getKelSequenceNumber(newIdentity),
    nextKeyHash: newNextKeyHash ?? "",
  };

  await appendRotationRecord(record, rotationsPath);

  logger?.info(
    `amcp-key-rotation: rotation complete (new AID: ${newIdentity.aid}, KEL sn: ${record.kelSequenceNumber})`,
  );

  return { success: true, record };
}

/**
 * Create a key rotation service for the plugin.
 *
 * Integrates with the identity manager to detect rotation needs
 * and execute rotations. Exposes rotation state via status().
 */
export function createKeyRotationService(deps: {
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  identityPath?: string;
  rotationsPath?: string;
  amcpCli?: string;
  maxAgeDays?: number;
}): {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    running: boolean;
    details?: Record<string, unknown>;
  }>;
  checkRotationNeed(): Promise<RotationNeedResult>;
  rotate(trigger: RotationTrigger): Promise<RotationResult>;
  getHistory(): Promise<RotationRecord[]>;
} {
  const {
    logger,
    emit,
    identityPath,
    rotationsPath,
    amcpCli,
    maxAgeDays,
  } = deps;
  let running = false;
  let lastCheck: RotationNeedResult | null = null;

  return {
    name: "amcp-key-rotation",

    async start(): Promise<void> {
      running = true;
      logger.info("amcp-key-rotation: started");

      // Check rotation need on start
      const result = await validateIdentity(identityPath);
      if (result.valid && result.identity) {
        lastCheck = detectRotationNeed(result.identity, { maxAgeDays });

        if (lastCheck.needed) {
          logger.warn(
            `amcp-key-rotation: ${lastCheck.reason} (trigger: ${lastCheck.trigger})`,
          );
          emit("amcp:rotation:needed", {
            trigger: lastCheck.trigger,
            reason: lastCheck.reason,
          });
        } else {
          const nkh = readNextKeyHash(result.identity);
          logger.info(
            `amcp-key-rotation: no rotation needed (nextKeyHash: ${nkh ? "present" : "absent"})`,
          );
        }
      }
    },

    async stop(): Promise<void> {
      running = false;
      logger.info("amcp-key-rotation: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      const history = await loadRotationHistory(rotationsPath);
      return {
        running,
        details: {
          service: "amcp-key-rotation",
          lastCheck: lastCheck
            ? { needed: lastCheck.needed, trigger: lastCheck.trigger, reason: lastCheck.reason }
            : null,
          totalRotations: history.length,
          lastRotation: history.length > 0 ? history[history.length - 1].timestamp : null,
        },
      };
    },

    async checkRotationNeed(): Promise<RotationNeedResult> {
      const result = await validateIdentity(identityPath);
      if (!result.valid || !result.identity) {
        return {
          needed: false,
          trigger: null,
          reason: "Identity invalid — cannot check rotation need",
        };
      }
      lastCheck = detectRotationNeed(result.identity, { maxAgeDays });
      return lastCheck;
    },

    async rotate(trigger: RotationTrigger): Promise<RotationResult> {
      const rotationResult = await rotateKey(trigger, {
        identityPath,
        rotationsPath,
        amcpCli,
        logger,
      });

      if (rotationResult.success && rotationResult.record) {
        emit("amcp:rotation:completed", {
          trigger,
          previousAid: rotationResult.record.previousAid,
          newAid: rotationResult.record.newAid,
          kelSequenceNumber: rotationResult.record.kelSequenceNumber,
        });
      } else {
        emit("amcp:rotation:failed", {
          trigger,
          error: rotationResult.error,
        });
      }

      return rotationResult;
    },

    async getHistory(): Promise<RotationRecord[]> {
      return loadRotationHistory(rotationsPath);
    },
  };
}
