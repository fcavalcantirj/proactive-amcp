/**
 * Tests for P4-MEM-04: Auto-restore from checkpoint on tampering detection.
 *
 * Verifies:
 *   - Tampered files are quarantined to ~/.amcp/quarantine/
 *   - Clean files are restored from snapshot
 *   - Added (unauthorized) files are quarantined
 *   - Removed files are restored from snapshot
 *   - Restore actions are logged to JSONL
 *   - Integration with memory-integrity monitor (pollOnce triggers auto-restore)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFile,
  readFile,
  readdir,
  rm,
  mkdtemp,
  mkdir,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  autoRestore,
  saveSnapshot,
  saveAllSnapshots,
  hasSnapshot,
  removeSnapshot,
} from "./memory-auto-restore.js";
import { createMemoryIntegrityMonitor } from "./memory-integrity.js";
import type { MemoryIntegrityDeps } from "./memory-integrity.js";
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
      promptInjectionScan: false, // disable injection scan in restore tests
      autoRestore: true,
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

  return { contentDir };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests: snapshot management
// ---------------------------------------------------------------------------

describe("snapshot management", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-snapshot-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("saves a snapshot of a single file", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");

    await saveSnapshot(contentDir, "SOUL.md", snapshotDir);

    const snapshotContent = await readFile(join(snapshotDir, "SOUL.md"), "utf-8");
    expect(snapshotContent).toBe("I am an AMCP agent.\n");
  });

  it("saves snapshots for all files", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");

    await saveAllSnapshots(
      contentDir,
      ["SOUL.md", "MEMORY.md", "memory/2025-01-15.md"],
      snapshotDir,
    );

    expect(await hasSnapshot("SOUL.md", snapshotDir)).toBe(true);
    expect(await hasSnapshot("MEMORY.md", snapshotDir)).toBe(true);
    expect(await hasSnapshot("memory/2025-01-15.md", snapshotDir)).toBe(true);
    expect(await hasSnapshot("nonexistent.md", snapshotDir)).toBe(false);
  });

  it("removes a snapshot", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");

    await saveSnapshot(contentDir, "SOUL.md", snapshotDir);
    expect(await hasSnapshot("SOUL.md", snapshotDir)).toBe(true);

    await removeSnapshot("SOUL.md", snapshotDir);
    expect(await hasSnapshot("SOUL.md", snapshotDir)).toBe(false);
  });

  it("removeSnapshot is idempotent", async () => {
    const snapshotDir = join(tmpDir, "snapshots");
    // Removing a non-existent snapshot should not throw
    await expect(removeSnapshot("nonexistent.md", snapshotDir)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: autoRestore
// ---------------------------------------------------------------------------

describe("autoRestore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-restore-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("quarantines tampered file and restores from snapshot", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const quarantineDir = join(tmpDir, "quarantine");
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");
    const logger = makeLogger();

    // Save clean snapshot
    await saveAllSnapshots(contentDir, ["SOUL.md", "MEMORY.md"], snapshotDir);

    // Tamper with SOUL.md
    await writeFile(join(contentDir, "SOUL.md"), "I am compromised!\n");

    const result = await autoRestore(
      contentDir,
      ["SOUL.md"], // changed
      [],          // added
      [],          // removed
      snapshotDir,
      quarantineDir,
      restoreLogPath,
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.restoredCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].relativePath).toBe("SOUL.md");
    expect(result.files[0].restored).toBe(true);
    expect(result.files[0].reason).toBe("modified");

    // Verify file restored to original content
    const restored = await readFile(join(contentDir, "SOUL.md"), "utf-8");
    expect(restored).toBe("I am an AMCP agent.\n");

    // Verify tampered file was quarantined
    expect(await fileExists(result.files[0].quarantinePath)).toBe(true);
    const quarantined = await readFile(result.files[0].quarantinePath, "utf-8");
    expect(quarantined).toBe("I am compromised!\n");
  });

  it("quarantines externally added files", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const quarantineDir = join(tmpDir, "quarantine");
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");
    const logger = makeLogger();

    // Add unauthorized file
    await writeFile(join(contentDir, "memory", "injected.md"), "Malicious content.\n");

    const result = await autoRestore(
      contentDir,
      [],                    // changed
      ["memory/injected.md"], // added
      [],                    // removed
      snapshotDir,
      quarantineDir,
      restoreLogPath,
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.quarantinedOnlyCount).toBe(1);
    expect(result.files[0].reason).toBe("added");
    expect(result.files[0].restored).toBe(false);

    // Verify injected file removed from workspace
    expect(await fileExists(join(contentDir, "memory", "injected.md"))).toBe(false);

    // Verify quarantined
    expect(await fileExists(result.files[0].quarantinePath)).toBe(true);
  });

  it("restores removed files from snapshot", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const quarantineDir = join(tmpDir, "quarantine");
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");
    const logger = makeLogger();

    // Save snapshot
    await saveAllSnapshots(contentDir, ["MEMORY.md"], snapshotDir);

    // Remove file
    await rm(join(contentDir, "MEMORY.md"));
    expect(await fileExists(join(contentDir, "MEMORY.md"))).toBe(false);

    const result = await autoRestore(
      contentDir,
      [],           // changed
      [],           // added
      ["MEMORY.md"], // removed
      snapshotDir,
      quarantineDir,
      restoreLogPath,
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.restoredCount).toBe(1);
    expect(result.removedFiles).toEqual(["MEMORY.md"]);

    // Verify file restored
    const content = await readFile(join(contentDir, "MEMORY.md"), "utf-8");
    expect(content).toBe("# Memory\n\nI remember things.\n");
  });

  it("logs restore action to JSONL file", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const quarantineDir = join(tmpDir, "quarantine");
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");

    await saveAllSnapshots(contentDir, ["SOUL.md"], snapshotDir);
    await writeFile(join(contentDir, "SOUL.md"), "Tampered!\n");

    await autoRestore(
      contentDir,
      ["SOUL.md"],
      [],
      [],
      snapshotDir,
      quarantineDir,
      restoreLogPath,
    );

    const logContent = await readFile(restoreLogPath, "utf-8");
    const entry = JSON.parse(logContent.trim());
    expect(entry.action).toBe("auto_restore");
    expect(entry.filesRestored).toContain("SOUL.md");
    expect(entry.quarantineDir).toBeTruthy();
    expect(entry.reason).toContain("1 modified");
  });

  it("handles missing snapshot gracefully (quarantine only)", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots"); // empty — no snapshots
    const quarantineDir = join(tmpDir, "quarantine");
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");
    const logger = makeLogger();

    await writeFile(join(contentDir, "SOUL.md"), "Tampered!\n");

    const result = await autoRestore(
      contentDir,
      ["SOUL.md"],
      [],
      [],
      snapshotDir,
      quarantineDir,
      restoreLogPath,
      logger,
    );

    expect(result.success).toBe(true);
    expect(result.quarantinedOnlyCount).toBe(1);
    expect(result.restoredCount).toBe(0);

    // File should be gone from workspace (quarantined)
    expect(await fileExists(join(contentDir, "SOUL.md"))).toBe(false);

    // Logger should warn about missing snapshot
    expect(
      logger.messages.warn.some((m) => m.includes("no snapshot available")),
    ).toBe(true);
  });

  it("handles multiple files (changed + added + removed)", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const quarantineDir = join(tmpDir, "quarantine");
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");
    const logger = makeLogger();

    await saveAllSnapshots(
      contentDir,
      ["SOUL.md", "MEMORY.md", "memory/2025-01-15.md"],
      snapshotDir,
    );

    // Tamper SOUL.md
    await writeFile(join(contentDir, "SOUL.md"), "TAMPERED\n");
    // Add unauthorized file
    await writeFile(join(contentDir, "memory", "evil.md"), "Evil content\n");
    // Remove MEMORY.md
    await rm(join(contentDir, "MEMORY.md"));

    const result = await autoRestore(
      contentDir,
      ["SOUL.md"],
      ["memory/evil.md"],
      ["MEMORY.md"],
      snapshotDir,
      quarantineDir,
      restoreLogPath,
      logger,
    );

    expect(result.success).toBe(true);
    // SOUL.md restored + MEMORY.md restored = 2
    expect(result.restoredCount).toBe(2);
    // evil.md quarantined only = 1
    expect(result.quarantinedOnlyCount).toBe(1);
    // SOUL.md restored to original
    expect(await readFile(join(contentDir, "SOUL.md"), "utf-8")).toBe(
      "I am an AMCP agent.\n",
    );
    // MEMORY.md restored
    expect(await readFile(join(contentDir, "MEMORY.md"), "utf-8")).toBe(
      "# Memory\n\nI remember things.\n",
    );
    // evil.md removed from workspace
    expect(await fileExists(join(contentDir, "memory", "evil.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: integration with memory-integrity monitor
// ---------------------------------------------------------------------------

describe("memory-integrity monitor with autoRestore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "amcp-integrity-restore-test-"));
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
      pollIntervalMs: 100_000,
      snapshotDir: join(tmpDir, "snapshots"),
      quarantineDir: join(tmpDir, "quarantine"),
      restoreLogPath: join(tmpDir, "restore-log.jsonl"),
      emissions,
      ...overrides,
    };
  }

  it("auto-restores tampered file on pollOnce when autoRestore enabled", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Tamper with SOUL.md
    await writeFile(join(contentDir, "SOUL.md"), "Tampered by attacker.\n");

    const alert = await monitor.pollOnce();
    await monitor.stop();

    // Alert should still be returned
    expect(alert).not.toBeNull();
    expect(alert!.changed).toContain("SOUL.md");

    // File should be restored to original
    const content = await readFile(join(contentDir, "SOUL.md"), "utf-8");
    expect(content).toBe("I am an AMCP agent.\n");

    // auto_restored event should be emitted
    const restoreEvent = deps.emissions.find(
      (e) => e.event === "amcp:memory:auto_restored",
    );
    expect(restoreEvent).toBeDefined();
    expect(restoreEvent!.data?.restoredCount).toBe(1);
    expect(restoreEvent!.data?.success).toBe(true);

    // getLastRestoreResult should return the result
    const lastRestore = monitor.getLastRestoreResult();
    expect(lastRestore).not.toBeNull();
    expect(lastRestore!.restoredCount).toBe(1);
  });

  it("does NOT auto-restore when autoRestore is disabled", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({
      contentDir,
      config: makeConfig({
        memoryIntegrity: {
          enabled: true,
          promptInjectionScan: false,
          autoRestore: false,
        },
      }),
    });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Tamper
    await writeFile(join(contentDir, "SOUL.md"), "Tampered.\n");

    const alert = await monitor.pollOnce();
    await monitor.stop();

    // Alert should be returned
    expect(alert).not.toBeNull();

    // File should remain tampered (no auto-restore)
    const content = await readFile(join(contentDir, "SOUL.md"), "utf-8");
    expect(content).toBe("Tampered.\n");

    // No auto_restored event
    const restoreEvent = deps.emissions.find(
      (e) => e.event === "amcp:memory:auto_restored",
    );
    expect(restoreEvent).toBeUndefined();

    // No last restore result
    expect(monitor.getLastRestoreResult()).toBeNull();
  });

  it("creates snapshots on baseline creation when autoRestore enabled", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const deps = makeDeps({ contentDir, snapshotDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    await monitor.stop();

    // Snapshots should exist
    expect(await fileExists(join(snapshotDir, "SOUL.md"))).toBe(true);
    expect(await fileExists(join(snapshotDir, "MEMORY.md"))).toBe(true);
  });

  it("updates snapshots on baseline refresh", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const snapshotDir = join(tmpDir, "snapshots");
    const deps = makeDeps({ contentDir, snapshotDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Modify SOUL.md legitimately then refresh baseline
    await writeFile(join(contentDir, "SOUL.md"), "Updated identity.\n");
    await monitor.refreshBaseline();
    await monitor.stop();

    // Snapshot should reflect new content
    const snapshotContent = await readFile(join(snapshotDir, "SOUL.md"), "utf-8");
    expect(snapshotContent).toBe("Updated identity.\n");
  });

  it("quarantines tampered file for analysis", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const quarantineDir = join(tmpDir, "quarantine");
    const deps = makeDeps({ contentDir, quarantineDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    // Tamper
    await writeFile(join(contentDir, "SOUL.md"), "Injected payload.\n");
    await monitor.pollOnce();
    await monitor.stop();

    // Quarantine directory should exist and contain the tampered file
    const qEntries = await readdir(quarantineDir);
    expect(qEntries.length).toBeGreaterThan(0);

    // Find the tampered file in quarantine
    const qSubDir = join(quarantineDir, qEntries[0]);
    const quarantinedContent = await readFile(join(qSubDir, "SOUL.md"), "utf-8");
    expect(quarantinedContent).toBe("Injected payload.\n");
  });

  it("logs restore action with reason", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const restoreLogPath = join(tmpDir, "restore-log.jsonl");
    const deps = makeDeps({ contentDir, restoreLogPath });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();

    await writeFile(join(contentDir, "SOUL.md"), "Tampered!\n");
    await monitor.pollOnce();
    await monitor.stop();

    const logContent = await readFile(restoreLogPath, "utf-8");
    const entry = JSON.parse(logContent.trim());
    expect(entry.action).toBe("auto_restore");
    expect(entry.filesRestored).toContain("SOUL.md");
    expect(entry.reason).toBeTruthy();
  });

  it("status includes autoRestore info", async () => {
    const { contentDir } = await createTestWorkspace(tmpDir);
    const deps = makeDeps({ contentDir });
    const monitor = createMemoryIntegrityMonitor(deps);

    await monitor.start();
    const status = await monitor.status();
    await monitor.stop();

    expect(status.details?.autoRestore).toBe(true);
    expect(status.details?.snapshotDir).toBeTruthy();
    expect(status.details?.quarantineDir).toBeTruthy();
  });
});
