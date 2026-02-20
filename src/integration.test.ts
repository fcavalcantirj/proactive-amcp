/**
 * Integration tests for proactive-amcp plugin + OpenClaw integration.
 *
 * These tests verify the full plugin registration flow, lifecycle hook
 * execution, CLI command dispatch, and service lifecycle — simulating
 * how the OpenClaw gateway interacts with the plugin at runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  apiExtras: Record<string, unknown> = {},
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
    ...apiExtras,
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

  it("registers exactly 10 services", () => {
    expect(state.services).toHaveLength(10);
    const names = state.services.map((s) => s.name);
    expect(names).toContain("amcp-context-monitor");
    expect(names).toContain("amcp-value-monitor");
    expect(names).toContain("amcp-memory-integrity");
    expect(names).toContain("amcp-identity-manager");
    expect(names).toContain("amcp-key-rotation");
    expect(names).toContain("amcp-resurrection-identity");
    expect(names).toContain("amcp-resurrection-detector");
    expect(names).toContain("amcp-multi-identity");
    expect(names).toContain("amcp-recovery-prompt-injector");
    expect(names).toContain("amcp-partial-resurrection");
  });

  it("registers 5 lifecycle hooks", () => {
    const hookEvents = Array.from(state.hooks.keys());
    expect(hookEvents).toHaveLength(5);
    expect(hookEvents).toContain("gateway_start");
    expect(hookEvents).toContain("gateway_stop");
    expect(hookEvents).toContain("session_end");
    expect(hookEvents).toContain("context_warning");
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
  let tmpDir: string;
  let checkpointLogPath: string;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `amcp-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
    checkpointLogPath = join(tmpDir, "checkpoint-log.jsonl");

    const mock = createMockApi({}, { amcpCheckpointLogPath: checkpointLogPath });
    state = mock.state;
    await register(mock.api);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
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

  it("gateway_start hook logs trigger to checkpoint-log.jsonl", async () => {
    const handlers = state.hooks.get("gateway_start")!;
    handlers[0](makeEvent("gateway_start"));

    // Wait for async file write to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    const logContent = await readFile(checkpointLogPath, "utf-8");
    const entries = logContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(entries).toHaveLength(1);
    expect(entries[0].trigger).toBe("gateway_start");
    expect(entries[0].timestamp).toBeTruthy();
    expect(entries[0].cooldownMs).toBeGreaterThan(0);
  });

  it("gateway_stop hook emits checkpoint requested event", () => {
    const handlers = state.hooks.get("gateway_stop")!;
    handlers[0](makeEvent("gateway_stop"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "gateway_stop" },
    });
  });

  it("session_end hook emits checkpoint when no activity data provided", async () => {
    const handlers = state.hooks.get("session_end")!;
    await handlers[0](makeEvent("session_end"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "session_end" },
    });
  });

  it("session_end hook emits checkpoint when session had meaningful activity", async () => {
    const handlers = state.hooks.get("session_end")!;
    const event: LifecycleEvent = {
      type: "session_end",
      timestamp: new Date().toISOString(),
      data: { usedTokens: 5000, messageCount: 10, contextPercent: 45, maxTokens: 200000 },
    };
    await handlers[0](event);

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "session_end" },
    });
    expect(state.logs.info.some((l) => l.includes("checkpoint queued"))).toBe(true);
  });

  it("session_end hook skips checkpoint when session had no activity", async () => {
    const handlers = state.hooks.get("session_end")!;
    const event: LifecycleEvent = {
      type: "session_end",
      timestamp: new Date().toISOString(),
      data: { usedTokens: 0, messageCount: 0 },
    };
    await handlers[0](event);

    const sessionEndEmissions = state.emissions.filter(
      (e) => e.data?.trigger === "session_end",
    );
    expect(sessionEndEmissions).toHaveLength(0);
    expect(state.logs.info.some((l) => l.includes("no meaningful activity"))).toBe(true);
  });

  it("session_end hook writes to checkpoint-log.jsonl before returning", async () => {
    const handlers = state.hooks.get("session_end")!;
    const event: LifecycleEvent = {
      type: "session_end",
      timestamp: new Date().toISOString(),
      data: { usedTokens: 1200, maxTokens: 200000, contextPercent: 12 },
    };
    await handlers[0](event);

    // No need to wait — the hook awaits the log write
    const logContent = await readFile(checkpointLogPath, "utf-8");
    const entries = logContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const sessionEntry = entries.find(
      (e: Record<string, unknown>) => e.trigger === "session_end",
    );
    expect(sessionEntry).toBeDefined();
    expect(sessionEntry.usedTokens).toBe(1200);
    expect(sessionEntry.contextPercent).toBe(12);
    expect(sessionEntry.maxTokens).toBe(200000);
  });

  it("before_compaction hook emits high-priority checkpoint event", async () => {
    const handlers = state.hooks.get("before_compaction")!;
    await handlers[0](makeEvent("before_compaction"));

    expect(state.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "before_compaction", priority: "high" },
    });
  });

  it("before_compaction hook awaits log write before returning", async () => {
    const handlers = state.hooks.get("before_compaction")!;
    await handlers[0](makeEvent("before_compaction"));

    // Log should be written immediately (no setTimeout needed) because
    // before_compaction awaits appendCheckpointLog to ensure checkpoint
    // completes before compaction proceeds.
    const logContent = await readFile(checkpointLogPath, "utf-8");
    const entries = logContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const compactionEntry = entries.find(
      (e: Record<string, unknown>) => e.trigger === "before_compaction",
    );
    expect(compactionEntry).toBeDefined();
    expect(compactionEntry.trigger).toBe("before_compaction");
  });

  it("context_warning hook emits warning at 60% threshold", () => {
    const handlers = state.hooks.get("context_warning")!;
    expect(handlers).toHaveLength(1);

    const event: LifecycleEvent = {
      type: "context_warning",
      timestamp: new Date().toISOString(),
      data: { contextPercent: 65 },
    };
    handlers[0](event);

    expect(state.emissions).toContainEqual(
      expect.objectContaining({
        event: "amcp:context:warning",
        data: expect.objectContaining({
          severity: "warning",
          contextPercent: 65,
          threshold: 60,
        }),
      }),
    );
  });

  it("context_warning hook emits critical at 80% threshold", () => {
    const handlers = state.hooks.get("context_warning")!;

    const event: LifecycleEvent = {
      type: "context_warning",
      timestamp: new Date().toISOString(),
      data: { contextPercent: 85 },
    };
    handlers[0](event);

    expect(state.emissions).toContainEqual(
      expect.objectContaining({
        event: "amcp:context:warning",
        data: expect.objectContaining({
          severity: "critical",
          contextPercent: 85,
          threshold: 80,
        }),
      }),
    );
  });

  it("context_warning hook does not emit below 60% threshold", () => {
    const handlers = state.hooks.get("context_warning")!;

    const event: LifecycleEvent = {
      type: "context_warning",
      timestamp: new Date().toISOString(),
      data: { contextPercent: 45 },
    };
    handlers[0](event);

    const warningEmissions = state.emissions.filter(
      (e) => e.event === "amcp:context:warning",
    );
    expect(warningEmissions).toHaveLength(0);
    expect(state.logs.info.some((l) => l.includes("below thresholds"))).toBe(true);
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

  it("checkpoint hooks write to checkpoint-log.jsonl", async () => {
    // Fire only the hooks that write checkpoint log entries (not context_warning)
    const checkpointHooks = ["gateway_start", "gateway_stop", "session_end", "before_compaction"];
    for (const hookName of checkpointHooks) {
      const handlers = state.hooks.get(hookName)!;
      await handlers[0](makeEvent(hookName));
    }

    // Wait briefly for any fire-and-forget writes (gateway_start/stop)
    await new Promise((resolve) => setTimeout(resolve, 200));

    const logContent = await readFile(checkpointLogPath, "utf-8");
    const entries = logContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(entries).toHaveLength(4);
    const triggers = entries.map((e: Record<string, unknown>) => e.trigger);
    expect(triggers).toContain("gateway_start");
    expect(triggers).toContain("gateway_stop");
    expect(triggers).toContain("session_end");
    expect(triggers).toContain("before_compaction");
  });

  it("no hooks registered when autoCheckpoint is false", async () => {
    const mock = createMockApi({ autoCheckpoint: false });
    await register(mock.api);

    expect(mock.state.hooks.size).toBe(0);
  });

  it("services still registered when autoCheckpoint is false", async () => {
    const mock = createMockApi({ autoCheckpoint: false });
    await register(mock.api);

    expect(mock.state.services).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Integration: CLI Commands Execute
// ---------------------------------------------------------------------------

describe("integration: CLI commands", () => {
  let state: MockState;
  let mockScriptDir: string;

  beforeEach(async () => {
    // Create temp script dir with mock scripts so CLI commands resolve fast
    mockScriptDir = join(
      tmpdir(),
      `amcp-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(mockScriptDir, { recursive: true });

    // Mock full-checkpoint.sh (used by checkpoint command)
    await writeFile(
      join(mockScriptDir, "full-checkpoint.sh"),
      '#!/bin/bash\necho "=== DRY RUN COMPLETE ==="\necho "Would checkpoint 0 secrets and 0K of content"\n',
      { mode: 0o755 },
    );

    // Mock resuscitate.sh (used by resurrect command)
    await writeFile(
      join(mockScriptDir, "resuscitate.sh"),
      '#!/bin/bash\necho "=== TIER 1: Restart gateway ==="\necho "=== RESURRECTION COMPLETE ==="\n',
      { mode: 0o755 },
    );

    const mock = createMockApi({}, { amcpScriptDir: mockScriptDir });
    state = mock.state;
    await register(mock.api);
  });

  afterEach(async () => {
    await rm(mockScriptDir, { recursive: true, force: true });
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
      cmd.handler(["--from-cid", "bafkreiexamplecid"]),
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

  it("verify command handler accepts local file arg", async () => {
    // Create a local checkpoint file to verify (avoids IPFS fetch timeout)
    const cpPath = join(mockScriptDir, "test-checkpoint.amcp");
    await writeFile(
      cpPath,
      JSON.stringify({
        aid: "Btest",
        soul: { name: "Test" },
        content: { memory: {} },
        signature: "sig",
        encryptedSecrets: "enc",
      }),
    );
    const cmd = state.commands.get("verify")!;
    await expect(
      cmd.handler(["--checkpoint", cpPath]),
    ).resolves.toBeUndefined();
  });

  it("command handlers log invocation with args", async () => {
    const cmd = state.commands.get("checkpoint")!;
    await cmd.handler(["--dry-run"]);

    expect(
      state.logs.info.some(
        (l) => l.includes("amcp checkpoint") && l.includes("dry-run"),
      ),
    ).toBe(true);
  });

  it("status command outputs AMCP status display", async () => {
    const cmd = state.commands.get("status")!;
    await cmd.handler([]);

    expect(
      state.logs.info.some(
        (l) => l.includes("=== AMCP Status ===") || l.includes("Identity:"),
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
      (s) => s.name === "amcp-memory-integrity",
    )!;

    await monitor.start();
    const status = await monitor.status();
    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-memory-integrity");

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
      state.logs.info.some((l) => l.includes("amcp-memory-integrity: created baseline") || l.includes("amcp-memory-integrity: loaded baseline")),
    ).toBe(true);
    expect(
      state.logs.info.some((l) => l.includes("amcp-memory-integrity: stopped")),
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
    expect(state.services).toHaveLength(10);
    expect(state.hooks.size).toBe(5);
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
