/**
 * Tests for 'openclaw amcp history' CLI command (P4-CLI-05).
 *
 * Verifies:
 * - Reads checkpoint-log.jsonl entries correctly
 * - Returns entries in reverse chronological order (newest first)
 * - --limit controls output count
 * - --json outputs machine-readable JSON
 * - Empty log handled gracefully
 * - Malformed lines skipped without crashing
 * - CID enrichment from last-checkpoint.json
 * - Human-readable table formatting
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runHistory,
  formatHistoryResult,
  createHistoryHandler,
} from "./history-command.js";
import type {
  HistoryCommandDeps,
  HistoryResult,
} from "./history-command.js";
import type { AmcpPluginConfig, PluginLogger, CheckpointLogEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeTempDir(): string {
  return join(
    tmpdir(),
    `amcp-history-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

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

function makeLogger(): { logger: PluginLogger; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    logger: {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
      error: (msg: string) => logs.push(`ERROR: ${msg}`),
      debug: (msg: string) => logs.push(`DEBUG: ${msg}`),
    },
  };
}

function makeDeps(
  overrides: Partial<HistoryCommandDeps> = {},
): HistoryCommandDeps {
  const { logger } = makeLogger();
  return {
    logger,
    config: makeConfig(),
    checkpointLogPath: join(testDir, "checkpoint-log.jsonl"),
    lastCheckpointPath: join(testDir, "last-checkpoint.json"),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<CheckpointLogEntry> = {}): CheckpointLogEntry {
  return {
    timestamp: "2025-01-20T10:30:00.000Z",
    trigger: "context_percent_exceeded",
    contextPercent: 75,
    usedTokens: 7500,
    maxTokens: 10000,
    cooldownMs: 300000,
    ...overrides,
  };
}

async function writeLogEntries(
  logPath: string,
  entries: CheckpointLogEntry[],
): Promise<void> {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(logPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = makeTempDir();
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: reading checkpoint log
// ---------------------------------------------------------------------------

describe("history: reading checkpoint log", () => {
  it("reads entries from checkpoint-log.jsonl", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entry = makeEntry();
    await writeLogEntries(logPath, [entry]);

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].trigger).toBe("context_percent_exceeded");
    expect(result.entries[0].contextPercent).toBe(75);
  });

  it("reads multiple entries", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = [
      makeEntry({ timestamp: "2025-01-20T10:30:00.000Z", trigger: "context_percent_exceeded" }),
      makeEntry({ timestamp: "2025-01-20T10:35:00.000Z", trigger: "value_detection" }),
      makeEntry({ timestamp: "2025-01-20T10:40:00.000Z", trigger: "time_interval" }),
    ];
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("returns entries in reverse chronological order (newest first)", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = [
      makeEntry({ timestamp: "2025-01-20T10:30:00.000Z", trigger: "oldest" }),
      makeEntry({ timestamp: "2025-01-20T10:35:00.000Z", trigger: "middle" }),
      makeEntry({ timestamp: "2025-01-20T10:40:00.000Z", trigger: "newest" }),
    ];
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.entries[0].trigger).toBe("newest");
    expect(result.entries[1].trigger).toBe("middle");
    expect(result.entries[2].trigger).toBe("oldest");
  });

  it("handles empty log file gracefully", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    await writeFile(logPath, "", "utf-8");

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("handles missing log file gracefully", async () => {
    // Don't create the file — path points to nonexistent file
    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("skips malformed JSON lines without crashing", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const validEntry = makeEntry({ trigger: "valid_entry" });
    const content = [
      JSON.stringify(validEntry),
      "this is not json",
      '{"incomplete": true',
      JSON.stringify(makeEntry({ trigger: "also_valid" })),
    ].join("\n") + "\n";
    await writeFile(logPath, content, "utf-8");

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.success).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].trigger).toBe("also_valid");
    expect(result.entries[1].trigger).toBe("valid_entry");
  });
});

// ---------------------------------------------------------------------------
// Tests: --limit flag
// ---------------------------------------------------------------------------

describe("history: --limit flag", () => {
  it("limits output to specified count", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        timestamp: `2025-01-20T10:${String(30 + i).padStart(2, "0")}:00.000Z`,
        trigger: `trigger_${i}`,
      }),
    );
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps, { limit: 3 });

    expect(result.entries).toHaveLength(3);
    expect(result.total).toBe(5);
    expect(result.showing).toBe(3);
  });

  it("returns all entries when limit exceeds total", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = [
      makeEntry({ trigger: "first" }),
      makeEntry({ trigger: "second" }),
    ];
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps, { limit: 100 });

    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.showing).toBe(2);
  });

  it("defaults to limit of 10", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = Array.from({ length: 15 }, (_, i) =>
      makeEntry({
        timestamp: `2025-01-20T10:${String(i).padStart(2, "0")}:00.000Z`,
        trigger: `trigger_${i}`,
      }),
    );
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.entries).toHaveLength(10);
    expect(result.total).toBe(15);
    expect(result.showing).toBe(10);
  });

  it("returns newest entries when limited", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        timestamp: `2025-01-20T10:${String(30 + i).padStart(2, "0")}:00.000Z`,
        trigger: `trigger_${i}`,
      }),
    );
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps, { limit: 2 });

    // Should return the two newest (trigger_4 and trigger_3)
    expect(result.entries[0].trigger).toBe("trigger_4");
    expect(result.entries[1].trigger).toBe("trigger_3");
  });
});

// ---------------------------------------------------------------------------
// Tests: CID enrichment from last-checkpoint.json
// ---------------------------------------------------------------------------

describe("history: CID enrichment", () => {
  it("enriches entry with CID when timestamp matches last-checkpoint.json", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const timestamp = "2025-01-20T10:30:00.000Z";
    await writeLogEntries(logPath, [makeEntry({ timestamp })]);

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        cid: "bafkreitestcid123456789abcdefghijklmnop",
        timestamp,
      }),
    );

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.entries[0].cid).toBe("bafkreitestcid123456789abcdefghijklmnop");
  });

  it("does not assign CID when timestamps do not match", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    await writeLogEntries(logPath, [
      makeEntry({ timestamp: "2025-01-20T10:30:00.000Z" }),
    ]);

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        cid: "bafkreidifferenttimestamp",
        timestamp: "2025-01-20T11:00:00.000Z",
      }),
    );

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.entries[0].cid).toBeNull();
  });

  it("handles missing last-checkpoint.json gracefully", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    await writeLogEntries(logPath, [makeEntry()]);

    // Don't create last-checkpoint.json
    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.success).toBe(true);
    expect(result.entries[0].cid).toBeNull();
  });

  it("reads pinataCid fallback from last-checkpoint.json", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const timestamp = "2025-01-20T10:30:00.000Z";
    await writeLogEntries(logPath, [makeEntry({ timestamp })]);

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        pinataCid: "QmPinataCidExample",
        timestamp,
      }),
    );

    const deps = makeDeps();
    const result = await runHistory(deps);

    expect(result.entries[0].cid).toBe("QmPinataCidExample");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatHistoryResult
// ---------------------------------------------------------------------------

describe("history: formatHistoryResult", () => {
  it("formats table with headers", () => {
    const result: HistoryResult = {
      success: true,
      entries: [
        {
          timestamp: "2025-01-20T10:30:00.000Z",
          trigger: "context_percent_exceeded",
          contextPercent: 75,
          usedTokens: 7500,
          maxTokens: 10000,
          cooldownMs: 300000,
          cid: null,
        },
      ],
      total: 1,
      showing: 1,
      error: null,
    };

    const output = formatHistoryResult(result);

    expect(output).toContain("=== Checkpoint History ===");
    expect(output).toContain("Timestamp");
    expect(output).toContain("Trigger");
    expect(output).toContain("Context %");
    expect(output).toContain("CID");
    expect(output).toContain("context percent exceeded");
    expect(output).toContain("75%");
  });

  it("shows 'No checkpoints recorded' when empty", () => {
    const result: HistoryResult = {
      success: true,
      entries: [],
      total: 0,
      showing: 0,
      error: null,
    };

    const output = formatHistoryResult(result);

    expect(output).toContain("No checkpoints recorded yet");
  });

  it("shows error message on failure", () => {
    const result: HistoryResult = {
      success: false,
      entries: [],
      total: 0,
      showing: 0,
      error: "Permission denied",
    };

    const output = formatHistoryResult(result);

    expect(output).toContain("Error: Permission denied");
  });

  it("shows showing/total count", () => {
    const result: HistoryResult = {
      success: true,
      entries: [
        {
          timestamp: "2025-01-20T10:30:00.000Z",
          trigger: "test",
          contextPercent: 50,
          usedTokens: 5000,
          maxTokens: 10000,
          cooldownMs: 300000,
          cid: null,
        },
      ],
      total: 42,
      showing: 1,
      error: null,
    };

    const output = formatHistoryResult(result);

    expect(output).toContain("Showing 1 of 42 checkpoints");
  });

  it("truncates long CIDs for display", () => {
    const result: HistoryResult = {
      success: true,
      entries: [
        {
          timestamp: "2025-01-20T10:30:00.000Z",
          trigger: "test",
          contextPercent: 50,
          usedTokens: 5000,
          maxTokens: 10000,
          cooldownMs: 300000,
          cid: "bafkreitestcid123456789abcdefghijklmnop",
        },
      ],
      total: 1,
      showing: 1,
      error: null,
    };

    const output = formatHistoryResult(result);

    // truncateCid: first 12 chars + "..." + last 4 chars
    expect(output).toContain("bafkreitestc...mnop");
    expect(output).not.toContain("bafkreitestcid123456789abcdefghijklmnop");
  });

  it("shows dash for entries without CID", () => {
    const result: HistoryResult = {
      success: true,
      entries: [
        {
          timestamp: "2025-01-20T10:30:00.000Z",
          trigger: "test",
          contextPercent: 50,
          usedTokens: 5000,
          maxTokens: 10000,
          cooldownMs: 300000,
          cid: null,
        },
      ],
      total: 1,
      showing: 1,
      error: null,
    };

    const output = formatHistoryResult(result);

    // The CID column should show "-" for null CIDs
    const lines = output.split("\n");
    const dataLine = lines.find((l) => l.includes("test"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain("-");
  });
});

// ---------------------------------------------------------------------------
// Tests: createHistoryHandler
// ---------------------------------------------------------------------------

describe("history: handler", () => {
  it("outputs JSON when --json flag is passed", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    await writeLogEntries(logPath, [makeEntry()]);

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createHistoryHandler(deps);

    await handler(["--json"]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.success).toBe(true);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.total).toBe(1);
  });

  it("outputs human-readable text by default", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    await writeLogEntries(logPath, [makeEntry()]);

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createHistoryHandler(deps);

    await handler([]);

    const output = logs.join("\n");
    expect(output).toContain("Checkpoint History");
    expect(output).toContain("context percent exceeded");
  });

  it("respects --limit flag via handler", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        timestamp: `2025-01-20T10:${String(30 + i).padStart(2, "0")}:00.000Z`,
        trigger: `trigger_${i}`,
      }),
    );
    await writeLogEntries(logPath, entries);

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createHistoryHandler(deps);

    await handler(["--json", "--limit", "2"]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.total).toBe(5);
    expect(parsed.showing).toBe(2);
  });

  it("rejects invalid --limit value", async () => {
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createHistoryHandler(deps);

    await handler(["--limit", "abc"]);

    expect(logs.some((l) => l.includes("--limit must be a positive integer"))).toBe(true);
  });

  it("rejects negative --limit value", async () => {
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createHistoryHandler(deps);

    await handler(["--limit", "-5"]);

    expect(logs.some((l) => l.includes("--limit must be a positive integer"))).toBe(true);
  });

  it("combines --json and --limit flags", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        timestamp: `2025-01-20T10:${String(i).padStart(2, "0")}:00.000Z`,
        trigger: `trigger_${i}`,
      }),
    );
    await writeLogEntries(logPath, entries);

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createHistoryHandler(deps);

    await handler(["--json", "--limit", "3"]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.success).toBe(true);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.total).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: history shows all checkpoints (P4-CLI-05 verification)
// ---------------------------------------------------------------------------

describe("history: P4-CLI-05 verification", () => {
  it("shows all checkpoints when limit is large enough", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const entries = [
      makeEntry({ timestamp: "2025-01-20T08:00:00.000Z", trigger: "gateway_start" }),
      makeEntry({ timestamp: "2025-01-20T09:00:00.000Z", trigger: "context_percent_exceeded", contextPercent: 72 }),
      makeEntry({ timestamp: "2025-01-20T10:00:00.000Z", trigger: "time_interval" }),
      makeEntry({ timestamp: "2025-01-20T11:00:00.000Z", trigger: "value_detection" }),
      makeEntry({ timestamp: "2025-01-20T12:00:00.000Z", trigger: "session_end" }),
    ];
    await writeLogEntries(logPath, entries);

    const deps = makeDeps();
    const result = await runHistory(deps, { limit: 100 });

    expect(result.success).toBe(true);
    expect(result.total).toBe(5);
    expect(result.showing).toBe(5);

    // All triggers present
    const triggers = result.entries.map((e) => e.trigger);
    expect(triggers).toContain("gateway_start");
    expect(triggers).toContain("context_percent_exceeded");
    expect(triggers).toContain("time_interval");
    expect(triggers).toContain("value_detection");
    expect(triggers).toContain("session_end");
  });

  it("includes CID, timestamp, and trigger reason for each entry", async () => {
    const logPath = join(testDir, "checkpoint-log.jsonl");
    const timestamp = "2025-01-20T10:30:00.000Z";
    await writeLogEntries(logPath, [
      makeEntry({ timestamp, trigger: "context_percent_exceeded", contextPercent: 80 }),
    ]);

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({ cid: "bafkreitestcid", timestamp }),
    );

    const deps = makeDeps();
    const result = await runHistory(deps);

    const entry = result.entries[0];
    expect(entry.timestamp).toBe(timestamp);
    expect(entry.trigger).toBe("context_percent_exceeded");
    expect(entry.cid).toBe("bafkreitestcid");
    expect(entry.contextPercent).toBe(80);
  });
});
