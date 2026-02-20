/**
 * proactive-amcp plugin types
 *
 * Type definitions for the OpenClaw plugin layer of AMCP.
 * These types mirror the configSchema in openclaw.plugin.json.
 */

// --- Plugin Config ---

export interface MemoryIntegrityConfig {
  enabled: boolean;
  promptInjectionScan: boolean;
  autoRestore: boolean;
}

export interface IdentityConfig {
  autoInject: boolean;
  verifyOnStart: boolean;
}

export interface ResurrectionConfig {
  autoDetect: boolean;
  injectRecoveryPrompt: boolean;
}

export type IpfsPinningService = "pinata" | "solvr" | "local";

export interface AmcpPluginConfig {
  enabled: boolean;
  autoCheckpoint: boolean;
  checkpointIntervalMs: number;
  contextThreshold: number;
  ipfsPinningService: IpfsPinningService;
  encryptionKeyPath: string;
  checkpointCooldownMs: number;
  memoryIntegrity: MemoryIntegrityConfig;
  identity: IdentityConfig;
  resurrection: ResurrectionConfig;
}

// --- OpenClaw Plugin API (provided by gateway) ---

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface PluginService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean; details?: Record<string, unknown> }>;
}

export type LifecycleHookFn = (
  event: LifecycleEvent,
) => void | Promise<void>;

export interface LifecycleEvent {
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface CliCommand {
  name: string;
  description: string;
  handler(args: string[]): Promise<void>;
}

export interface PluginApi {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  registerService(service: PluginService): void;
  registerHook(event: string, handler: LifecycleHookFn): void;
  registerCommand(namespace: string, command: CliCommand): void;
  emit(event: string, data?: Record<string, unknown>): void;
}

// --- Plugin Interface ---

export interface AmcpPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  register(api: PluginApi): Promise<void>;
}

// --- Checkpoint Metadata ---

export interface CheckpointMeta {
  cid: string;
  timestamp: string;
  triggerReason: string;
  size?: number;
  pinningService?: IpfsPinningService;
}

// --- Identity ---

export interface AmcpIdentity {
  aid: string;
  publicKey: string;
  created: string;
  kel?: unknown[];
}

// --- Context Monitor ---

export interface ContextReading {
  timestamp: string;
  usedTokens: number;
  maxTokens: number;
  contextPercent: number;
}

export interface SessionApi {
  getContextUsage(): Promise<{ usedTokens: number; maxTokens: number }>;
}

export interface CheckpointLogEntry {
  timestamp: string;
  trigger: string;
  contextPercent: number;
  usedTokens: number;
  maxTokens: number;
  cooldownMs: number;
}

/**
 * Returns a hash representing the current workspace content.
 * Used by time-based triggers to skip checkpoints when nothing changed.
 */
export interface ContentHasher {
  getContentHash(): Promise<string>;
}

export interface ContextMonitorDeps {
  config: AmcpPluginConfig;
  logger: PluginLogger;
  emit: (event: string, data?: Record<string, unknown>) => void;
  sessionApi: SessionApi;
  historyPath: string;
  checkpointLogPath: string;
  contentHasher?: ContentHasher;
}
