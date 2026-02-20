/**
 * proactive-amcp — OpenClaw Plugin Entry Point
 *
 * Code-level enforcement layer for the Agent Memory Continuity Protocol.
 * Works alongside the bash skill layer (SKILL.md) for two-layer defense:
 *   - Plugin (this): system-level hooks, monitors, CLI commands
 *   - Skill (bash): checkpoint creation, secrets, resurrection logic
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { appendFile, mkdir } from "node:fs/promises";
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
import { createStatusHandler } from "./cli/status-command.js";
import { createCheckpointHandler } from "./cli/checkpoint-command.js";
import { createResurrectHandler } from "./cli/resurrect-command.js";
import { createIdentityHandler } from "./cli/identity-command.js";
import { createHistoryHandler } from "./cli/history-command.js";
import { createVerifyHandler } from "./cli/verify-command.js";
import type {
  AmcpPlugin,
  AmcpPluginConfig,
  CheckpointLogEntry,
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
 * Append a checkpoint trigger entry to the checkpoint log.
 */
async function appendCheckpointLog(
  logPath: string,
  entry: CheckpointLogEntry,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Register lifecycle hooks for checkpoint triggers.
 * Each hook logs the trigger to checkpoint-log.jsonl and emits an event.
 */
function registerHooks(
  api: PluginApi,
  config: AmcpPluginConfig,
  checkpointLogPath: string,
): void {
  if (!config.autoCheckpoint) return;

  api.registerHook("gateway_start", (_event: LifecycleEvent) => {
    api.logger.info("amcp: gateway_start — checkpoint queued");
    const entry: CheckpointLogEntry = {
      timestamp: new Date().toISOString(),
      trigger: "gateway_start",
      contextPercent: 0,
      usedTokens: 0,
      maxTokens: 0,
      cooldownMs: config.checkpointCooldownMs,
    };
    appendCheckpointLog(checkpointLogPath, entry).catch((err) =>
      api.logger.warn(`amcp: failed to log gateway_start trigger: ${err}`),
    );
    api.emit("amcp:checkpoint:requested", { trigger: "gateway_start" });
  });

  api.registerHook("gateway_stop", (_event: LifecycleEvent) => {
    api.logger.info("amcp: gateway_stop — checkpoint queued");
    const entry: CheckpointLogEntry = {
      timestamp: new Date().toISOString(),
      trigger: "gateway_stop",
      contextPercent: 0,
      usedTokens: 0,
      maxTokens: 0,
      cooldownMs: config.checkpointCooldownMs,
    };
    appendCheckpointLog(checkpointLogPath, entry).catch((err) =>
      api.logger.warn(`amcp: failed to log gateway_stop trigger: ${err}`),
    );
    api.emit("amcp:checkpoint:requested", { trigger: "gateway_stop" });
  });

  api.registerHook("session_end", async (event: LifecycleEvent) => {
    // Check if session had meaningful activity before triggering checkpoint.
    // The gateway may provide activity data via event.data (e.g. usedTokens,
    // messageCount, toolCalls). If provided and all are zero, skip checkpoint.
    const data = event.data ?? {};
    const usedTokens = typeof data.usedTokens === "number" ? data.usedTokens : -1;
    const messageCount = typeof data.messageCount === "number" ? data.messageCount : -1;
    const hasActivityMetrics = usedTokens >= 0 || messageCount >= 0;
    const hadActivity = !hasActivityMetrics
      || (usedTokens > 0)
      || (messageCount > 0);

    if (!hadActivity) {
      api.logger.info("amcp: session_end — no meaningful activity, skipping checkpoint");
      return;
    }

    api.logger.info("amcp: session_end — checkpoint queued");
    const entry: CheckpointLogEntry = {
      timestamp: new Date().toISOString(),
      trigger: "session_end",
      contextPercent: typeof data.contextPercent === "number" ? data.contextPercent : 0,
      usedTokens: usedTokens > 0 ? usedTokens : 0,
      maxTokens: typeof data.maxTokens === "number" ? data.maxTokens : 0,
      cooldownMs: config.checkpointCooldownMs,
    };

    // Await the log write to ensure checkpoint is recorded before session terminates.
    try {
      await appendCheckpointLog(checkpointLogPath, entry);
    } catch (err) {
      api.logger.warn(`amcp: failed to log session_end trigger: ${err}`);
    }
    api.emit("amcp:checkpoint:requested", { trigger: "session_end" });
  });

  // context_warning — gateway may fire this if it detects context threshold.
  // The context monitor also polls and emits amcp:context:warning independently.
  api.registerHook("context_warning", (event: LifecycleEvent) => {
    const data = event.data ?? {};
    const contextPercent = typeof data.contextPercent === "number" ? data.contextPercent : 0;
    const severity =
      contextPercent >= 80 ? "critical" : contextPercent >= 60 ? "warning" : null;

    if (severity) {
      api.logger.warn(
        `amcp: context_warning hook — ${severity} at ${contextPercent}%`,
      );
      api.emit("amcp:context:warning", {
        severity,
        contextPercent,
        threshold: severity === "critical" ? 80 : 60,
      });
    } else {
      api.logger.info(
        `amcp: context_warning hook — ${contextPercent}% (below thresholds)`,
      );
    }
  });

  api.registerHook("before_compaction", async (_event: LifecycleEvent) => {
    api.logger.info("amcp: before_compaction — emergency checkpoint queued");
    const entry: CheckpointLogEntry = {
      timestamp: new Date().toISOString(),
      trigger: "before_compaction",
      contextPercent: 0,
      usedTokens: 0,
      maxTokens: 0,
      cooldownMs: config.checkpointCooldownMs,
    };

    // Await the log write to ensure checkpoint is recorded before compaction proceeds.
    try {
      await appendCheckpointLog(checkpointLogPath, entry);
    } catch (err) {
      api.logger.warn(`amcp: failed to log before_compaction trigger: ${err}`);
    }
    api.emit("amcp:checkpoint:requested", {
      trigger: "before_compaction",
      priority: "high",
    });
  });
}

/** Options for registering CLI commands with real implementations. */
interface CliRegistrationDeps {
  config: AmcpPluginConfig;
  services: PluginService[];
  identityPath: string;
  lastCheckpointPath: string;
  checkpointLogPath: string;
  checkpointDir: string;
  scriptDir: string;
}

/**
 * Register CLI commands under the 'amcp' namespace.
 */
function registerCliCommands(api: PluginApi, deps: CliRegistrationDeps): void {
  // 'amcp status' — fully implemented (P4-CLI-01)
  const statusHandler = createStatusHandler({
    logger: api.logger,
    config: deps.config,
    identityPath: deps.identityPath,
    lastCheckpointPath: deps.lastCheckpointPath,
    services: deps.services,
  });

  api.registerCommand("amcp", {
    name: "status",
    description: "Show AMCP status, last checkpoint, identity",
    handler: statusHandler,
  });

  // 'amcp checkpoint' — fully implemented (P4-CLI-02)
  const checkpointHandler = createCheckpointHandler({
    logger: api.logger,
    config: deps.config,
    lastCheckpointPath: deps.lastCheckpointPath,
    scriptDir: deps.scriptDir,
  });

  api.registerCommand("amcp", {
    name: "checkpoint",
    description: "Create a manual checkpoint",
    handler: checkpointHandler,
  });

  // 'amcp resurrect' — fully implemented (P4-CLI-03)
  const resurrectHandler = createResurrectHandler({
    logger: api.logger,
    config: deps.config,
    lastCheckpointPath: deps.lastCheckpointPath,
    scriptDir: deps.scriptDir,
  });

  api.registerCommand("amcp", {
    name: "resurrect",
    description: "Restore from a checkpoint",
    handler: resurrectHandler,
  });

  // 'amcp identity' — fully implemented (P4-CLI-04)
  const identityHandler = createIdentityHandler({
    logger: api.logger,
    config: deps.config,
    identityPath: deps.identityPath,
    scriptDir: deps.scriptDir,
  });

  api.registerCommand("amcp", {
    name: "identity",
    description: "Identity management (show, rotate, verify, export)",
    handler: identityHandler,
  });

  // 'amcp history' — fully implemented (P4-CLI-05)
  const historyHandler = createHistoryHandler({
    logger: api.logger,
    config: deps.config,
    checkpointLogPath: deps.checkpointLogPath,
    lastCheckpointPath: deps.lastCheckpointPath,
  });

  api.registerCommand("amcp", {
    name: "history",
    description: "Show checkpoint history",
    handler: historyHandler,
  });

  // 'amcp verify' — fully implemented (P4-CLI-06)
  const verifyHandler = createVerifyHandler({
    logger: api.logger,
    config: deps.config,
    lastCheckpointPath: deps.lastCheckpointPath,
    checkpointDir: deps.checkpointDir,
    scriptDir: deps.scriptDir,
  });

  api.registerCommand("amcp", {
    name: "verify",
    description: "Verify checkpoint integrity",
    handler: verifyHandler,
  });
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

  // Polyfill: OpenClaw may not provide emit() in all versions
  if (!api.emit) {
    api.emit = () => {
      // No-op fallback
    };
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

  const allServices: PluginService[] = [
    contextMonitor,
    valueMonitor,
    memoryMonitor,
    identityService,
    keyRotationService,
    resurrectionIdentityService,
    resurrectionDetector,
    multiIdentityService,
    recoveryPromptInjector,
    partialResurrectionService,
  ];

  // Adapt services to OpenClaw's expected interface (id instead of name, context params)
  for (const svc of allServices) {
    const adapted = {
      id: svc.name,
      start: async () => {
        await svc.start();
      },
      stop: async () => {
        await svc.stop();
      },
    };
    api.registerService(adapted as any);
  }

  // Register lifecycle hooks
  registerHooks(api, config, checkpointLogPath);

  // Script directory — resolve from plugin install path or apiExt override
  const scriptDir =
    (apiExt.amcpScriptDir as string) ??
    join(dirname(new URL(import.meta.url).pathname), "..", "scripts");

  // Checkpoint directory — local checkpoint file storage
  const checkpointDir =
    (apiExt.amcpCheckpointDir as string) ??
    join(homedir(), ".amcp", "checkpoints");

  // TEMP: CLI commands disabled - need to adapt to OpenClaw's registerCli API
  // registerCliCommands(api, {
  //   config,
  //   services: allServices,
  //   identityPath,
  //   lastCheckpointPath,
  //   checkpointLogPath,
  //   checkpointDir,
  //   scriptDir,
  // });

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
  buildChangeSummary,
  appendChangeLog,
  createMemoryIntegrityMonitor,
} from "./monitors/memory-integrity.js";
export {
  INJECTION_PATTERNS,
  scanContent,
  scanMemoryFiles as scanForInjections,
  buildInjectionSummary,
  appendInjectionLog,
  processInjectionResults,
} from "./monitors/prompt-injection-scanner.js";
export {
  autoRestore,
  saveSnapshot,
  saveAllSnapshots,
  hasSnapshot,
  removeSnapshot,
} from "./monitors/memory-auto-restore.js";
export {
  gatherStatus,
  formatStatus,
  createStatusHandler,
} from "./cli/status-command.js";
export {
  runCheckpoint,
  formatCheckpointResult,
  createCheckpointHandler,
} from "./cli/checkpoint-command.js";
export {
  runResurrect,
  formatResurrectResult,
  buildRecoveryPrompt,
  createResurrectHandler,
} from "./cli/resurrect-command.js";
export {
  gatherIdentityInfo,
  formatIdentityShow,
  verifyIdentity,
  formatVerifyResult,
  executeRotation,
  formatRotateResult,
  exportIdentity,
  formatExportResult,
  createIdentityHandler,
} from "./cli/identity-command.js";
export {
  runHistory,
  formatHistoryResult,
  createHistoryHandler,
} from "./cli/history-command.js";
export {
  runVerify,
  formatVerifyResult as formatVerifyCheckpointResult,
  createVerifyHandler,
} from "./cli/verify-command.js";
export type * from "./types.js";
