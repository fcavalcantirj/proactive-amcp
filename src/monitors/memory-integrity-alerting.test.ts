/**
 * Tests for P4-MEM-02: Alert on unauthorized memory changes.
 *
 * Verifies buildChangeSummary, appendChangeLog, pollOnce alerting,
 * event emission, and periodic polling lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFile,
  readFile,
  rm,
  mkdtemp,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sha256,
  buildChangeSummary,
  appendChangeLog,
  createMemoryIntegrityMonitor,
} from "./memory-integrity.js";
import type {
  MemoryIntegrityDeps,
  MemoryChangeAlert,
} from "./memory-integrity.js";
import type { AmcpPluginConfig, PluginLogger } from "../types.js";

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

async function createTestWorkspace(
  baseDir: string,
): Promise<{ contentDir: string }> {
  const contentDir = join(baseDir, "workspace");
  await mkdir(contentDir, { recursive: true });
  await mkdir(join(contentDir, "memory"), { recursive: true });

  await writeFile(join(contentDir, "SOUL.md"), "I am an AMCP agent.\n");
  await writeFile(join(contentDir, "MEMORY.md"), "# Memory\n\nI remember things.\n");
  await writeFile(
    join(contentDir, "memory", "2025-01-15.md"),
    "Today I learned about KERI.\n",
  );
  await writeFile(
    join(contentDir, "memory", "2025-01-16.md"),
    "Deployed to production.\n",
  );

  return { contentDir };
}

// ---------------------------------------------------------------------------
// Tests: buildChangeSummary
// ---------------------------------------------------------------------------

describe("buildChangeSummary", () => {
  it("summarizes changed files", () => {
    const summary = buildChangeSummary({
      changed: ["SOUL.md"],
      added: [],
      removed: [],
    });
    expect(summary).toBe("modified: SOUL.md");
  });

  it("summarizes added files", () => {
    const summary = buildChangeSummary({
      changed: [],
      added: ["memory/new.md"],
      removed: [],
    });
    expect(summary).toBe("added: memory/new.md");
  });

  it("summarizes removed files", () => {
    const summary = buildChangeSummary({
      changed: [],
      added: [],
      removed: ["MEMORY.md"],
    });
    expect(summary).toBe("removed: MEMORY.md");
  });

  it("summarizes all types together", () => {
    const summary = buildChangeSummary({
      changed: ["SOUL.md"],
      added: ["memory/new.md"],
      removed: ["MEMORY.md"],
    });
    expect(summary).toBe(
      "modified: SOUL.md; added: memory/new.md; removed: MEMORY.md",
    );
  });

  it("returns empty string when nothing changed", () => {
    const summary = buildChangeSummary({
      changed: [],
      added: [],
      removed: [],
    });
    expect(summary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: appendChangeLog
// ---------------------------------------------------------------------------

describe("appendChangeLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-changelog-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends alert entry as JSONL", async () => {
    const logPath = join(tmpDir, "changes.jsonl");
    const alert: MemoryChangeAlert = {
      timestamp: "2025-01-15T12:00:00Z",
      changed: ["SOUL.md"],
      added: [],
      removed: [],
      summary: "modified: SOUL.md",
    };

    await appendChangeLog(logPath, alert);
    const content = await readFile(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.changed).toEqual(["SOUL.md"]);
    expect(parsed.summary).toBe("modified: SOUL.md");
  });

  it("appends multiple entries", async () => {
    const logPath = join(tmpDir, "changes.jsonl");
    const alert1: MemoryChangeAlert = {
      timestamp: "2025-01-15T12:00:00Z",
      changed: ["SOUL.md"],
      added: [],
      removed: [],
      summary: "modified: SOUL.md",
    };
    const alert2: MemoryChangeAlert = {
      timestamp: "2025-01-15T12:05:00Z",
      changed: [],
      added: ["memory/new.md"],
      removed: [],
      summary: "added: memory/new.md",
    };

    await appendChangeLog(logPath, alert1);
    await appendChangeLog(logPath, alert2);

    const lines = (await readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).changed).toEqual(["SOUL.md"]);
    expect(JSON.parse(lines[1]).added).toEqual(["memory/new.md"]);
  });

  it("creates parent directories if needed", async () => {
    const deepPath = join(tmpDir, "a", "b", "changes.jsonl");
    const alert: MemoryChangeAlert = {
      timestamp: "2025-01-15T12:00:00Z",
      changed: [],
      added: [],
      removed: ["TOOLS.md"],
      summary: "removed: TOOLS.md",
    };

    await appendChangeLog(deepPath, alert);
    const content = await readFile(deepPath, "utf-8");
    expect(JSON.parse(content.trim()).removed).toEqual(["TOOLS.md"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: pollOnce — unauthorized change detection
// ---------------------------------------------------------------------------

describe("pollOnce (unauthorized change alerting)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-poll-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(
    overrides: Partial<MemoryIntegrityDeps> = {},
  ): MemoryIntegrityDeps & {
    logger: ReturnType<typeof makeLogger>;
    emissions: Array<{ event: string; data?: Record<string, unknown> }>;
  } {
    const logger = makeLogger();
    const emissions: Array<{
      event: string;
      data?: Record<string, unknown>;
    }> = [];
    return {
      config: makeConfig(),
      logger,
      emit: (event: string, data?: Record<string, unknown>) =>
        emissions.push({ event, data }),
      contentDir: join(tmpDir, "workspace"),
      baselinePath: join(tmpDir, "baseline.json"),
      changeLogPath: join(tmpDir, "changes.jsonl"),
      pollIntervalMs: 100_000, // large so timer doesn't fire during tests
      emissions,
      ...overrides,
    };
  }

  it("returns null when no baseline exists", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    // Don't start — no baseline
    const result = await monitor.pollOnce();
    expect(result).toBeNull();
  });

  it("returns null when nothing changed", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    const result = await monitor.pollOnce();
    await monitor.stop();

    expect(result).toBeNull();
  });

  it("detects external file modification and emits alert", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Simulate external modification (not by agent)
    await writeFile(join(contentDir, "SOUL.md"), "Tampered by external process.\n");

    const alert = await monitor.pollOnce();
    await monitor.stop();

    // Verify alert was returned
    expect(alert).not.toBeNull();
    expect(alert!.changed).toContain("SOUL.md");
    expect(alert!.summary).toContain("modified: SOUL.md");
    expect(alert!.timestamp).toBeTruthy();

    // Verify event was emitted
    const changeEvent = deps.emissions.find(
      (e) => e.event === "amcp:memory:unauthorized_change",
    );
    expect(changeEvent).toBeDefined();
    expect(changeEvent!.data?.changed).toEqual(["SOUL.md"]);
    expect(changeEvent!.data?.summary).toContain("modified: SOUL.md");
  });

  it("detects external file addition and emits alert", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Add a new memory file externally
    await writeFile(
      join(contentDir, "memory", "injected.md"),
      "Injected content.\n",
    );

    const alert = await monitor.pollOnce();
    await monitor.stop();

    expect(alert).not.toBeNull();
    expect(alert!.added).toContain(join("memory", "injected.md"));
    expect(alert!.summary).toContain("added:");
  });

  it("detects external file removal and emits alert", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Remove a memory file externally
    await rm(join(contentDir, "MEMORY.md"));

    const alert = await monitor.pollOnce();
    await monitor.stop();

    expect(alert).not.toBeNull();
    expect(alert!.removed).toContain("MEMORY.md");
    expect(alert!.summary).toContain("removed: MEMORY.md");
  });

  it("logs alert to change log file", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const changeLogPath = join(tmpDir, "changes.jsonl");
    const deps = makeDeps({ contentDir, changeLogPath });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await writeFile(join(contentDir, "SOUL.md"), "Tampered!\n");
    await monitor.pollOnce();
    await monitor.stop();

    // Verify change log was written
    const content = await readFile(changeLogPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.changed).toContain("SOUL.md");
    expect(entry.summary).toContain("modified: SOUL.md");
    expect(entry.timestamp).toBeTruthy();
  });

  it("logs warning on unauthorized change", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await writeFile(join(contentDir, "SOUL.md"), "Tampered!\n");
    await monitor.pollOnce();
    await monitor.stop();

    expect(
      deps.logger.messages.warn.some((m) =>
        m.includes("unauthorized change detected"),
      ),
    ).toBe(true);
  });

  it("starts periodic polling timer on start", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir, pollIntervalMs: 100_000 });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    const status = await monitor.status();
    expect(status.details?.polling).toBe(true);

    await monitor.stop();
    const statusAfter = await monitor.status();
    expect(statusAfter.details?.polling).toBe(false);
  });

  it("clears polling timer on stop", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir, pollIntervalMs: 100_000 });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const status = await monitor.status();
    expect(status.details?.polling).toBe(false);
  });
});
