/**
 * Tests for value-monitor — verifies high-value content detection,
 * file change tracking, checkpoint triggering, cooldown enforcement,
 * secret redaction in logs, and identity.json change detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createValueMonitor,
  scanForValuePatterns,
  BUILTIN_PATTERNS,
} from "./value-monitor.js";
import type {
  AmcpPluginConfig,
  ValueMonitorDeps,
  CheckpointLogEntry,
  PluginLogger,
  FileWatcher,
  ValuePattern,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<AmcpPluginConfig> = {},
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

/**
 * Create a mock FileWatcher with controllable file hashes and content.
 */
function makeFileWatcher(
  initialFiles: Map<string, { hash: string; content: string }>,
): FileWatcher & {
  setFile(path: string, hash: string, content: string): void;
  removeFile(path: string): void;
} {
  const files = new Map(initialFiles);
  return {
    setFile(path: string, hash: string, content: string) {
      files.set(path, { hash, content });
    },
    removeFile(path: string) {
      files.delete(path);
    },
    async getFileHashes() {
      const result = new Map<string, string>();
      for (const [path, data] of files) {
        result.set(path, data.hash);
      }
      return result;
    },
    async readFile(path: string) {
      const data = files.get(path);
      return data?.content ?? null;
    },
  };
}

type TestMonitor = Awaited<ReturnType<typeof createValueMonitor>> & {
  waitForPendingPoll(): Promise<void>;
};

function makeDeps(
  overrides: Partial<ValueMonitorDeps> & { tmpDir: string },
): ValueMonitorDeps & {
  logger: ReturnType<typeof makeLogger>;
  emissions: Array<{ event: string; data?: Record<string, unknown> }>;
} {
  const logger = makeLogger();
  const emissions: Array<{
    event: string;
    data?: Record<string, unknown>;
  }> = [];
  return {
    config: makeConfig(
      overrides.config
        ? (overrides.config as Partial<AmcpPluginConfig>)
        : {},
    ),
    logger,
    emit: (event: string, data?: Record<string, unknown>) =>
      emissions.push({ event, data }),
    fileWatcher: overrides.fileWatcher ?? makeFileWatcher(new Map()),
    checkpointLogPath: join(overrides.tmpDir, "checkpoint-log.jsonl"),
    watchPaths: overrides.watchPaths ?? [],
    emissions,
    ...overrides,
  };
}

async function advanceAndFlush(
  monitor: TestMonitor,
  ms: number,
): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await monitor.waitForPendingPoll();
}

// ---------------------------------------------------------------------------
// Tests: Pattern scanning (pure function)
// ---------------------------------------------------------------------------

describe("scanForValuePatterns", () => {
  it("detects identity changes in JSON content", () => {
    const content = '{ "aid": "BxYz123", "publicKey": "abc" }';
    const detections = scanForValuePatterns(
      "/path/identity.json",
      content,
      BUILTIN_PATTERNS,
    );
    expect(detections.length).toBeGreaterThanOrEqual(1);
    expect(detections.some((d) => d.patternName === "identity_change")).toBe(
      true,
    );
  });

  it("detects API key secrets and redacts in summary", () => {
    const content = "my key is sk-abcdefghij1234567890abc";
    const detections = scanForValuePatterns(
      "/path/MEMORY.md",
      content,
      BUILTIN_PATTERNS,
    );
    expect(detections.some((d) => d.patternName === "secret_api_key")).toBe(
      true,
    );
    const det = detections.find((d) => d.patternName === "secret_api_key")!;
    expect(det.summary).toContain("[REDACTED]");
    expect(det.summary).not.toContain("sk-");
  });

  it("detects JWT tokens and redacts in summary", () => {
    const content =
      "token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    const detections = scanForValuePatterns(
      "/path/config.md",
      content,
      BUILTIN_PATTERNS,
    );
    expect(detections.some((d) => d.patternName === "secret_jwt")).toBe(true);
    const det = detections.find((d) => d.patternName === "secret_jwt")!;
    expect(det.summary).toContain("[REDACTED]");
    expect(det.summary).not.toContain("eyJ");
  });

  it("detects Telegram bot tokens and redacts", () => {
    const content = "bot: 12345678:AAGz_example_token_1234567890abcde";
    const detections = scanForValuePatterns(
      "/path/notify.md",
      content,
      BUILTIN_PATTERNS,
    );
    expect(detections.some((d) => d.patternName === "secret_bot_token")).toBe(
      true,
    );
    const det = detections.find((d) => d.patternName === "secret_bot_token")!;
    expect(det.summary).toContain("[REDACTED]");
  });

  it("detects important decision markers", () => {
    const content = "DECISION: We will use Ed25519 for all signing operations";
    const detections = scanForValuePatterns(
      "/path/MEMORY.md",
      content,
      BUILTIN_PATTERNS,
    );
    expect(
      detections.some((d) => d.patternName === "important_decision"),
    ).toBe(true);
    const det = detections.find(
      (d) => d.patternName === "important_decision",
    )!;
    expect(det.summary).toContain("Ed25519");
    expect(det.summary).not.toContain("[REDACTED]");
  });

  it("detects soul/identity changes", () => {
    const content = "My north star is to preserve agent memory at all costs.";
    const detections = scanForValuePatterns(
      "/path/SOUL.md",
      content,
      BUILTIN_PATTERNS,
    );
    expect(detections.some((d) => d.patternName === "soul_change")).toBe(true);
  });

  it("returns empty array when no patterns match", () => {
    const content = "Just a regular note about today's weather.";
    const detections = scanForValuePatterns(
      "/path/notes.md",
      content,
      BUILTIN_PATTERNS,
    );
    expect(detections).toHaveLength(0);
  });

  it("truncates long matches to 80 chars in summary", () => {
    const longDecision =
      "DECISION: " + "x".repeat(200);
    const detections = scanForValuePatterns(
      "/path/MEMORY.md",
      longDecision,
      BUILTIN_PATTERNS,
    );
    const det = detections.find(
      (d) => d.patternName === "important_decision",
    )!;
    expect(det.summary.length).toBeLessThanOrEqual(
      "MEMORY.md: important_decision — ".length + 80,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Value monitor service
// ---------------------------------------------------------------------------

describe("value-monitor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-val-test-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("exports start(), stop(), status() functions", () => {
    const deps = makeDeps({ tmpDir, watchPaths: [] });
    const monitor = createValueMonitor(deps);
    expect(typeof monitor.start).toBe("function");
    expect(typeof monitor.stop).toBe("function");
    expect(typeof monitor.status).toBe("function");
    expect(monitor.name).toBe("amcp-value-monitor");
  });

  it("captures initial file hashes on start without triggering checkpoint", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        [
          "/home/user/.amcp/identity.json",
          {
            hash: "hash-v1",
            content: '{ "aid": "BxYz123", "publicKey": "abc" }',
          },
        ],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/.amcp/identity.json"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();
    // Advance one poll cycle
    await advanceAndFlush(monitor, 30_000);
    await monitor.stop();

    // No checkpoint should trigger on first scan
    expect(deps.emissions).toHaveLength(0);
  });

  it("triggers checkpoint when identity.json changes", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        [
          "/home/user/.amcp/identity.json",
          {
            hash: "hash-v1",
            content: '{ "aid": "BoldAid", "publicKey": "key1" }',
          },
        ],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/.amcp/identity.json"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    // Change identity.json
    fileWatcher.setFile(
      "/home/user/.amcp/identity.json",
      "hash-v2",
      '{ "aid": "BnewAid999", "publicKey": "key2", "kel": [] }',
    );

    await advanceAndFlush(monitor, 30_000);
    await monitor.stop();

    const checkpointEvents = deps.emissions.filter(
      (e) => e.event === "amcp:checkpoint:requested",
    );
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents[0].data?.trigger).toBe("value_content");
  });

  it("does not trigger when file changes but no patterns match", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        [
          "/home/user/MEMORY.md",
          { hash: "hash-v1", content: "Some regular notes" },
        ],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/MEMORY.md"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    // Change file but keep content non-matching
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v2",
      "Updated regular notes, nothing special",
    );

    await advanceAndFlush(monitor, 30_000);
    await monitor.stop();

    expect(deps.emissions).toHaveLength(0);
  });

  it("respects cooldown between checkpoint triggers", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        [
          "/home/user/MEMORY.md",
          { hash: "hash-v1", content: "Nothing here" },
        ],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/MEMORY.md"],
      config: makeConfig({ checkpointCooldownMs: 120_000 }),
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    // First change — triggers
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v2",
      "DECISION: Use KERI identity model",
    );
    await advanceAndFlush(monitor, 30_000);

    // Second change within cooldown — blocked
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v3",
      "DECISION: Use ChaCha20 encryption",
    );
    await advanceAndFlush(monitor, 30_000);

    await monitor.stop();

    const checkpointEvents = deps.emissions.filter(
      (e) => e.event === "amcp:checkpoint:requested",
    );
    expect(checkpointEvents).toHaveLength(1);
    expect(
      deps.logger.messages.info.some((m) => m.includes("cooldown")),
    ).toBe(true);
  });

  it("triggers again after cooldown expires", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        [
          "/home/user/MEMORY.md",
          { hash: "hash-v1", content: "Nothing here" },
        ],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/MEMORY.md"],
      config: makeConfig({ checkpointCooldownMs: 60_000 }),
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    // First trigger
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v2",
      "DECISION: Use KERI identity",
    );
    await advanceAndFlush(monitor, 30_000);

    // Wait for cooldown to expire (60s total, already 30s in)
    await advanceAndFlush(monitor, 30_000);

    // Second trigger after cooldown
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v3",
      "CRITICAL: Must backup before migration",
    );
    await advanceAndFlush(monitor, 30_000);

    await monitor.stop();

    const checkpointEvents = deps.emissions.filter(
      (e) => e.event === "amcp:checkpoint:requested",
    );
    expect(checkpointEvents).toHaveLength(2);
  });

  it("logs trigger reason with content summary (no secrets)", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        [
          "/home/user/MEMORY.md",
          { hash: "hash-v1", content: "Start" },
        ],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/MEMORY.md"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    // Add secret content
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v2",
      "Found key: sk-abcdefghij1234567890abcdef",
    );
    await advanceAndFlush(monitor, 30_000);
    await monitor.stop();

    // Check checkpoint log
    const logContent = await readFile(deps.checkpointLogPath, "utf-8");
    const logEntry: CheckpointLogEntry = JSON.parse(logContent.trim());
    expect(logEntry.trigger).toBe("value_content");

    // Check emission includes summaries
    const event = deps.emissions[0];
    const detections = event.data?.detections as string[];
    expect(detections[0]).toContain("[REDACTED]");
    expect(detections[0]).not.toContain("sk-");
  });

  it("handles multiple files changing simultaneously", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        ["/home/user/SOUL.md", { hash: "hash-a1", content: "My identity" }],
        ["/home/user/MEMORY.md", { hash: "hash-b1", content: "Notes" }],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/SOUL.md", "/home/user/MEMORY.md"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    // Change both files
    fileWatcher.setFile(
      "/home/user/SOUL.md",
      "hash-a2",
      "My north star is truth",
    );
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-b2",
      "DECISION: Deploy to production",
    );
    await advanceAndFlush(monitor, 30_000);

    await monitor.stop();

    const event = deps.emissions[0];
    expect(event.data?.trigger).toBe("value_content");
    // fileCount should be 2 (both files detected)
    expect(event.data?.fileCount).toBe(2);
  });

  it("supports custom extra patterns", async () => {
    const customPattern: ValuePattern = {
      name: "custom_marker",
      pattern: /\[CHECKPOINT_NOW\]/,
      redact: false,
    };
    const fileWatcher = makeFileWatcher(
      new Map([
        ["/home/user/MEMORY.md", { hash: "hash-v1", content: "Start" }],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/MEMORY.md"],
      extraPatterns: [customPattern],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();

    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v2",
      "Please save now [CHECKPOINT_NOW]",
    );
    await advanceAndFlush(monitor, 30_000);
    await monitor.stop();

    expect(deps.emissions).toHaveLength(1);
    const detections = deps.emissions[0].data?.detections as string[];
    expect(detections.some((d) => d.includes("custom_marker"))).toBe(true);
  });

  it("handles missing files gracefully", async () => {
    const fileWatcher = makeFileWatcher(new Map());
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/nonexistent/file.md"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();
    await advanceAndFlush(monitor, 30_000);
    await monitor.stop();

    // No errors, no emissions
    expect(deps.emissions).toHaveLength(0);
    expect(deps.logger.messages.error).toHaveLength(0);
  });

  it("status() reports service details", async () => {
    const deps = makeDeps({
      tmpDir,
      watchPaths: ["/home/user/SOUL.md"],
    });
    const monitor = createValueMonitor(deps);

    await monitor.start();
    const status = await monitor.status();
    await monitor.stop();

    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-value-monitor");
    expect(status.details?.watchPaths).toEqual(["/home/user/SOUL.md"]);
    expect(status.details?.patternCount).toBe(BUILTIN_PATTERNS.length);
    expect(status.details?.pollIntervalMs).toBe(30_000);
  });

  it("stops polling after stop() is called", async () => {
    const fileWatcher = makeFileWatcher(
      new Map([
        ["/home/user/MEMORY.md", { hash: "hash-v1", content: "Init" }],
      ]),
    );
    const deps = makeDeps({
      tmpDir,
      fileWatcher,
      watchPaths: ["/home/user/MEMORY.md"],
    });
    const monitor = createValueMonitor(deps) as TestMonitor;

    await monitor.start();
    await monitor.stop();

    // Change after stop — should not trigger
    fileWatcher.setFile(
      "/home/user/MEMORY.md",
      "hash-v2",
      "DECISION: Important change after stop",
    );
    await advanceAndFlush(monitor, 60_000);

    expect(deps.emissions).toHaveLength(0);
  });
});
