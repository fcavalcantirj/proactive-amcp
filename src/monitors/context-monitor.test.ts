/**
 * Tests for context-monitor — verifies context % tracking, JSONL storage,
 * threshold-triggered checkpoint events, and service lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContextMonitor } from "./context-monitor.js";
import type {
  AmcpPluginConfig,
  ContextMonitorDeps,
  ContextReading,
  PluginLogger,
  SessionApi,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AmcpPluginConfig> = {}): AmcpPluginConfig {
  return {
    enabled: true,
    autoCheckpoint: true,
    checkpointIntervalMs: 0,
    contextThreshold: 70,
    ipfsPinningService: "solvr",
    encryptionKeyPath: "~/.amcp/identity.json",
    checkpointCooldownMs: 300_000,
    memoryIntegrity: { enabled: true, promptInjectionScan: true, autoRestore: false },
    identity: { autoInject: true, verifyOnStart: true },
    resurrection: { autoDetect: true, injectRecoveryPrompt: true },
    ...overrides,
  };
}

function makeLogger(): PluginLogger & { messages: Record<string, string[]> } {
  const messages: Record<string, string[]> = {
    info: [],
    warn: [],
    error: [],
    debug: [],
  };
  return {
    messages,
    info: (msg: string) => messages.info.push(msg),
    warn: (msg: string) => messages.warn.push(msg),
    error: (msg: string) => messages.error.push(msg),
    debug: (msg: string) => messages.debug.push(msg),
  };
}

function makeSessionApi(usedTokens: number, maxTokens: number): SessionApi {
  return {
    async getContextUsage() {
      return { usedTokens, maxTokens };
    },
  };
}

function makeDeps(
  overrides: Partial<ContextMonitorDeps> & { tmpDir: string },
): ContextMonitorDeps & {
  logger: ReturnType<typeof makeLogger>;
  emissions: Array<{ event: string; data?: Record<string, unknown> }>;
} {
  const logger = makeLogger();
  const emissions: Array<{ event: string; data?: Record<string, unknown> }> = [];
  return {
    config: makeConfig(overrides.config ? overrides.config as Partial<AmcpPluginConfig> : {}),
    logger,
    emit: (event: string, data?: Record<string, unknown>) => emissions.push({ event, data }),
    sessionApi: overrides.sessionApi ?? makeSessionApi(0, 0),
    historyPath: join(overrides.tmpDir, "context-history.jsonl"),
    emissions,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context-monitor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-ctx-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exports start(), stop(), status() functions", () => {
    const deps = makeDeps({ tmpDir, sessionApi: makeSessionApi(0, 100_000) });
    const monitor = createContextMonitor(deps);

    expect(typeof monitor.start).toBe("function");
    expect(typeof monitor.stop).toBe("function");
    expect(typeof monitor.status).toBe("function");
    expect(monitor.name).toBe("amcp-context-monitor");
  });

  it("logs context % on start (initial poll)", async () => {
    const deps = makeDeps({ tmpDir, sessionApi: makeSessionApi(50_000, 100_000) });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    expect(deps.logger.messages.info.some((m) => m.includes("50%"))).toBe(true);
    expect(
      deps.logger.messages.info.some((m) => m.includes("50000/100000")),
    ).toBe(true);
  });

  it("stores readings in context-history.jsonl", async () => {
    const deps = makeDeps({ tmpDir, sessionApi: makeSessionApi(30_000, 100_000) });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const content = await readFile(deps.historyPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const reading: ContextReading = JSON.parse(lines[0]);
    expect(reading.usedTokens).toBe(30_000);
    expect(reading.maxTokens).toBe(100_000);
    expect(reading.contextPercent).toBe(30);
    expect(reading.timestamp).toBeTruthy();
  });

  it("computes context % as (usedTokens / maxTokens) * 100", async () => {
    const deps = makeDeps({ tmpDir, sessionApi: makeSessionApi(75_000, 200_000) });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const content = await readFile(deps.historyPath, "utf-8");
    const reading: ContextReading = JSON.parse(content.trim());
    expect(reading.contextPercent).toBe(37.5);
  });

  it("handles zero maxTokens gracefully (0%)", async () => {
    const deps = makeDeps({ tmpDir, sessionApi: makeSessionApi(0, 0) });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const content = await readFile(deps.historyPath, "utf-8");
    const reading: ContextReading = JSON.parse(content.trim());
    expect(reading.contextPercent).toBe(0);
  });

  it("emits checkpoint event when threshold exceeded", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(80_000, 100_000),
      config: makeConfig({ contextThreshold: 70 }),
    });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    expect(deps.emissions).toContainEqual({
      event: "amcp:checkpoint:requested",
      data: { trigger: "context_threshold", contextPercent: 80 },
    });
    expect(
      deps.logger.messages.warn.some((m) => m.includes("threshold") && m.includes("80%")),
    ).toBe(true);
  });

  it("does NOT emit checkpoint event when below threshold", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(50_000, 100_000),
      config: makeConfig({ contextThreshold: 70 }),
    });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    expect(deps.emissions).toHaveLength(0);
  });

  it("polls every 30 seconds after start", async () => {
    let callCount = 0;
    const sessionApi: SessionApi = {
      async getContextUsage() {
        callCount++;
        return { usedTokens: callCount * 10_000, maxTokens: 100_000 };
      },
    };
    const deps = makeDeps({ tmpDir, sessionApi });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    expect(callCount).toBe(1); // initial poll

    // Advance 30 seconds — should trigger another poll
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(2);

    // Advance another 30 seconds
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(3);

    await monitor.stop();

    // After stop, no more polls
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(3);
  });

  it("status() reflects running state and last reading", async () => {
    const deps = makeDeps({ tmpDir, sessionApi: makeSessionApi(40_000, 100_000) });
    const monitor = createContextMonitor(deps);

    const beforeStatus = await monitor.status();
    expect(beforeStatus.running).toBe(false);

    await monitor.start();
    const runningStatus = await monitor.status();
    expect(runningStatus.running).toBe(true);
    expect(runningStatus.details?.lastReading).toBeDefined();
    const reading = runningStatus.details?.lastReading as ContextReading;
    expect(reading.contextPercent).toBe(40);
    expect(runningStatus.details?.pollIntervalMs).toBe(30_000);
    expect(runningStatus.details?.thresholdPercent).toBe(70);

    await monitor.stop();
    const stoppedStatus = await monitor.status();
    expect(stoppedStatus.running).toBe(false);
  });

  it("handles session API errors gracefully", async () => {
    const sessionApi: SessionApi = {
      async getContextUsage() {
        throw new Error("session unavailable");
      },
    };
    const deps = makeDeps({ tmpDir, sessionApi });
    const monitor = createContextMonitor(deps);

    // Should not throw
    await monitor.start();
    await monitor.stop();

    expect(
      deps.logger.messages.error.some((m) => m.includes("poll failed") && m.includes("session unavailable")),
    ).toBe(true);
  });

  it("appends multiple readings to JSONL file", async () => {
    let usedTokens = 10_000;
    const sessionApi: SessionApi = {
      async getContextUsage() {
        const current = usedTokens;
        usedTokens += 10_000;
        return { usedTokens: current, maxTokens: 100_000 };
      },
    };
    const deps = makeDeps({ tmpDir, sessionApi });
    const monitor = createContextMonitor(deps);

    await monitor.start(); // first poll (10k)
    // Advance timers individually to allow async poll completion
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await monitor.stop();

    const content = await readFile(deps.historyPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const readings = lines.map((l) => JSON.parse(l) as ContextReading);
    expect(readings[0].usedTokens).toBe(10_000);
    expect(readings[1].usedTokens).toBe(20_000);
    // Each reading has increasing token counts
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i].usedTokens).toBeGreaterThan(readings[i - 1].usedTokens);
    }
  });

  it("start() is idempotent — calling twice does not double-poll", async () => {
    let callCount = 0;
    const sessionApi: SessionApi = {
      async getContextUsage() {
        callCount++;
        return { usedTokens: 10_000, maxTokens: 100_000 };
      },
    };
    const deps = makeDeps({ tmpDir, sessionApi });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.start(); // second call should be no-op
    expect(callCount).toBe(1); // only one initial poll

    await vi.advanceTimersByTimeAsync(30_000);
    expect(callCount).toBe(2); // only one timer firing

    await monitor.stop();
  });
});
