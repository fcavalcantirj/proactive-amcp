/**
 * Tests for resurrection-detector — verifies context wipe detection,
 * session restart detection, and logging.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { readFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResurrectionDetector } from "./resurrection-detector.js";
import type {
  PluginLogger,
  SessionApi,
  AmcpPluginConfig,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeEmitter(): {
  emitted: Array<{ event: string; data?: Record<string, unknown> }>;
  emit: (event: string, data?: Record<string, unknown>) => void;
} {
  const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
  return {
    emitted,
    emit: (event, data) => emitted.push({ event, data }),
  };
}

function makeConfig(
  overrides?: Partial<AmcpPluginConfig>,
): AmcpPluginConfig {
  return {
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
    ...overrides,
  };
}

/**
 * Create a mock SessionApi that returns usage values from a queue.
 * Each call to getContextUsage() shifts the next value from the queue.
 */
function makeSessionApi(
  readings: Array<{ usedTokens: number; maxTokens: number }>,
): SessionApi {
  let index = 0;
  return {
    async getContextUsage() {
      if (index < readings.length) {
        return readings[index++];
      }
      // Return last reading if queue exhausted
      return readings[readings.length - 1];
    },
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-res-detect-test-"));
  await mkdir(join(tmpDir, "amcp"), { recursive: true });
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Context drop detection
// ---------------------------------------------------------------------------

describe("createResurrectionDetector", () => {
  it("starts and stops cleanly", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();
    const sessionApi = makeSessionApi([
      { usedTokens: 5000, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
    });

    expect(detector.name).toBe("amcp-resurrection-detector");

    await detector.start();
    const status = await detector.status();
    expect(status.running).toBe(true);
    expect(
      (status.details as Record<string, unknown>).service,
    ).toBe("amcp-resurrection-detector");

    await detector.stop();
    const stoppedStatus = await detector.status();
    expect(stoppedStatus.running).toBe(false);
  });

  it("establishes baseline on first poll without detection", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();
    const sessionApi = makeSessionApi([
      { usedTokens: 50_000, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
    });

    await detector.start();
    await detector.waitForPendingPoll();

    expect(detector.getDetections()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(
      logger.messages.debug.some((m) => m.includes("baseline")),
    ).toBe(true);

    await detector.stop();
  });

  it("detects sudden context drop >50%", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();
    const logPath = join(tmpDir, "resurrection-log.jsonl");

    // First poll: 80k tokens. Second poll: 20k tokens (75% drop).
    const sessionApi = makeSessionApi([
      { usedTokens: 80_000, maxTokens: 100_000 },
      { usedTokens: 20_000, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath,
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    // Advance timer to trigger second poll
    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    const detections = detector.getDetections();
    expect(detections).toHaveLength(1);
    expect(detections[0].type).toBe("context_drop");
    expect(detections[0].previousTokens).toBe(80_000);
    expect(detections[0].currentTokens).toBe(20_000);
    expect(detections[0].dropPercent).toBe(75);

    // Should emit resurrection:detected
    expect(
      emitted.some((e) => e.event === "amcp:resurrection:detected"),
    ).toBe(true);
    const event = emitted.find(
      (e) => e.event === "amcp:resurrection:detected",
    );
    expect(event?.data?.type).toBe("context_drop");
    expect(event?.data?.dropPercent).toBe(75);

    // Should log to JSONL file
    vi.useRealTimers();
    const logContent = await readFile(logPath, "utf-8");
    const logEntry = JSON.parse(logContent.trim());
    expect(logEntry.type).toBe("context_drop");
    expect(logEntry.previousTokens).toBe(80_000);
    vi.useFakeTimers();

    await detector.stop();
  });

  it("detects session restart (context drops to 0)", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();
    const logPath = join(tmpDir, "resurrection-log.jsonl");

    // First poll: 50k tokens. Second poll: 0 tokens.
    const sessionApi = makeSessionApi([
      { usedTokens: 50_000, maxTokens: 100_000 },
      { usedTokens: 0, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath,
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    const detections = detector.getDetections();
    expect(detections).toHaveLength(1);
    expect(detections[0].type).toBe("session_restart");
    expect(detections[0].dropPercent).toBe(100);
    expect(detections[0].details).toContain("session restart");

    expect(
      emitted.some((e) => e.event === "amcp:resurrection:detected"),
    ).toBe(true);

    await detector.stop();
  });

  it("ignores small context changes (<50%)", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    // 20% drop: 50k -> 40k
    const sessionApi = makeSessionApi([
      { usedTokens: 50_000, maxTokens: 100_000 },
      { usedTokens: 40_000, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    expect(detector.getDetections()).toHaveLength(0);
    expect(emitted).toHaveLength(0);

    await detector.stop();
  });

  it("ignores drops from very low token counts", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    // Below MIN_TOKENS_FOR_DROP (1000): 500 -> 0
    const sessionApi = makeSessionApi([
      { usedTokens: 500, maxTokens: 100_000 },
      { usedTokens: 0, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    expect(detector.getDetections()).toHaveLength(0);
    expect(emitted).toHaveLength(0);

    await detector.stop();
  });

  it("does not monitor when autoDetect is disabled", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const sessionApi = makeSessionApi([
      { usedTokens: 80_000, maxTokens: 100_000 },
      { usedTokens: 0, maxTokens: 100_000 },
    ]);

    const config = makeConfig();
    config.resurrection.autoDetect = false;

    const detector = createResurrectionDetector({
      config,
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    expect(detector.getDetections()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(
      logger.messages.info.some((m) => m.includes("autoDetect disabled")),
    ).toBe(true);

    await detector.stop();
  });

  it("supports custom drop threshold", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    // 35% drop: 50k -> 32.5k — not 50% but over 30%
    const sessionApi = makeSessionApi([
      { usedTokens: 50_000, maxTokens: 100_000 },
      { usedTokens: 32_500, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 1000,
      dropThreshold: 0.3, // 30% threshold instead of 50%
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    expect(detector.getDetections()).toHaveLength(1);
    expect(detector.getDetections()[0].type).toBe("context_drop");

    await detector.stop();
  });

  it("handles sessionApi errors gracefully", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    let callCount = 0;
    const sessionApi: SessionApi = {
      async getContextUsage() {
        callCount++;
        if (callCount === 1) {
          return { usedTokens: 50_000, maxTokens: 100_000 };
        }
        throw new Error("session unavailable");
      },
    };

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    // Should not crash, should log error
    expect(detector.getDetections()).toHaveLength(0);
    expect(
      logger.messages.error.some((m) => m.includes("poll failed")),
    ).toBe(true);

    await detector.stop();
  });

  it("status() includes detection details", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const sessionApi = makeSessionApi([
      { usedTokens: 80_000, maxTokens: 100_000 },
      { usedTokens: 10_000, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 1000,
    });

    await detector.start();
    await detector.waitForPendingPoll();

    vi.advanceTimersByTime(1000);
    await detector.waitForPendingPoll();

    const status = await detector.status();
    const details = status.details as Record<string, unknown>;

    expect(details.service).toBe("amcp-resurrection-detector");
    expect(details.autoDetect).toBe(true);
    expect(details.totalDetections).toBe(1);
    expect(details.lastDetection).toBeDefined();

    await detector.stop();
  });

  it("context wipe detected within 1 poll cycle", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const sessionApi = makeSessionApi([
      { usedTokens: 90_000, maxTokens: 100_000 },
      { usedTokens: 5_000, maxTokens: 100_000 },
    ]);

    const detector = createResurrectionDetector({
      config: makeConfig(),
      logger,
      emit,
      sessionApi,
      logPath: join(tmpDir, "resurrection-log.jsonl"),
      pollIntervalMs: 500, // Fast poll for this test
    });

    await detector.start();
    await detector.waitForPendingPoll();

    // One tick later — detection should fire
    vi.advanceTimersByTime(500);
    await detector.waitForPendingPoll();

    expect(detector.getDetections()).toHaveLength(1);
    expect(
      emitted.some((e) => e.event === "amcp:resurrection:detected"),
    ).toBe(true);

    await detector.stop();
  });
});
