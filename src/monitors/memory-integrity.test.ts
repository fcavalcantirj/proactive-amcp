/**
 * Tests for memory-integrity — verifies baseline creation, loading,
 * saving, comparison, file discovery, and the plugin service lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFile,
  rm,
  mkdtemp,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sha256,
  discoverMemoryFiles,
  hashMemoryFiles,
  createBaseline,
  loadBaseline,
  saveBaseline,
  compareToBaseline,
  createMemoryIntegrityMonitor,
} from "./memory-integrity.js";
import type {
  MemoryBaseline,
  MemoryIntegrityDeps,
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

/**
 * Create a workspace directory with memory files for testing.
 */
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
// Tests: sha256 (pure function)
// ---------------------------------------------------------------------------

describe("sha256", () => {
  it("returns a 64-character hex string", () => {
    const hash = sha256("hello world");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns same hash for same content", () => {
    expect(sha256("test")).toBe(sha256("test"));
  });

  it("returns different hash for different content", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

// ---------------------------------------------------------------------------
// Tests: discoverMemoryFiles
// ---------------------------------------------------------------------------

describe("discoverMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-mem-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers top-level memory files", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const files = await discoverMemoryFiles(contentDir);
    expect(files).toContain("SOUL.md");
    expect(files).toContain("MEMORY.md");
  });

  it("discovers memory/*.md files", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const files = await discoverMemoryFiles(contentDir);
    expect(files).toContain(join("memory", "2025-01-15.md"));
    expect(files).toContain(join("memory", "2025-01-16.md"));
  });

  it("skips non-.md files in memory/", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    await writeFile(join(contentDir, "memory", "data.json"), "{}");
    const files = await discoverMemoryFiles(contentDir);
    expect(files).not.toContain(join("memory", "data.json"));
  });

  it("returns empty array for empty directory", async () => {
    const emptyDir = join(tmpDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    const files = await discoverMemoryFiles(emptyDir);
    expect(files).toHaveLength(0);
  });

  it("returns sorted file list", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const files = await discoverMemoryFiles(contentDir);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Tests: hashMemoryFiles
// ---------------------------------------------------------------------------

describe("hashMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-hash-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns hash and size for each file", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const files = await discoverMemoryFiles(contentDir);
    const hashes = await hashMemoryFiles(contentDir, files);

    expect(hashes["SOUL.md"]).toBeDefined();
    expect(hashes["SOUL.md"].hash).toHaveLength(64);
    expect(hashes["SOUL.md"].size).toBeGreaterThan(0);
    expect(hashes["SOUL.md"].recordedAt).toBeTruthy();
  });

  it("produces correct SHA-256 for known content", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const hashes = await hashMemoryFiles(contentDir, ["SOUL.md"]);
    const expectedHash = sha256("I am an AMCP agent.\n");
    expect(hashes["SOUL.md"].hash).toBe(expectedHash);
  });

  it("skips files that disappeared", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const hashes = await hashMemoryFiles(contentDir, [
      "SOUL.md",
      "NONEXISTENT.md",
    ]);
    expect(hashes["SOUL.md"]).toBeDefined();
    expect(hashes["NONEXISTENT.md"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: createBaseline
// ---------------------------------------------------------------------------

describe("createBaseline", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-baseline-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates baseline with all discovered files", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const baseline = await createBaseline(contentDir);

    expect(baseline.createdAt).toBeTruthy();
    expect(baseline.updatedAt).toBeTruthy();
    expect(Object.keys(baseline.files).length).toBeGreaterThanOrEqual(4);
    expect(baseline.files["SOUL.md"]).toBeDefined();
    expect(baseline.files["MEMORY.md"]).toBeDefined();
  });

  it("handles empty workspace gracefully", async () => {
    const emptyDir = join(tmpDir, "empty");
    await mkdir(emptyDir, { recursive: true });
    const baseline = await createBaseline(emptyDir);
    expect(Object.keys(baseline.files)).toHaveLength(0);
    expect(baseline.createdAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: saveBaseline / loadBaseline
// ---------------------------------------------------------------------------

describe("saveBaseline / loadBaseline", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-save-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("round-trips baseline to disk", async () => {
    const baseline: MemoryBaseline = {
      createdAt: "2025-01-15T00:00:00Z",
      updatedAt: "2025-01-15T00:00:00Z",
      files: {
        "SOUL.md": {
          hash: "abc123",
          size: 42,
          recordedAt: "2025-01-15T00:00:00Z",
        },
      },
    };

    const path = join(tmpDir, ".amcp", "memory-baseline.json");
    await saveBaseline(path, baseline);
    const loaded = await loadBaseline(path);

    expect(loaded).not.toBeNull();
    expect(loaded!.files["SOUL.md"].hash).toBe("abc123");
    expect(loaded!.createdAt).toBe("2025-01-15T00:00:00Z");
  });

  it("returns null for missing file", async () => {
    const loaded = await loadBaseline(join(tmpDir, "nonexistent.json"));
    expect(loaded).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    const path = join(tmpDir, "corrupt.json");
    await writeFile(path, "not valid json {{{");
    const loaded = await loadBaseline(path);
    expect(loaded).toBeNull();
  });

  it("returns null for JSON without files field", async () => {
    const path = join(tmpDir, "bad-schema.json");
    await writeFile(path, '{ "createdAt": "2025-01-01" }');
    const loaded = await loadBaseline(path);
    expect(loaded).toBeNull();
  });

  it("creates parent directories if needed", async () => {
    const deepPath = join(tmpDir, "a", "b", "c", "baseline.json");
    const baseline: MemoryBaseline = {
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      files: {},
    };
    await saveBaseline(deepPath, baseline);
    const loaded = await loadBaseline(deepPath);
    expect(loaded).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: compareToBaseline
// ---------------------------------------------------------------------------

describe("compareToBaseline", () => {
  const now = "2025-01-15T00:00:00Z";

  it("detects changed files", () => {
    const baseline: MemoryBaseline = {
      createdAt: now,
      updatedAt: now,
      files: {
        "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
        "MEMORY.md": { hash: "bbb", size: 20, recordedAt: now },
      },
    };

    const current = {
      "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
      "MEMORY.md": { hash: "ccc", size: 25, recordedAt: now },
    };

    const diff = compareToBaseline(baseline, current);
    expect(diff.changed).toEqual(["MEMORY.md"]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("detects added files", () => {
    const baseline: MemoryBaseline = {
      createdAt: now,
      updatedAt: now,
      files: {
        "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
      },
    };

    const current = {
      "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
      "memory/new.md": { hash: "ddd", size: 30, recordedAt: now },
    };

    const diff = compareToBaseline(baseline, current);
    expect(diff.added).toEqual(["memory/new.md"]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("detects removed files", () => {
    const baseline: MemoryBaseline = {
      createdAt: now,
      updatedAt: now,
      files: {
        "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
        "MEMORY.md": { hash: "bbb", size: 20, recordedAt: now },
      },
    };

    const current = {
      "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
    };

    const diff = compareToBaseline(baseline, current);
    expect(diff.removed).toEqual(["MEMORY.md"]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
  });

  it("detects all three types simultaneously", () => {
    const baseline: MemoryBaseline = {
      createdAt: now,
      updatedAt: now,
      files: {
        "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
        "MEMORY.md": { hash: "bbb", size: 20, recordedAt: now },
        "memory/old.md": { hash: "eee", size: 15, recordedAt: now },
      },
    };

    const current = {
      "SOUL.md": { hash: "xxx", size: 12, recordedAt: now }, // changed
      "MEMORY.md": { hash: "bbb", size: 20, recordedAt: now }, // same
      "memory/new.md": { hash: "fff", size: 30, recordedAt: now }, // added
      // memory/old.md missing — removed
    };

    const diff = compareToBaseline(baseline, current);
    expect(diff.changed).toEqual(["SOUL.md"]);
    expect(diff.added).toEqual(["memory/new.md"]);
    expect(diff.removed).toEqual(["memory/old.md"]);
  });

  it("returns empty arrays when nothing changed", () => {
    const baseline: MemoryBaseline = {
      createdAt: now,
      updatedAt: now,
      files: {
        "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
      },
    };

    const current = {
      "SOUL.md": { hash: "aaa", size: 10, recordedAt: now },
    };

    const diff = compareToBaseline(baseline, current);
    expect(diff.changed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: createMemoryIntegrityMonitor service
// ---------------------------------------------------------------------------

describe("createMemoryIntegrityMonitor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-monitor-test-"));
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
      emissions,
      ...overrides,
    };
  }

  it("creates baseline on first start when none exists", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const baseline = monitor.getBaseline();
    expect(baseline).not.toBeNull();
    expect(Object.keys(baseline!.files).length).toBeGreaterThanOrEqual(4);
    expect(deps.emissions.some((e) => e.event === "amcp:memory:baseline_created")).toBe(true);
  });

  it("loads existing baseline on start", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const baselinePath = join(tmpDir, "baseline.json");

    // Pre-create a baseline
    const preBaseline: MemoryBaseline = {
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      files: {
        "SOUL.md": {
          hash: "preexisting",
          size: 10,
          recordedAt: "2025-01-01T00:00:00Z",
        },
      },
    };
    await saveBaseline(baselinePath, preBaseline);

    const deps = makeDeps({ contentDir, baselinePath });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await monitor.stop();

    const baseline = monitor.getBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline!.files["SOUL.md"].hash).toBe("preexisting");
    // Should NOT emit baseline_created for existing baseline
    expect(deps.emissions.some((e) => e.event === "amcp:memory:baseline_created")).toBe(false);
  });

  it("refreshBaseline updates baseline and saves to disk", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const baselinePath = join(tmpDir, "baseline.json");
    const deps = makeDeps({ contentDir, baselinePath });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Modify a file
    await writeFile(join(contentDir, "SOUL.md"), "Updated soul.\n");

    // Refresh baseline
    const refreshed = await monitor.refreshBaseline();
    expect(refreshed.files["SOUL.md"].hash).toBe(sha256("Updated soul.\n"));

    // Verify it was saved to disk
    const loaded = await loadBaseline(baselinePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.files["SOUL.md"].hash).toBe(sha256("Updated soul.\n"));

    // Verify event emitted
    expect(deps.emissions.some((e) => e.event === "amcp:memory:baseline_updated")).toBe(true);

    await monitor.stop();
  });

  it("checkIntegrity detects changes vs baseline", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Modify SOUL.md after baseline creation
    await writeFile(join(contentDir, "SOUL.md"), "Tampered content.\n");

    const result = await monitor.checkIntegrity();
    expect(result.changed).toContain("SOUL.md");

    await monitor.stop();
  });

  it("checkIntegrity returns empty when nothing changed", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    const result = await monitor.checkIntegrity();
    expect(result.changed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);

    await monitor.stop();
  });

  it("checkIntegrity returns empty before start (no baseline)", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    // Don't start — no baseline
    const result = await monitor.checkIntegrity();
    expect(result.changed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("status reports correct service details", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    const status = await monitor.status();
    await monitor.stop();

    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-memory-integrity");
    expect(status.details?.hasBaseline).toBe(true);
    expect((status.details?.fileCount as number)).toBeGreaterThanOrEqual(4);
  });

  it("does not create baseline when disabled", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({
      contentDir,
      config: makeConfig({
        memoryIntegrity: {
          enabled: false,
          promptInjectionScan: false,
          autoRestore: false,
        },
      }),
    });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await monitor.stop();

    expect(monitor.getBaseline()).toBeNull();
    expect(deps.logger.messages.info.some((m) => m.includes("disabled"))).toBe(true);
  });

  it("has correct service name", () => {
    const deps = makeDeps();
    const monitor = createMemoryIntegrityMonitor(deps);
    expect(monitor.name).toBe("amcp-memory-integrity");
  });
});
