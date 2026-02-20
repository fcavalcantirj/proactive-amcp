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
import type {
  AmcpPlugin,
  AmcpPluginConfig,
  PluginApi,
  PluginService,
  LifecycleEvent,
  SessionApi,
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

/**
 * Placeholder memory monitor service.
 * Watches memory files for unauthorized changes and prompt injection.
 */
function createMemoryMonitor(
  _config: AmcpPluginConfig,
  logger: { info: (msg: string) => void },
): PluginService {
  return {
    name: "amcp-memory-monitor",
    async start() {
      logger.info("amcp-memory-monitor: started");
    },
    async stop() {
      logger.info("amcp-memory-monitor: stopped");
    },
    async status() {
      return { running: true, details: { service: "amcp-memory-monitor" } };
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
  const memoryMonitor = createMemoryMonitor(config, api.logger);
  api.registerService(contextMonitor);
  api.registerService(memoryMonitor);

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
export type * from "./types.js";
