/**
 * Tests for context-monitor time-based interval triggers (P4-CTX-03).
 *
 * Time-based triggers are checked during the regular 30s poll cycle.
 * After advancing fake timers, call monitor.waitForPendingPoll() to
 * ensure fire-and-forget async poll callbacks complete before asserting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContextMonitor } from "./context-monitor.js";
import type {
  AmcpPluginConfig,
  ContextMonitorDeps,
  CheckpointLogEntry,
  PluginLogger,
  SessionApi,
  ContentHasher,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers (shared with context-monitor.test.ts)
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

function makeContentHasher(initialHash = "hash-v1"): ContentHasher & { setHash: (h: string) => void } {
  let currentHash = initialHash;
  return {
    setHash(h: string) { currentHash = h; },
    async getContentHash() { return currentHash; },
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
    checkpointLogPath: overrides.checkpointLogPath ?? join(overrides.tmpDir, "checkpoint-log.jsonl"),
    emissions,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Type for monitor with test helper. */
type TestMonitor = ReturnType<typeof createContextMonitor> & {
  waitForPendingPoll(): Promise<void>;
};

/** Advance time and await the pending poll callback. */
async function advanceAndFlush(monitor: TestMonitor, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await monitor.waitForPendingPoll();
}

describe("context-monitor: time-based triggers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-ctx-interval-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does NOT trigger interval checkpoint when checkpointIntervalMs=0 (disabled)", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({ checkpointIntervalMs: 0 }),
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    await advanceAndFlush(monitor, 300_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(0);

    const status = await monitor.status();
    expect(status.details?.intervalEnabled).toBe(false);
    expect(status.details?.checkpointIntervalMs).toBe(0);
  });

  it("triggers checkpoint at configured interval (every 2 min)", async () => {
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 120_000, // 2 min
        checkpointCooldownMs: 30_000,
      }),
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    hasher.setHash("hash-v2");

    await advanceAndFlush(monitor, 120_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(1);
    expect(intervalEvents[0].data?.intervalMs).toBe(120_000);
  });

  it("triggers multiple checkpoints at each interval period", async () => {
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000, // 1 min
        checkpointCooldownMs: 10_000,
      }),
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    hasher.setHash("hash-v2");
    await advanceAndFlush(monitor, 60_000);

    hasher.setHash("hash-v3");
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(2);
  });

  it("skips checkpoint when no changes since last checkpoint (hash comparison)", async () => {
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000,
        checkpointCooldownMs: 10_000,
      }),
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();
    // Content hash captured on start as "hash-v1" — no change

    await advanceAndFlush(monitor, 90_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(0);

    expect(
      deps.logger.messages.info.some((m) => m.includes("skipping, no changes")),
    ).toBe(true);
  });

  it("triggers checkpoint when content changes after skip", async () => {
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000,
        checkpointCooldownMs: 10_000,
      }),
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    // First interval period — no change, skip
    await advanceAndFlush(monitor, 60_000);

    // Change content
    hasher.setHash("hash-v2");

    // Second interval period — content changed, trigger
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(1);
  });

  it("respects cooldown between time-based triggers", async () => {
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000,  // 1 min interval
        checkpointCooldownMs: 300_000, // 5 min cooldown
      }),
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    hasher.setHash("hash-v2");
    await advanceAndFlush(monitor, 60_000);

    hasher.setHash("hash-v3");
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(1);

    expect(
      deps.logger.messages.info.some((m) => m.includes("in cooldown")),
    ).toBe(true);
  });

  it("works without contentHasher — always triggers at interval", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000,
        checkpointCooldownMs: 10_000,
      }),
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    await advanceAndFlush(monitor, 60_000);
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(2);
  });

  it("writes time_interval trigger to checkpoint-log.jsonl", async () => {
    const logPath = join(tmpDir, "checkpoint-log.jsonl");
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000,
        checkpointCooldownMs: 10_000,
      }),
      checkpointLogPath: logPath,
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    hasher.setHash("hash-v2");
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const content = await readFile(logPath, "utf-8");
    const entry: CheckpointLogEntry = JSON.parse(content.trim());
    expect(entry.trigger).toBe("time_interval");
    expect(entry.cooldownMs).toBe(10_000);
    expect(entry.timestamp).toBeTruthy();
  });

  it("status() reflects interval configuration", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({ checkpointIntervalMs: 300_000 }),
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();
    const status = await monitor.status();

    expect(status.details?.checkpointIntervalMs).toBe(300_000);
    expect(status.details?.intervalEnabled).toBe(true);

    await monitor.stop();
  });

  it("logs interval enabled message on start", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({ checkpointIntervalMs: 300_000 }),
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();
    await monitor.stop();

    expect(
      deps.logger.messages.info.some(
        (m) => m.includes("time-based checkpoints enabled") && m.includes("5min"),
      ),
    ).toBe(true);
  });

  it("shares cooldown between threshold and interval triggers", async () => {
    const hasher = makeContentHasher("hash-v1");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(80_000, 100_000), // above 70% threshold
      config: makeConfig({
        checkpointIntervalMs: 60_000,
        checkpointCooldownMs: 300_000, // 5 min cooldown
        contextThreshold: 70,
      }),
      contentHasher: hasher,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();
    // Initial poll triggers threshold checkpoint (80% > 70%)
    const thresholdEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "context_threshold",
    );
    expect(thresholdEvents).toHaveLength(1);

    hasher.setHash("hash-v2");
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(0);
  });

  it("no interval triggers after stop()", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000,
        checkpointCooldownMs: 10_000,
      }),
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();
    await monitor.stop();

    const emissionsBefore = deps.emissions.length;

    await vi.advanceTimersByTimeAsync(300_000);

    expect(deps.emissions.length).toBe(emissionsBefore);
  });

  it("checkpoint created every N minutes when configured (P4-CTX-03 verification)", async () => {
    const logPath = join(tmpDir, "checkpoint-log.jsonl");
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(10_000, 100_000),
      config: makeConfig({
        checkpointIntervalMs: 60_000, // 1 min
        checkpointCooldownMs: 10_000,
      }),
      checkpointLogPath: logPath,
    });
    const monitor = createContextMonitor(deps) as TestMonitor;

    await monitor.start();

    await advanceAndFlush(monitor, 60_000);
    await advanceAndFlush(monitor, 60_000);
    await advanceAndFlush(monitor, 60_000);

    await monitor.stop();

    const intervalEvents = deps.emissions.filter(
      (e) => e.data?.trigger === "time_interval",
    );
    expect(intervalEvents).toHaveLength(3);

    const content = await readFile(logPath, "utf-8");
    const entries = content.trim().split("\n").map(
      (l) => JSON.parse(l) as CheckpointLogEntry,
    );
    expect(entries.filter((e) => e.trigger === "time_interval")).toHaveLength(3);
  });
});
