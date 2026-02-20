/**
 * proactive-amcp — OpenClaw Plugin Entry Point
 *
 * Code-level enforcement layer for the Agent Memory Continuity Protocol.
 * Works alongside the bash skill layer (SKILL.md) for two-layer defense:
 *   - Plugin (this): system-level hooks, monitors, CLI commands
 *   - Skill (bash): checkpoint creation, secrets, resurrection logic
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { createContextMonitor } from "./monitors/context-monitor.js";
import { createValueMonitor } from "./monitors/value-monitor.js";
import { createIdentityService } from "./identity-manager.js";
import { createKeyRotationService } from "./key-rotation.js";
import { createResurrectionIdentityService } from "./monitors/resurrection-identity.js";
import { createResurrectionDetector } from "./monitors/resurrection-detector.js";
import { createMultiIdentityService } from "./multi-identity.js";
import { createRecoveryPromptInjector } from "./monitors/recovery-prompt-injector.js";
import { createPartialResurrectionService } from "./monitors/partial-resurrection.js";
import {
  createMemoryIntegrityMonitor,
  DEFAULT_BASELINE_PATH,
} from "./monitors/memory-integrity.js";
import type {
  AmcpPlugin,
  AmcpPluginConfig,
  PluginApi,
  PluginService,
  LifecycleEvent,
  SessionApi,
  FileWatcher,
} from "./types.js";

const PLUGIN_ID = "proactive-amcp";
const PLUGIN_NAME = "Proactive AMCP";
const PLUGIN_VERSION = "1.0.0";

const DEFAULT_CONFIG: AmcpPluginConfig = {
  enabled: true,
  autoCheckpoint: true,
  checkpointIntervalMs: 0,
  contextThreshold: 70,
  ipfsPinningService: "solvr",
  encryptionKeyPath: "~/.amcp/identity.json",
  checkpointCooldownMs: 300_000,
  memoryIntegrity: {
    enabled: true,
    promptInjectionScan: true,
    autoRestore: false,
  },
  identity: {
    autoInject: true,
    verifyOnStart: true,
  },
  resurrection: {
    autoDetect: true,
    injectRecoveryPrompt: true,
  },
};

/**
 * Merge user-provided config with defaults, handling nested objects.
 */
function resolveConfig(
  userConfig: Partial<AmcpPluginConfig>,
): AmcpPluginConfig {
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    memoryIntegrity: {
      ...DEFAULT_CONFIG.memoryIntegrity,
      ...(userConfig.memoryIntegrity ?? {}),
    },
    identity: {
      ...DEFAULT_CONFIG.identity,
      ...(userConfig.identity ?? {}),
    },
    resurrection: {
      ...DEFAULT_CONFIG.resurrection,
      ...(userConfig.resurrection ?? {}),
    },
  };
}

/**
 * Build a default SessionApi that returns zero usage.
 * The gateway may provide a real implementation via api.sessionApi.
 */
function defaultSessionApi(): SessionApi {
  return {
    async getContextUsage() {
      return { usedTokens: 0, maxTokens: 0 };
    },
  };
}

/** Default path for context history JSONL file. */
const DEFAULT_HISTORY_PATH = join(homedir(), ".amcp", "context-history.jsonl");

/** Default path for checkpoint trigger log. */
const DEFAULT_CHECKPOINT_LOG_PATH = join(
  homedir(),
  ".amcp",
  "checkpoint-log.jsonl",
);

/** Default paths watched by the value monitor for high-value content changes. */
const DEFAULT_VALUE_WATCH_PATHS = [
  join(homedir(), ".amcp", "identity.json"),
  join(homedir(), ".openclaw", "workspace", "SOUL.md"),
  join(homedir(), ".openclaw", "workspace", "MEMORY.md"),
  join(homedir(), ".openclaw", "workspace", "USER.md"),
  join(homedir(), ".openclaw", "workspace", "AGENTS.md"),
  join(homedir(), ".openclaw", "workspace", "TOOLS.md"),
];

/**
 * Build a default FileWatcher that reads files from disk and computes hashes.
 * The gateway may provide a real implementation via api.fileWatcher.
 */
function defaultFileWatcher(watchPaths: string[]): FileWatcher {
  // Lazy imports — only loaded if the default watcher is actually used
  const fsPromises = () => import("node:fs/promises");
  const cryptoMod = () => import("node:crypto");

  return {
    async getFileHashes(): Promise<Map<string, string>> {
      const fs = await fsPromises();
      const crypto = await cryptoMod();
      const result = new Map<string, string>();
      for (const filePath of watchPaths) {
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const hash = crypto.createHash("sha256").update(content).digest("hex");
          result.set(filePath, hash);
        } catch {
          // File missing or unreadable — omit from results
        }
      }
      return result;
    },
    async readFile(filePath: string): Promise<string | null> {
      const fs = await fsPromises();
      try {
        return await fs.readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Register lifecycle hooks for checkpoint triggers.
 */
function registerHooks(
  api: PluginApi,
  config: AmcpPluginConfig,
): void {
  if (!config.autoCheckpoint) return;

  api.registerHook("gateway_start", (_event: LifecycleEvent) => {
    api.logger.info("amcp: gateway_start — checkpoint queued");
    api.emit("amcp:checkpoint:requested", { trigger: "gateway_start" });
  });

  api.registerHook("gateway_stop", (_event: LifecycleEvent) => {
    api.logger.info("amcp: gateway_stop — checkpoint queued");
    api.emit("amcp:checkpoint:requested", { trigger: "gateway_stop" });
  });

  api.registerHook("session_end", (_event: LifecycleEvent) => {
    api.logger.info("amcp: session_end — checkpoint queued");
    api.emit("amcp:checkpoint:requested", { trigger: "session_end" });
  });

  api.registerHook("before_compaction", (_event: LifecycleEvent) => {
    api.logger.info("amcp: before_compaction — emergency checkpoint queued");
    api.emit("amcp:checkpoint:requested", {
      trigger: "before_compaction",
      priority: "high",
    });
  });
}

/**
 * Register CLI commands under the 'amcp' namespace.
 */
function registerCliCommands(api: PluginApi): void {
  const commands = [
    { name: "status", description: "Show AMCP status, last checkpoint, identity" },
    { name: "checkpoint", description: "Create a manual checkpoint" },
    { name: "resurrect", description: "Restore from a checkpoint" },
    { name: "identity", description: "Identity management (show, rotate, verify, export)" },
    { name: "history", description: "Show checkpoint history" },
    { name: "verify", description: "Verify checkpoint integrity" },
  ];

  for (const cmd of commands) {
    api.registerCommand("amcp", {
      name: cmd.name,
      description: cmd.description,
      async handler(args: string[]) {
        api.logger.info(`amcp ${cmd.name}: ${args.join(" ") || "(no args)"}`);
      },
    });
  }
}

/**
 * The AMCP plugin — register function called by OpenClaw gateway.
 */
async function register(api: PluginApi): Promise<void> {
  const config = resolveConfig(api.config);

  if (!config.enabled) {
    api.logger.info("amcp: plugin disabled via config");
    return;
  }

  api.logger.info(`amcp: initializing plugin v${PLUGIN_VERSION}`);

  // Register services — gateway may extend PluginApi with sessionApi/amcpHistoryPath
  const apiExt = api as unknown as Record<string, unknown>;
  const sessionApi: SessionApi =
    (apiExt.sessionApi as SessionApi) ?? defaultSessionApi();
  const historyPath =
    (apiExt.amcpHistoryPath as string) ?? DEFAULT_HISTORY_PATH;
  const checkpointLogPath =
    (apiExt.amcpCheckpointLogPath as string) ?? DEFAULT_CHECKPOINT_LOG_PATH;

  const contextMonitor = createContextMonitor({
    config,
    logger: api.logger,
    emit: api.emit.bind(api),
    sessionApi,
    historyPath,
    checkpointLogPath,
  });

  // Value monitor — watches memory files for high-value content changes
  const watchPaths =
    (apiExt.amcpValueWatchPaths as string[]) ?? DEFAULT_VALUE_WATCH_PATHS;
  const fileWatcher: FileWatcher =
    (apiExt.fileWatcher as FileWatcher) ?? defaultFileWatcher(watchPaths);
  const valueMonitor = createValueMonitor({
    config,
    logger: api.logger,
    emit: api.emit.bind(api),
    fileWatcher,
    checkpointLogPath,
    watchPaths,
  });

  // Memory integrity — baseline hashing + change detection for memory files
  const baselinePath =
    (apiExt.amcpBaselinePath as string) ?? DEFAULT_BASELINE_PATH;
  const contentDir =
    (apiExt.amcpContentDir as string) ??
    join(homedir(), ".openclaw", "workspace");
  const memoryMonitor = createMemoryIntegrityMonitor({
    config,
    logger: api.logger,
    emit: api.emit.bind(api),
    contentDir,
    baselinePath,
  });

  // Identity manager — validates KERI identity on start, blocks checkpoints if invalid
  const identityPath =
    (apiExt.amcpIdentityPath as string) ??
    join(homedir(), ".amcp", "identity.json");
  const identityService = createIdentityService({
    logger: api.logger,
    emit: api.emit.bind(api),
    identityPath,
  });

  // Key rotation — handles pre-rotation keys, detects rotation need, performs rotation
  const amcpCli =
    (apiExt.amcpCli as string) ?? undefined;
  const keyRotationService = createKeyRotationService({
    logger: api.logger,
    emit: api.emit.bind(api),
    identityPath,
    amcpCli,
  });

  // Resurrection identity — auto-inject and verify identity after recovery
  const lastRecoveryPath =
    (apiExt.amcpLastRecoveryPath as string) ??
    join(homedir(), ".amcp", "last-recovery.json");
  const lastCheckpointPath =
    (apiExt.amcpLastCheckpointPath as string) ??
    join(homedir(), ".amcp", "last-checkpoint.json");
  const resurrectionIdentityService = createResurrectionIdentityService({
    logger: api.logger,
    emit: api.emit.bind(api),
    identityPath,
    lastRecoveryPath,
    lastCheckpointPath,
  });

  // Resurrection detector — monitors context for sudden drops indicating wipe/compaction
  const resurrectionLogPath =
    (apiExt.amcpResurrectionLogPath as string) ??
    join(homedir(), ".amcp", "resurrection-log.jsonl");
  const resurrectionDetector = createResurrectionDetector({
    config,
    logger: api.logger,
    emit: api.emit.bind(api),
    sessionApi,
    logPath: resurrectionLogPath,
  });

  // Multi-identity — stores identities by AID, supports switching, blocks cross-identity resurrection
  const identitiesDir =
    (apiExt.amcpIdentitiesDir as string) ??
    join(homedir(), ".amcp", "identities");
  const multiIdentityService = createMultiIdentityService({
    logger: api.logger,
    emit: api.emit.bind(api),
    identitiesDir,
    identityPath,
  });

  // Recovery prompt injector — auto-inject recovery instructions on context wipe
  const recoveryPromptInjector = createRecoveryPromptInjector({
    config,
    logger: api.logger,
    emit: api.emit.bind(api),
    identityPath,
    lastCheckpointPath,
    identitiesDir,
    lastRecoveryPath,
  });

  // Partial resurrection — restore specific memories from a checkpoint
  const partialResurrectionService = createPartialResurrectionService({
    config,
    logger: api.logger,
    emit: api.emit.bind(api),
    contentDir,
  });

  api.registerService(contextMonitor);
  api.registerService(valueMonitor);
  api.registerService(memoryMonitor);
  api.registerService(identityService);
  api.registerService(keyRotationService);
  api.registerService(resurrectionIdentityService);
  api.registerService(resurrectionDetector);
  api.registerService(multiIdentityService);
  api.registerService(recoveryPromptInjector);
  api.registerService(partialResurrectionService);

  // Register lifecycle hooks
  registerHooks(api, config);

  // Register CLI commands
  registerCliCommands(api);

  api.logger.info("amcp: plugin registered successfully");
}

const plugin: AmcpPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "Agent Memory Continuity Protocol — encrypted checkpoints, identity verification, memory integrity, resurrection detection",
  register,
};

export default plugin;

export {
  register,
  resolveConfig,
  DEFAULT_CONFIG,
  PLUGIN_ID,
  PLUGIN_VERSION,
  DEFAULT_CHECKPOINT_LOG_PATH,
};
export { createContextMonitor } from "./monitors/context-monitor.js";
export { createValueMonitor } from "./monitors/value-monitor.js";
export {
  validateIdentity,
  getIdentity,
  createIdentityService,
} from "./identity-manager.js";
export {
  readNextKeyHash,
  detectRotationNeed,
  rotateKey,
  loadRotationHistory,
  createKeyRotationService,
} from "./key-rotation.js";
export {
  verifyAndInjectIdentity,
  createResurrectionIdentityService,
} from "./monitors/resurrection-identity.js";
export { createResurrectionDetector } from "./monitors/resurrection-detector.js";
export {
  createRecoveryPromptInjector,
  findLatestCheckpoint,
  generateRecoveryPrompt,
} from "./monitors/recovery-prompt-injector.js";
export {
  listIdentities,
  getActiveAid,
  storeIdentity,
  switchIdentity,
  getCheckpointPathForAid,
  validateCheckpointOwnership,
  createMultiIdentityService,
} from "./multi-identity.js";
export {
  selectBestCheckpoint,
  listScoredCheckpoints,
  scoreCheckpoint,
  gatherCheckpoints,
} from "./monitors/checkpoint-selector.js";
export {
  partialRestore,
  patternToRegex,
  matchesAnyPattern,
  createPartialResurrectionService,
} from "./monitors/partial-resurrection.js";
export {
  sha256,
  discoverMemoryFiles,
  hashMemoryFiles,
  createBaseline,
  loadBaseline,
  saveBaseline,
  compareToBaseline,
  createMemoryIntegrityMonitor,
} from "./monitors/memory-integrity.js";
export type * from "./types.js";
