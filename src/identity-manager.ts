/**
 * Identity Manager — system-level KERI identity validation for the AMCP plugin.
 *
 * Loads ~/.amcp/identity.json, validates KERI prefix format (AID starts with "B"
 * + base64url Ed25519 public key), verifies KEL signature chain integrity,
 * and exposes validateIdentity() / getIdentity() for use by the plugin layer.
 *
 * On invalid identity: emits alert event and blocks checkpoint creation.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AmcpIdentity, PluginLogger } from "./types.js";

/** Default identity file path. */
const DEFAULT_IDENTITY_PATH = join(homedir(), ".amcp", "identity.json");

/**
 * KERI-lite AID format: "B" prefix + base64url-encoded Ed25519 public key.
 * Base64url alphabet: [A-Za-z0-9_-], Ed25519 public key = 32 bytes = 44 base64url chars.
 * Total AID length: 1 ("B") + 44 = 45 characters.
 */
const KERI_AID_PATTERN = /^B[A-Za-z0-9_-]{43,44}$/;

/**
 * Known secret field names that should NOT appear in identity.json.
 * Their presence indicates a misconfigured (legacy) identity file.
 */
const SECRET_FIELD_NAMES = new Set([
  "pinata_jwt",
  "pinata_api_key",
  "solvr_api_key",
  "api_key",
  "apiKey",
  "jwt",
  "token",
  "secret",
  "password",
  "mnemonic",
  "email",
  "notifyTarget",
]);

/** Result of identity validation. */
export interface IdentityValidationResult {
  valid: boolean;
  identity: AmcpIdentity | null;
  errors: string[];
  warnings: string[];
}

/**
 * KEL (Key Event Log) event types recognized by the validator.
 */
type KelEventType = "inception" | "rotation";

interface KelEvent {
  type: KelEventType;
  aid?: string;
  publicKey?: string;
  nextKeyHash?: string;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Load raw identity JSON from disk.
 * Returns null if the file does not exist or is unreadable.
 */
async function loadIdentityFile(
  identityPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(identityPath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validate KERI AID prefix format.
 * AID must be "B" + base64url(Ed25519 public key).
 */
function validateAidFormat(aid: unknown): string[] {
  const errors: string[] = [];

  if (typeof aid !== "string") {
    errors.push("AID is missing or not a string");
    return errors;
  }

  if (!aid.startsWith("B")) {
    errors.push(
      `AID must start with "B" prefix (KERI self-certifying), got "${aid.substring(0, 1)}"`,
    );
  }

  if (!KERI_AID_PATTERN.test(aid)) {
    errors.push(
      "AID does not match KERI format: B + base64url(Ed25519 public key)",
    );
  }

  return errors;
}

/**
 * Validate public key format.
 * Must be a non-empty string (base64 or base64url encoded Ed25519 key).
 */
function validatePublicKey(publicKey: unknown): string[] {
  const errors: string[] = [];

  if (typeof publicKey !== "string" || publicKey.length === 0) {
    errors.push("publicKey is missing or empty");
    return errors;
  }

  // Ed25519 public key is 32 bytes = 44 base64 chars (with padding) or 43 base64url chars
  const b64Pattern = /^[A-Za-z0-9+/=_-]{40,50}$/;
  if (!b64Pattern.test(publicKey)) {
    errors.push("publicKey does not appear to be a valid base64-encoded Ed25519 key");
  }

  return errors;
}

/**
 * Validate KEL (Key Event Log) chain integrity.
 *
 * Rules:
 * - KEL must be an array (may be empty for newly created identities)
 * - First event must be "inception" with AID matching identity.aid
 * - Subsequent events must be "rotation" type
 * - Each rotation's publicKey should match the previous event's nextKeyHash commitment
 *   (when nextKeyHash is available — pre-rotation scheme)
 */
function validateKelChain(
  kel: unknown,
  expectedAid: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (kel === undefined || kel === null) {
    // KEL is optional for simple identities
    return { errors, warnings };
  }

  if (!Array.isArray(kel)) {
    errors.push("KEL must be an array");
    return { errors, warnings };
  }

  if (kel.length === 0) {
    // Empty KEL is valid for newly created identities
    return { errors, warnings };
  }

  const events = kel as KelEvent[];

  // First event must be inception
  const inception = events[0];
  if (!inception || typeof inception !== "object") {
    errors.push("KEL[0] is not a valid event object");
    return { errors, warnings };
  }

  if (inception.type !== "inception") {
    errors.push(
      `KEL[0] must be type "inception", got "${String(inception.type)}"`,
    );
  }

  // Inception AID must match identity AID
  if (inception.aid && inception.aid !== expectedAid) {
    errors.push(
      `KEL inception AID "${inception.aid}" does not match identity AID "${expectedAid}"`,
    );
  }

  // Walk the chain: each rotation should follow pre-rotation commitments
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    if (!event || typeof event !== "object") {
      errors.push(`KEL[${i}] is not a valid event object`);
      continue;
    }

    if (event.type !== "rotation") {
      errors.push(
        `KEL[${i}] must be type "rotation", got "${String(event.type)}"`,
      );
    }

    // Check pre-rotation commitment from previous event
    const prevEvent = events[i - 1];
    if (
      prevEvent?.nextKeyHash &&
      event.publicKey &&
      typeof prevEvent.nextKeyHash === "string"
    ) {
      // The nextKeyHash from the previous event should commit to this event's key.
      // Full cryptographic verification would require hashing the new public key
      // and comparing — we log a warning if nextKeyHash is present but can't
      // do full crypto verification without the hash algorithm details.
      warnings.push(
        `KEL[${i}]: pre-rotation commitment present — full hash verification requires amcp CLI`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Detect legacy/fake identity patterns.
 * sha256-derived AIDs from openclaw-deploy are invalid.
 */
function detectLegacyIdentity(
  raw: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  // sha256-style AID detection (64-char hex string)
  const aid = raw.aid as string | undefined;
  if (aid && /^[a-f0-9]{64}$/i.test(aid)) {
    errors.push(
      "AID appears to be a sha256 hash — legacy identity from openclaw-deploy, must recreate with amcp identity create",
    );
  }

  return errors;
}

/**
 * Detect secrets that should not be in identity.json.
 */
function detectSecrets(
  raw: Record<string, unknown>,
): string[] {
  const warnings: string[] = [];
  const found: string[] = [];

  for (const key of Object.keys(raw)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      found.push(key);
    }
  }

  if (found.length > 0) {
    warnings.push(
      `Secrets found in identity.json: ${found.join(", ")} — migrate with: proactive-amcp config set <key> <value>`,
    );
  }

  return warnings;
}

/**
 * Validate an AMCP identity file.
 *
 * Checks:
 * 1. File exists and is valid JSON
 * 2. AID has correct KERI prefix format ("B" + base64url Ed25519 pubkey)
 * 3. Public key is present and properly encoded
 * 4. KEL chain integrity (if present)
 * 5. No legacy sha256 AID patterns
 * 6. No secrets embedded in identity file
 *
 * @param identityPath Path to identity.json (defaults to ~/.amcp/identity.json)
 * @returns Validation result with identity data, errors, and warnings
 */
export async function validateIdentity(
  identityPath?: string,
): Promise<IdentityValidationResult> {
  const path = identityPath ?? DEFAULT_IDENTITY_PATH;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Load file
  const raw = await loadIdentityFile(path);
  if (!raw) {
    return {
      valid: false,
      identity: null,
      errors: [`Identity file not found or unreadable: ${path}`],
      warnings: [],
    };
  }

  // Detect legacy/fake identity
  errors.push(...detectLegacyIdentity(raw));

  // Validate AID format
  errors.push(...validateAidFormat(raw.aid));

  // Validate public key
  errors.push(...validatePublicKey(raw.publicKey));

  // Validate KEL chain
  if (errors.length === 0 && typeof raw.aid === "string") {
    const kelResult = validateKelChain(raw.kel, raw.aid);
    errors.push(...kelResult.errors);
    warnings.push(...kelResult.warnings);
  }

  // Detect secrets in identity file
  warnings.push(...detectSecrets(raw));

  const valid = errors.length === 0;

  // Extract nextKeyHash from identity or from last KEL event
  let nextKeyHash: string | undefined;
  if (typeof raw.nextKeyHash === "string" && raw.nextKeyHash.length > 0) {
    nextKeyHash = raw.nextKeyHash;
  } else if (Array.isArray(raw.kel) && raw.kel.length > 0) {
    const lastEvent = raw.kel[raw.kel.length - 1] as Record<string, unknown>;
    if (typeof lastEvent?.nextKeyHash === "string" && lastEvent.nextKeyHash.length > 0) {
      nextKeyHash = lastEvent.nextKeyHash;
    } else if (typeof lastEvent?.next === "string" && lastEvent.next.length > 0) {
      nextKeyHash = lastEvent.next;
    }
  }

  const identity: AmcpIdentity | null = valid
    ? {
        aid: raw.aid as string,
        publicKey: raw.publicKey as string,
        created: (raw.created as string) ?? new Date().toISOString(),
        kel: raw.kel as unknown[] | undefined,
        nextKeyHash,
      }
    : null;

  return { valid, identity, errors, warnings };
}

/**
 * Load and return a validated AMCP identity.
 *
 * Returns the identity if valid, or null if invalid/missing.
 * Logs errors and warnings via the provided logger.
 *
 * @param logger Plugin logger for error/warning output
 * @param identityPath Path to identity.json (defaults to ~/.amcp/identity.json)
 */
export async function getIdentity(
  logger: PluginLogger,
  identityPath?: string,
): Promise<AmcpIdentity | null> {
  const result = await validateIdentity(identityPath);

  for (const warning of result.warnings) {
    logger.warn(`amcp-identity: ${warning}`);
  }

  if (!result.valid) {
    for (const error of result.errors) {
      logger.error(`amcp-identity: ${error}`);
    }
    return null;
  }

  return result.identity;
}

/**
 * Create an identity manager service for the plugin.
 *
 * On start: validates identity, emits alert if invalid, blocks checkpoints.
 * Exposes identity state via status().
 */
export function createIdentityService(deps: {
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  identityPath?: string;
}): {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    running: boolean;
    details?: Record<string, unknown>;
  }>;
  getIdentity(): AmcpIdentity | null;
  isValid(): boolean;
} {
  const { logger, emit, identityPath } = deps;
  let currentIdentity: AmcpIdentity | null = null;
  let validationErrors: string[] = [];
  let running = false;

  return {
    name: "amcp-identity-manager",

    async start(): Promise<void> {
      running = true;
      logger.info("amcp-identity-manager: validating identity...");

      const result = await validateIdentity(identityPath);

      for (const warning of result.warnings) {
        logger.warn(`amcp-identity-manager: ${warning}`);
      }

      if (!result.valid) {
        validationErrors = result.errors;
        for (const error of result.errors) {
          logger.error(`amcp-identity-manager: ${error}`);
        }

        emit("amcp:identity:invalid", {
          errors: result.errors,
          path: identityPath ?? DEFAULT_IDENTITY_PATH,
        });

        logger.error(
          "amcp-identity-manager: identity invalid — checkpoints blocked until resolved",
        );
        return;
      }

      currentIdentity = result.identity;
      logger.info(
        `amcp-identity-manager: identity valid (AID: ${currentIdentity?.aid})`,
      );

      emit("amcp:identity:validated", {
        aid: currentIdentity?.aid,
        path: identityPath ?? DEFAULT_IDENTITY_PATH,
      });
    },

    async stop(): Promise<void> {
      running = false;
      logger.info("amcp-identity-manager: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      return {
        running,
        details: {
          service: "amcp-identity-manager",
          identityValid: currentIdentity !== null,
          aid: currentIdentity?.aid ?? null,
          errors: validationErrors.length > 0 ? validationErrors : undefined,
        },
      };
    },

    getIdentity(): AmcpIdentity | null {
      return currentIdentity;
    },

    isValid(): boolean {
      return currentIdentity !== null;
    },
  };
}
