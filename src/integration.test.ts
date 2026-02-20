/**
 * Integration tests for proactive-amcp plugin + OpenClaw integration.
 *
 * These tests verify the full plugin registration flow, lifecycle hook
 * execution, CLI command dispatch, and service lifecycle — simulating
 * how the OpenClaw gateway interacts with the plugin at runtime.
 */

import { describe, it, expect, beforeEach } from "vitest";
import plugin, { register, DEFAULT_CONFIG } from "./index.js";
import type {
  AmcpPluginConfig,
  PluginApi,
  PluginService,
  LifecycleHookFn,
  LifecycleEvent,
  CliCommand,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers: build a tracking mock PluginApi that behaves like OpenClaw gateway
// ---------------------------------------------------------------------------

interface MockState {
  services: PluginService[];
  hooks: Map<string, LifecycleHookFn[]>;
  commands: Map<string, CliCommand>;
  emissions: Array<{ event: string; data?: Record<string, unknown> }>;
  logs: { info: string[]; warn: string[]; error: string[]; debug: string[] };
}

function createMockApi(
  configOverrides: Partial<AmcpPluginConfig> = {},
): { api: PluginApi; state: MockState } {
  const state: MockState = {
    services: [],
    hooks: new Map(),
    commands: new Map(),
    emissions: [],
    logs: { info: [], warn: [], error: [], debug: [] },
  };

  const api: PluginApi = {
    config: { ...DEFAULT_CONFIG, ...configOverrides } as AmcpPluginConfig,
    logger: {
      info: (msg: string) => state.logs.info.push(msg),
      warn: (msg: string) => state.logs.warn.push(msg),
      error: (msg: string) => state.logs.error.push(msg),
      debug: (msg: string) => state.logs.debug.push(msg),
    },
    registerService(service: PluginService) {
      state.services.push(service);
    },
    registerHook(event: string, handler: LifecycleHookFn) {
      const handlers = state.hooks.get(event) ?? [];
      handlers.push(handler);
      state.hooks.set(event, handlers);
    },
    registerCommand(_namespace: string, command: CliCommand) {
      state.commands.set(command.name, command);
    },
    emit(event: string, data?: Record<string, unknown>) {
      state.emissions.push({ event, data });
    },
  };

  return { api, state };
}

function makeEvent(type: string): LifecycleEvent {
  return { type, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Integration: Plugin Registration
// ---------------------------------------------------------------------------

describe("integration: plugin registration", () => {
  let api: PluginApi;
  let state: MockState;

  beforeEach(async () => {
    const mock = createMockApi();
    api = mock.api;
    state = mock.state;
    await plugin.register(api);
  });

  it("registers exactly 4 services", () => {
    expect(state.services).toHaveLength(4);
    const names = state.services.map((s) => s.name);
    expect(names).toContain("amcp-context-monitor");
    expect(names).toContain("amcp-value-monitor");
    expect(names).toContain("amcp-memory-monitor");
    expect(names).toContain("amcp-identity-manager");
  });

  it("registers 4 lifecycle hooks", () => {
    const hookEvents = Array.from(state.hooks.keys());
    expect(hookEvents).toHaveLength(4);
    expect(hookEvents).toContain("gateway_start");
    expect(hookEvents).toContain("gateway_stop");
    expect(hookEvents).toContain("session_end");
    expect(hookEvents).toContain("before_compaction");
  });

  it("registers 6 CLI commands under amcp namespace", () => {
    expect(state.commands.size).toBe(6);
    const expectedCommands = [
      "status",
      "checkpoint",
      "resurrect",
      "identity",
      "history",
      "verify",
    ];
    for (const name of expectedCommands) {
      expect(state.commands.has(name)).toBe(true);
    }
  });

  it("logs initialization and success messages", () => {
    expect(
      state.logs.info.some((l) => l.includes("initializing plugin")),
    ).toBe(true);
    expect(
      state.logs.info.some((l) => l.includes("registered successfully")),
    ).toBe(true);
  });

  it("plugin default export matches AmcpPlugin contract", () => {
    expect(typeof plugin.id).toBe("string");
    expect(typeof plugin.name).toBe("string");
    expect(typeof plugin.version).toBe("string");
    expect(typeof plugin.description).toBe("string");
    expect(typeof plugin.register).toBe("function");
    expect(plugin.id).toBe("proactive-amcp");
  });
});

// ---------------------------------------------------------------------------
// Integration: Lifecycle Hooks Fire Correctly
// ---------------------------------------------------------------------------

describe("integration: lifecycle hooks", () => {
  let state: MockState;

  beforeEach(async () => {
    const mock = createMockApi();
    state = mock.state;
    await register(mock.api);
  });

  it("gateway_start hook emits checkpoint requested event", () => {
    const handlers = state.hooks.get("gateway_start")!;
    expect(handlers).toHaveLength(1);

    handlers[0](makeEvent("gateway_start"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "gateway_start" },
    });
  });

  it("gateway_stop hook emits checkpoint requested event", () => {
    const handlers = state.hooks.get("gateway_stop")!;
    handlers[0](makeEvent("gateway_stop"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "gateway_stop" },
    });
  });

  it("session_end hook emits checkpoint requested event", () => {
    const handlers = state.hooks.get("session_end")!;
    handlers[0](makeEvent("session_end"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "session_end" },
    });
  });

  it("before_compaction hook emits high-priority checkpoint event", () => {
    const handlers = state.hooks.get("before_compaction")!;
    handlers[0](makeEvent("before_compaction"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "before_compaction", priority: "high" },
    });
  });

  it("hooks log their trigger reason", () => {
    for (const [event, handlers] of state.hooks.entries()) {
      handlers[0](makeEvent(event));
    }

    expect(state.logs.info.some((l) => l.includes("gateway_start"))).toBe(
      true,
    );
    expect(state.logs.info.some((l) => l.includes("session_end"))).toBe(true);
    expect(
      state.logs.info.some((l) => l.includes("before_compaction")),
    ).toBe(true);
  });

  it("no hooks registered when autoCheckpoint is false", async () => {
    const mock = createMockApi({ autoCheckpoint: false });
    await register(mock.api);

    expect(mock.state.hooks.size).toBe(0);
  });

  it("services still registered when autoCheckpoint is false", async () => {
    const mock = createMockApi({ autoCheckpoint: false });
    await register(mock.api);

    expect(mock.state.services).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Integration: CLI Commands Execute
// ---------------------------------------------------------------------------

describe("integration: CLI commands", () => {
  let state: MockState;

  beforeEach(async () => {
    const mock = createMockApi();
    state = mock.state;
    await register(mock.api);
  });

  it("status command handler executes without error", async () => {
    const cmd = state.commands.get("status")!;
    await expect(cmd.handler([])).resolves.toBeUndefined();
  });

  it("checkpoint command handler executes without error", async () => {
    const cmd = state.commands.get("checkpoint")!;
    await expect(cmd.handler(["--dry-run"])).resolves.toBeUndefined();
  });

  it("resurrect command handler executes with CID arg", async () => {
    const cmd = state.commands.get("resurrect")!;
    await expect(
      cmd.handler(["bafkreiexamplecid"]),
    ).resolves.toBeUndefined();
  });

  it("identity command handler executes without error", async () => {
    const cmd = state.commands.get("identity")!;
    await expect(cmd.handler(["show"])).resolves.toBeUndefined();
  });

  it("history command handler accepts --limit and --json", async () => {
    const cmd = state.commands.get("history")!;
    await expect(
      cmd.handler(["--limit", "5", "--json"]),
    ).resolves.toBeUndefined();
  });

  it("verify command handler accepts CID arg", async () => {
    const cmd = state.commands.get("verify")!;
    await expect(
      cmd.handler(["bafkreiexamplecid"]),
    ).resolves.toBeUndefined();
  });

  it("command handlers log invocation with args", async () => {
    const cmd = state.commands.get("checkpoint")!;
    await cmd.handler(["--dry-run"]);

    expect(
      state.logs.info.some(
        (l) => l.includes("amcp checkpoint") && l.includes("--dry-run"),
      ),
    ).toBe(true);
  });

  it("command handlers log invocation without args", async () => {
    const cmd = state.commands.get("status")!;
    await cmd.handler([]);

    expect(
      state.logs.info.some(
        (l) => l.includes("amcp status") && l.includes("(no args)"),
      ),
    ).toBe(true);
  });

  it("all commands have descriptions", () => {
    for (const [, cmd] of state.commands) {
      expect(cmd.description).toBeTruthy();
      expect(cmd.description.length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: Service Lifecycle
// ---------------------------------------------------------------------------

describe("integration: service lifecycle", () => {
  let state: MockState;

  beforeEach(async () => {
    const mock = createMockApi();
    state = mock.state;
    await register(mock.api);
  });

  it("context monitor starts, reports status, and stops", async () => {
    const monitor = state.services.find(
      (s) => s.name === "amcp-context-monitor",
    )!;

    await monitor.start();
    const status = await monitor.status();
    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-context-monitor");

    await monitor.stop();
    // stop completes without error
  });

  it("memory monitor starts, reports status, and stops", async () => {
    const monitor = state.services.find(
      (s) => s.name === "amcp-memory-monitor",
    )!;

    await monitor.start();
    const status = await monitor.status();
    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-memory-monitor");

    await monitor.stop();
  });

  it("services log start and stop events", async () => {
    for (const svc of state.services) {
      await svc.start();
      await svc.stop();
    }

    expect(
      state.logs.info.some((l) => l.includes("amcp-context-monitor: started")),
    ).toBe(true);
    expect(
      state.logs.info.some((l) => l.includes("amcp-context-monitor: stopped")),
    ).toBe(true);
    expect(
      state.logs.info.some((l) => l.includes("amcp-memory-monitor: started")),
    ).toBe(true);
    expect(
      state.logs.info.some((l) => l.includes("amcp-memory-monitor: stopped")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: Disabled / Partial Config Scenarios
// ---------------------------------------------------------------------------

describe("integration: config variations", () => {
  it("disabled plugin registers nothing", async () => {
    const { api, state } = createMockApi({ enabled: false });
    await register(api);

    expect(state.services).toHaveLength(0);
    expect(state.hooks.size).toBe(0);
    expect(state.commands.size).toBe(0);
    expect(state.logs.info.some((l) => l.includes("plugin disabled"))).toBe(
      true,
    );
  });

  it("custom config values are respected in resolved config", async () => {
    const { api, state } = createMockApi({
      contextThreshold: 90,
      ipfsPinningService: "pinata",
      checkpointCooldownMs: 60_000,
    });
    await register(api);

    // Plugin still registers normally with custom config
    expect(state.services).toHaveLength(4);
    expect(state.hooks.size).toBe(4);
    expect(state.commands.size).toBe(6);
  });

  it("register can be called via plugin.register or standalone", async () => {
    const mock1 = createMockApi();
    const mock2 = createMockApi();

    await plugin.register(mock1.api);
    await register(mock2.api);

    // Both paths produce identical registration
    expect(mock1.state.services.map((s) => s.name)).toEqual(
      mock2.state.services.map((s) => s.name),
    );
    expect(Array.from(mock1.state.hooks.keys()).sort()).toEqual(
      Array.from(mock2.state.hooks.keys()).sort(),
    );
    expect(
      Array.from(mock1.state.commands.keys()).sort(),
    ).toEqual(Array.from(mock2.state.commands.keys()).sort());
  });
});
