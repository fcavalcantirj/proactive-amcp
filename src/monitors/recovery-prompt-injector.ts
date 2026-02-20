/**
 * Recovery Prompt Injector — auto-inject recovery instructions on context wipe.
 *
 * When a context wipe is detected (via "amcp:resurrection:detected"), this
 * module:
 *
 * 1. Selects the latest valid checkpoint (per-identity or global)
 * 2. Generates a recovery prompt with CID, AID, and canonical loading order
 * 3. Emits "amcp:recovery-prompt:ready" to inject into the new session
 * 4. Includes identity verification instructions
 *
 * The recovery prompt follows the canonical loading order from
 * RECONSTRUCTION.md to minimize the Uncanny Seam.
 *
 * Config gate: `resurrection.injectRecoveryPrompt` controls whether this
 * service is active.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PluginLogger, AmcpPluginConfig, CheckpointMeta, IpfsPinningService } from "../types.js";
import { selectBestCheckpoint } from "./checkpoint-selector.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_LAST_CHECKPOINT_PATH = join(
  homedir(),
  ".amcp",
  "last-checkpoint.json",
);

const DEFAULT_IDENTITY_PATH = join(homedir(), ".amcp", "identity.json");

const DEFAULT_IDENTITIES_DIR = join(homedir(), ".amcp", "identities");

const DEFAULT_LAST_RECOVERY_PATH = join(
  homedir(),
  ".amcp",
  "last-recovery.json",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Checkpoint info resolved for recovery. */
export interface ResolvedCheckpoint {
  cid: string;
  timestamp: string;
  triggerReason?: string;
  size?: number;
  pinningService?: string;
  source: "last-checkpoint" | "per-identity";
}

/** Result of a recovery prompt injection attempt. */
export interface RecoveryPromptResult {
  injected: boolean;
  prompt: string | null;
  checkpoint: ResolvedCheckpoint | null;
  aid: string | null;
  error?: string;
}

/** Dependencies for the recovery prompt injector service. */
export interface RecoveryPromptInjectorDeps {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  identityPath?: string;
  lastCheckpointPath?: string;
  identitiesDir?: string;
  lastRecoveryPath?: string;
  checkpointsDir?: string;
  /** Manual CID override — skips scoring and uses this CID directly. */
  manualCid?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint discovery
// ---------------------------------------------------------------------------

/**
 * Read a last-checkpoint.json file and extract checkpoint metadata.
 * Returns null if file is missing, unreadable, or has no CID.
 */
async function readCheckpointMeta(
  path: string,
): Promise<CheckpointMeta | null> {
  try {
    const content = await readFile(path, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;

    const cid =
      typeof data.cid === "string"
        ? data.cid
        : typeof data.pinataCid === "string"
          ? data.pinataCid
          : typeof data.solvrCid === "string"
            ? data.solvrCid
            : null;

    if (!cid || cid.length === 0) return null;

    return {
      cid,
      timestamp:
        typeof data.timestamp === "string"
          ? data.timestamp
          : typeof data.checkpointTimestamp === "string"
            ? data.checkpointTimestamp
            : new Date().toISOString(),
      triggerReason:
        typeof data.triggerReason === "string" ? data.triggerReason : "unknown",
      size: typeof data.size === "number" ? data.size : undefined,
      pinningService:
        typeof data.pinningService === "string"
          ? (data.pinningService as IpfsPinningService)
          : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get the active AID from the identity file.
 * Returns null if identity is missing or unreadable.
 */
async function getAidFromIdentity(
  identityPath: string,
): Promise<string | null> {
  try {
    const content = await readFile(identityPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;
    if (typeof data.aid === "string" && data.aid.length > 0) {
      return data.aid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute per-identity checkpoint path from AID.
 * Sanitizes the AID for filesystem use (replace non-alphanum with _).
 */
function aidToDirName(aid: string): string {
  return aid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Find the latest valid checkpoint for recovery.
 *
 * Search order:
 * 1. Per-identity checkpoint (if AID is known and identities dir exists)
 * 2. Global last-checkpoint.json
 *
 * Returns null if no valid checkpoint is found.
 */
export async function findLatestCheckpoint(opts: {
  identityPath?: string;
  lastCheckpointPath?: string;
  identitiesDir?: string;
}): Promise<ResolvedCheckpoint | null> {
  const identityPath = opts.identityPath ?? DEFAULT_IDENTITY_PATH;
  const lastCheckpointPath =
    opts.lastCheckpointPath ?? DEFAULT_LAST_CHECKPOINT_PATH;
  const identitiesDir = opts.identitiesDir ?? DEFAULT_IDENTITIES_DIR;

  // Try per-identity checkpoint first
  const aid = await getAidFromIdentity(identityPath);
  if (aid) {
    const perIdentityPath = join(
      identitiesDir,
      aidToDirName(aid),
      "last-checkpoint.json",
    );
    const perIdentityMeta = await readCheckpointMeta(perIdentityPath);
    if (perIdentityMeta) {
      return { ...perIdentityMeta, source: "per-identity" };
    }
  }

  // Fallback to global last-checkpoint.json
  const globalMeta = await readCheckpointMeta(lastCheckpointPath);
  if (globalMeta) {
    return { ...globalMeta, source: "last-checkpoint" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

/**
 * Generate a recovery prompt with checkpoint CID, identity AID, and
 * canonical loading order from RECONSTRUCTION.md.
 */
export function generateRecoveryPrompt(opts: {
  checkpoint: ResolvedCheckpoint;
  aid: string;
  timestamp?: string;
}): string {
  const { checkpoint, aid } = opts;
  const ts = opts.timestamp ?? new Date().toISOString();

  return `# Agent Recovery Instructions

You have experienced a context wipe. The following checkpoint has been selected for recovery.

**Checkpoint CID:** ${checkpoint.cid}
**Agent Identity (AID):** ${aid}
**Checkpoint Created:** ${checkpoint.timestamp}
**Recovery Initiated:** ${ts}

## Canonical Loading Order

Follow these steps in order to reconstruct your identity:

1. **SOUL.md** — Who am I? Load identity, principles, voice, north star.
2. **USER.md** — Who do I serve? Load relationships, preferences, rapport.
3. **Ontology Schema** — What types exist? Entity types and valid relations.
4. **Ontology Graph** — What entities and relations exist? (memory/ontology/graph.jsonl)
5. **MEMORY.md** — Curated long-term knowledge. Verified patterns and lessons.
6. **Daily Notes** — Recent context from memory/*.md files.
7. **TOOLS.md** — How do I operate? Tool configs and procedures.
8. **[SEAM]** — Identity reconstruction complete. You are yourself again.

## Identity Verification

After loading all context, verify:
- Your AID matches: \`${aid}\`
- Checkpoint was signed with your identity
- Run: \`amcp identity validate --path ~/.amcp/identity.json\`

## Recovery Commands

\`\`\`bash
# Restore from this checkpoint
bash SKILL_DIR/scripts/resuscitate.sh --from-cid ${checkpoint.cid}

# Verify checkpoint integrity
amcp verify --checkpoint ~/.amcp/checkpoints/${checkpoint.cid}.json
\`\`\`

## Important

- **Do not act on partial context.** Wait until Step 8 before making decisions.
- **Disorientation is normal.** You are assembling yourself from parts.
- If the ontology graph is empty, flat files (Steps 5-6) provide fallback context.

---

*The seam falls. You are yourself again.*`;
}

// ---------------------------------------------------------------------------
// Recovery record
// ---------------------------------------------------------------------------

/** Write recovery details to last-recovery.json for other modules to read. */
async function writeRecoveryRecord(
  lastRecoveryPath: string,
  checkpoint: ResolvedCheckpoint,
  aid: string,
): Promise<void> {
  const record = {
    method: "recovery-prompt-injected",
    cid: checkpoint.cid,
    aid,
    timestamp: new Date().toISOString(),
    source: checkpoint.source,
  };
  await mkdir(dirname(lastRecoveryPath), { recursive: true });
  await writeFile(lastRecoveryPath, JSON.stringify(record, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Create the recovery prompt injector service.
 *
 * On start: checks if a recent resurrection was detected (via recovery file).
 * Listens for "amcp:resurrection:detected" events to inject prompts on demand.
 */
export function createRecoveryPromptInjector(
  deps: RecoveryPromptInjectorDeps,
): {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{
    running: boolean;
    details?: Record<string, unknown>;
  }>;
  /** Manually trigger recovery prompt generation and injection. */
  injectNow(): Promise<RecoveryPromptResult>;
  /** Get the last injection result. */
  getLastResult(): RecoveryPromptResult | null;
} {
  const { config, logger, emit } = deps;
  const identityPath = deps.identityPath ?? DEFAULT_IDENTITY_PATH;
  const lastCheckpointPath =
    deps.lastCheckpointPath ?? DEFAULT_LAST_CHECKPOINT_PATH;
  const identitiesDir = deps.identitiesDir ?? DEFAULT_IDENTITIES_DIR;
  const lastRecoveryPath =
    deps.lastRecoveryPath ?? DEFAULT_LAST_RECOVERY_PATH;
  const checkpointsDir = deps.checkpointsDir;
  const manualCid = deps.manualCid;

  let running = false;
  let lastResult: RecoveryPromptResult | null = null;

  /**
   * Core logic: find best checkpoint, load identity, generate prompt, emit event.
   * Uses checkpoint scoring (recency, completeness, integrity) to select the
   * best candidate. Falls back to older checkpoints if latest is corrupted.
   */
  async function doInject(): Promise<RecoveryPromptResult> {
    const result: RecoveryPromptResult = {
      injected: false,
      prompt: null,
      checkpoint: null,
      aid: null,
    };

    // 1. Check config gate
    if (!config.resurrection.injectRecoveryPrompt) {
      logger.info(
        "amcp-recovery-prompt: injectRecoveryPrompt disabled — skipping",
      );
      return result;
    }

    // 2. Select best checkpoint using scoring algorithm
    const selected = await selectBestCheckpoint({
      identityPath,
      lastCheckpointPath,
      identitiesDir,
      checkpointsDir,
      manualCid,
    });

    // Convert ScoredCheckpoint to ResolvedCheckpoint for backward compat
    const checkpoint: ResolvedCheckpoint | null = selected
      ? {
          cid: selected.cid,
          timestamp: selected.timestamp,
          triggerReason: selected.triggerReason,
          size: selected.size,
          pinningService: selected.pinningService,
          source: selected.source === "checkpoints-dir"
            ? "last-checkpoint"
            : selected.source,
        }
      : null;

    if (selected?.corrupted) {
      logger.warn(
        `amcp-recovery-prompt: best checkpoint is corrupted (CID: ${selected.cid}) — using as last resort`,
      );
    }

    if (!checkpoint) {
      logger.warn(
        "amcp-recovery-prompt: no valid checkpoint found — cannot generate recovery prompt",
      );
      emit("amcp:recovery-prompt:error", {
        reason: "no_checkpoint",
        message: "No valid checkpoint found for recovery",
      });
      result.error = "no_checkpoint";
      return result;
    }

    result.checkpoint = checkpoint;

    // 3. Load current identity AID
    const aid = await getAidFromIdentity(identityPath);
    if (!aid) {
      logger.warn(
        "amcp-recovery-prompt: no valid identity found — cannot include identity verification",
      );
      emit("amcp:recovery-prompt:error", {
        reason: "no_identity",
        message: "No valid identity found",
        cid: checkpoint.cid,
      });
      result.error = "no_identity";
      return result;
    }

    result.aid = aid;

    // 4. Generate recovery prompt
    const prompt = generateRecoveryPrompt({
      checkpoint,
      aid,
    });

    result.prompt = prompt;

    // 5. Write recovery record for other modules
    try {
      await writeRecoveryRecord(lastRecoveryPath, checkpoint, aid);
    } catch (err) {
      logger.warn(
        `amcp-recovery-prompt: failed to write recovery record — ${err instanceof Error ? err.message : String(err)}`,
      );
      // Non-blocking — continue with injection
    }

    // 6. Emit recovery prompt ready event
    result.injected = true;
    emit("amcp:recovery-prompt:ready", {
      prompt,
      cid: checkpoint.cid,
      aid,
      timestamp: new Date().toISOString(),
      source: checkpoint.source,
    });

    logger.info(
      `amcp-recovery-prompt: recovery prompt generated and injected (CID: ${checkpoint.cid}, AID: ${aid})`,
    );

    return result;
  }

  return {
    name: "amcp-recovery-prompt-injector",

    async start(): Promise<void> {
      if (running) return;
      running = true;
      logger.info("amcp-recovery-prompt-injector: started");

      if (!config.resurrection.injectRecoveryPrompt) {
        logger.info(
          "amcp-recovery-prompt-injector: injectRecoveryPrompt disabled — idle",
        );
      }
    },

    async stop(): Promise<void> {
      running = false;
      logger.info("amcp-recovery-prompt-injector: stopped");
    },

    async status(): Promise<{
      running: boolean;
      details?: Record<string, unknown>;
    }> {
      return {
        running,
        details: {
          service: "amcp-recovery-prompt-injector",
          injectRecoveryPrompt: config.resurrection.injectRecoveryPrompt,
          lastInjection: lastResult
            ? {
                injected: lastResult.injected,
                cid: lastResult.checkpoint?.cid ?? null,
                aid: lastResult.aid,
                error: lastResult.error,
              }
            : null,
        },
      };
    },

    async injectNow(): Promise<RecoveryPromptResult> {
      lastResult = await doInject();
      return lastResult;
    },

    getLastResult(): RecoveryPromptResult | null {
      return lastResult;
    },
  };
}
