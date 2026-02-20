import { describe, it, expect } from "vitest";
import plugin, {
  resolveConfig,
  DEFAULT_CONFIG,
  PLUGIN_ID,
  PLUGIN_VERSION,
} from "./index.js";
import type { AmcpPluginConfig } from "./types.js";

describe("plugin metadata", () => {
  it("has correct id, name, version", () => {
    expect(plugin.id).toBe("proactive-amcp");
    expect(plugin.name).toBe("Proactive AMCP");
    expect(plugin.version).toBe("1.0.0");
  });

  it("exports PLUGIN_ID and PLUGIN_VERSION", () => {
    expect(PLUGIN_ID).toBe("proactive-amcp");
    expect(PLUGIN_VERSION).toBe("1.0.0");
  });

  it("has a register function", () => {
    expect(typeof plugin.register).toBe("function");
  });
});

describe("resolveConfig", () => {
  it("returns defaults when given empty object", () => {
    const config = resolveConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("overrides top-level values", () => {
    const config = resolveConfig({
      contextThreshold: 80,
      autoCheckpoint: false,
    });
    expect(config.contextThreshold).toBe(80);
    expect(config.autoCheckpoint).toBe(false);
    expect(config.enabled).toBe(true); // default preserved
  });

  it("merges nested memoryIntegrity config", () => {
    const config = resolveConfig({
      memoryIntegrity: { autoRestore: true } as AmcpPluginConfig["memoryIntegrity"],
    });
    expect(config.memoryIntegrity.autoRestore).toBe(true);
    expect(config.memoryIntegrity.enabled).toBe(true); // default preserved
    expect(config.memoryIntegrity.promptInjectionScan).toBe(true);
  });

  it("merges nested identity config", () => {
    const config = resolveConfig({
      identity: { verifyOnStart: false } as AmcpPluginConfig["identity"],
    });
    expect(config.identity.verifyOnStart).toBe(false);
    expect(config.identity.autoInject).toBe(true); // default preserved
  });

  it("merges nested resurrection config", () => {
    const config = resolveConfig({
      resurrection: { autoDetect: false } as AmcpPluginConfig["resurrection"],
    });
    expect(config.resurrection.autoDetect).toBe(false);
    expect(config.resurrection.injectRecoveryPrompt).toBe(true); // default preserved
  });
});

describe("register", () => {
  it("registers services, hooks, and commands", async () => {
    const services: string[] = [];
    const hooks: string[] = [];
    const commands: string[] = [];
    const logs: string[] = [];

    const mockApi = {
      config: { ...DEFAULT_CONFIG },
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      registerService: (svc: { name: string }) => services.push(svc.name),
      registerHook: (event: string) => hooks.push(event),
      registerCommand: (_ns: string, cmd: { name: string }) =>
        commands.push(cmd.name),
      emit: () => {},
    };

    await plugin.register(mockApi);

    // Services
    expect(services).toContain("amcp-context-monitor");
    expect(services).toContain("amcp-memory-integrity");

    // Hooks
    expect(hooks).toContain("gateway_start");
    expect(hooks).toContain("gateway_stop");
    expect(hooks).toContain("session_end");
    expect(hooks).toContain("before_compaction");

    // CLI commands
    expect(commands).toContain("status");
    expect(commands).toContain("checkpoint");
    expect(commands).toContain("resurrect");
    expect(commands).toContain("identity");
    expect(commands).toContain("history");
    expect(commands).toContain("verify");

    // Logged registration
    expect(logs.some((l) => l.includes("registered successfully"))).toBe(true);
  });

  it("skips registration when disabled", async () => {
    const services: string[] = [];
    const logs: string[] = [];

    const mockApi = {
      config: { ...DEFAULT_CONFIG, enabled: false },
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      registerService: (svc: { name: string }) => services.push(svc.name),
      registerHook: () => {},
      registerCommand: () => {},
      emit: () => {},
    };

    await plugin.register(mockApi);

    expect(services).toHaveLength(0);
    expect(logs.some((l) => l.includes("plugin disabled"))).toBe(true);
  });

  it("skips hooks when autoCheckpoint is false", async () => {
    const hooks: string[] = [];

    const mockApi = {
      config: { ...DEFAULT_CONFIG, autoCheckpoint: false },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      registerService: () => {},
      registerHook: (event: string) => hooks.push(event),
      registerCommand: () => {},
      emit: () => {},
    };

    await plugin.register(mockApi);

    // No lifecycle hooks registered
    expect(hooks).toHaveLength(0);
  });
});
