/**
 * Tests for context-monitor context warning emissions (P4-HOOK-03).
 *
 * Verifies two-tier context warning system:
 * - Warning at 60% threshold
 * - Critical at 80% threshold
 * - No duplicate emissions at same severity
 * - Severity escalation tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContextMonitor } from "./context-monitor.js";
import type {
  AmcpPluginConfig,
  ContextMonitorDeps,
  PluginLogger,
  SessionApi,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers (same pattern as context-monitor.test.ts)
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
    checkpointLogPath: overrides.checkpointLogPath ?? join(overrides.tmpDir, "checkpoint-log.jsonl"),
    emissions,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Context warning emissions
// ---------------------------------------------------------------------------

describe("context-monitor: context warnings (P4-HOOK-03)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-ctx-warn-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("emits warning at 60% threshold", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(60_000, 100_000), // 60%
      config: makeConfig({ contextThreshold: 90 }), // high checkpoint threshold to avoid noise
    });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const warnings = deps.emissions.filter((e) => e.event === "amcp:context:warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].data).toEqual(
      expect.objectContaining({
        severity: "warning",
        contextPercent: 60,
        threshold: 60,
      }),
    );
  });

  it("emits critical at 80% threshold", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(80_000, 100_000), // 80%
      config: makeConfig({ contextThreshold: 90 }),
    });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const warnings = deps.emissions.filter((e) => e.event === "amcp:context:warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].data).toEqual(
      expect.objectContaining({
        severity: "critical",
        contextPercent: 80,
        threshold: 80,
      }),
    );
  });

  it("does not emit warning below 60%", async () => {
    const deps = makeDeps({
      tmpDir,
      sessionApi: makeSessionApi(50_000, 100_000), // 50%
      config: makeConfig({ contextThreshold: 90 }),
    });
    const monitor = createContextMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const warnings = deps.emissions.filter((e) => e.event === "amcp:context:warning");
    expect(warnings).toHaveLength(0);
  });

  it("does not emit duplicate warning at same severity", async () => {
    // First poll at 65%, second poll at 68% — both warning level, only emit once
    let callCount = 0;
    const sessionApi: SessionApi = {
      async getContextUsage() {
        callCount++;
        return callCount === 1
          ? { usedTokens: 65_000, maxTokens: 100_000 }
          : { usedTokens: 68_000, maxTokens: 100_000 };
      },
    };

    const deps = makeDeps({
      tmpDir,
      sessionApi,
      config: makeConfig({ contextThreshold: 90 }),
    });
    const monitor = createContextMonitor(deps) as unknown as {
      start(): Promise<void>;
      stop(): Promise<void>;
      waitForPendingPoll(): Promise<void>;
    };

    await monitor.start();
    vi.advanceTimersByTime(30_000);
    await monitor.waitForPendingPoll();
    await monitor.stop();

    const warnings = deps.emissions.filter((e) => e.event === "amcp:context:warning");
    expect(warnings).toHaveLength(1); // only first crossing emits
  });

  it("escalates from warning to critical on severity change", async () => {
    // First poll at 65% (warning), second poll at 85% (critical)
    let callCount = 0;
    const sessionApi: SessionApi = {
      async getContextUsage() {
        callCount++;
        return callCount === 1
          ? { usedTokens: 65_000, maxTokens: 100_000 }
          : { usedTokens: 85_000, maxTokens: 100_000 };
      },
    };

    const deps = makeDeps({
      tmpDir,
      sessionApi,
      config: makeConfig({ contextThreshold: 90 }),
    });
    const monitor = createContextMonitor(deps) as unknown as {
      start(): Promise<void>;
      stop(): Promise<void>;
      waitForPendingPoll(): Promise<void>;
    };

    await monitor.start();
    vi.advanceTimersByTime(30_000);
    await monitor.waitForPendingPoll();
    await monitor.stop();

    const warnings = deps.emissions.filter((e) => e.event === "amcp:context:warning");
    expect(warnings).toHaveLength(2);
    expect(warnings[0].data?.severity).toBe("warning");
    expect(warnings[1].data?.severity).toBe("critical");
  });
});
