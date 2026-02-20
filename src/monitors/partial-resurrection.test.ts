/**
 * Tests for partial-resurrection — verifies pattern matching,
 * selective restore, state preservation, backup creation, and logging.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  patternToRegex,
  matchesAnyPattern,
  partialRestore,
  createPartialResurrectionService,
} from "./partial-resurrection.js";
import type { AmcpPluginConfig, PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let checkpointDir: string;
let workspaceDir: string;
let backupDir: string;
let logPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-partial-res-test-"));
  checkpointDir = join(tmpDir, "checkpoint-content");
  workspaceDir = join(tmpDir, "workspace");
  backupDir = join(tmpDir, "backups");
  logPath = join(tmpDir, "partial-resurrection-log.jsonl");
  await mkdir(checkpointDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write a file into the checkpoint content directory. */
async function writeCheckpointFile(relPath: string, content: string): Promise<void> {
  const fullPath = join(checkpointDir, relPath);
  await mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/** Write a file into the workspace directory. */
async function writeWorkspaceFile(relPath: string, content: string): Promise<void> {
  const fullPath = join(workspaceDir, relPath);
  await mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

/** Read file from workspace. */
async function readWorkspaceFile(relPath: string): Promise<string> {
  return readFile(join(workspaceDir, relPath), "utf-8");
}

/** Check if file exists. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function makeLogger(): PluginLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info(msg: string) { messages.push(`INFO: ${msg}`); },
    warn(msg: string) { messages.push(`WARN: ${msg}`); },
    error(msg: string) { messages.push(`ERROR: ${msg}`); },
    debug(msg: string) { messages.push(`DEBUG: ${msg}`); },
  };
}

function makeConfig(): AmcpPluginConfig {
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
  };
}

// ---------------------------------------------------------------------------
// Pattern matching tests
// ---------------------------------------------------------------------------

describe("patternToRegex", () => {
  it("matches exact filename", () => {
    const re = patternToRegex("SOUL.md");
    expect(re.test("SOUL.md")).toBe(true);
    expect(re.test("MEMORY.md")).toBe(false);
  });

  it("matches single wildcard (* does not cross /)", () => {
    const re = patternToRegex("memory/*.md");
    expect(re.test("memory/daily.md")).toBe(true);
    expect(re.test("memory/notes.md")).toBe(true);
    expect(re.test("memory/sub/nested.md")).toBe(false);
    expect(re.test("SOUL.md")).toBe(false);
  });

  it("matches double wildcard (** crosses /)", () => {
    const re = patternToRegex("memory/**/*.md");
    expect(re.test("memory/daily.md")).toBe(true);
    expect(re.test("memory/sub/nested.md")).toBe(true);
    expect(re.test("memory/a/b/c.md")).toBe(true);
  });

  it("matches ? as single character", () => {
    const re = patternToRegex("file?.md");
    expect(re.test("file1.md")).toBe(true);
    expect(re.test("fileA.md")).toBe(true);
    expect(re.test("file12.md")).toBe(false);
  });

  it("escapes dots in pattern", () => {
    const re = patternToRegex("SOUL.md");
    expect(re.test("SOULXmd")).toBe(false); // dot should not match any char
  });
});

describe("matchesAnyPattern", () => {
  it("matches when any pattern matches", () => {
    expect(matchesAnyPattern("SOUL.md", ["SOUL.md", "memory/*.md"])).toBe(true);
    expect(matchesAnyPattern("memory/daily.md", ["SOUL.md", "memory/*.md"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchesAnyPattern("AGENTS.md", ["SOUL.md", "memory/*.md"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Partial restore tests
// ---------------------------------------------------------------------------

describe("partialRestore", () => {
  it("restores only files matching patterns", async () => {
    await writeCheckpointFile("SOUL.md", "soul content");
    await writeCheckpointFile("MEMORY.md", "memory content");
    await writeCheckpointFile("AGENTS.md", "agents content");

    const result = await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);
    expect(result.restored).toHaveLength(1);
    expect(result.restored[0].relativePath).toBe("SOUL.md");
    expect(result.skipped).toContain("MEMORY.md");
    expect(result.skipped).toContain("AGENTS.md");

    // Verify file was actually restored
    const content = await readWorkspaceFile("SOUL.md");
    expect(content).toBe("soul content");
  });

  it("preserves current state for non-restored files", async () => {
    // Pre-existing workspace files
    await writeWorkspaceFile("SOUL.md", "old soul");
    await writeWorkspaceFile("MEMORY.md", "current memory");
    await writeWorkspaceFile("AGENTS.md", "current agents");

    // Checkpoint has updated versions
    await writeCheckpointFile("SOUL.md", "new soul from checkpoint");
    await writeCheckpointFile("MEMORY.md", "checkpoint memory");
    await writeCheckpointFile("AGENTS.md", "checkpoint agents");

    const result = await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);

    // SOUL.md was restored
    expect(await readWorkspaceFile("SOUL.md")).toBe("new soul from checkpoint");

    // Other files preserved
    expect(await readWorkspaceFile("MEMORY.md")).toBe("current memory");
    expect(await readWorkspaceFile("AGENTS.md")).toBe("current agents");
  });

  it("backs up existing files before overwriting", async () => {
    await writeWorkspaceFile("SOUL.md", "original soul");
    await writeCheckpointFile("SOUL.md", "restored soul");

    const result = await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);
    expect(result.restored[0].hadPrevious).toBe(true);
    expect(result.restored[0].backupPath).toBeDefined();

    // Verify backup exists
    const backupExists = await fileExists(result.restored[0].backupPath!);
    expect(backupExists).toBe(true);

    // Verify backup content
    const backupContent = await readFile(result.restored[0].backupPath!, "utf-8");
    expect(backupContent).toBe("original soul");
  });

  it("marks hadPrevious false for new files", async () => {
    await writeCheckpointFile("SOUL.md", "soul content");

    const result = await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);
    expect(result.restored[0].hadPrevious).toBe(false);
    expect(result.restored[0].backupPath).toBeUndefined();
  });

  it("supports pattern matching for memory/*.md", async () => {
    await writeCheckpointFile("memory/daily-2025-01.md", "jan notes");
    await writeCheckpointFile("memory/daily-2025-02.md", "feb notes");
    await writeCheckpointFile("memory/ontology/graph.jsonl", "graph data");
    await writeCheckpointFile("SOUL.md", "soul");

    const result = await partialRestore({
      includePatterns: ["memory/*.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);
    expect(result.restored).toHaveLength(2);
    const restoredPaths = result.restored.map((r) => r.relativePath);
    expect(restoredPaths).toContain("memory/daily-2025-01.md");
    expect(restoredPaths).toContain("memory/daily-2025-02.md");
    expect(result.skipped).toContain("SOUL.md");
    expect(result.skipped).toContain("memory/ontology/graph.jsonl");
  });

  it("supports multiple patterns", async () => {
    await writeCheckpointFile("SOUL.md", "soul");
    await writeCheckpointFile("MEMORY.md", "memory");
    await writeCheckpointFile("memory/daily.md", "daily");
    await writeCheckpointFile("AGENTS.md", "agents");

    const result = await partialRestore({
      includePatterns: ["SOUL.md", "memory/*.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);
    expect(result.restored).toHaveLength(2);
    const restoredPaths = result.restored.map((r) => r.relativePath);
    expect(restoredPaths).toContain("SOUL.md");
    expect(restoredPaths).toContain("memory/daily.md");
    expect(result.skipped).toContain("MEMORY.md");
    expect(result.skipped).toContain("AGENTS.md");
  });

  it("writes audit log entry as JSONL", async () => {
    await writeCheckpointFile("SOUL.md", "soul");

    await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    const logContent = await readFile(logPath, "utf-8");
    const entry = JSON.parse(logContent.trim());
    expect(entry.patterns).toEqual(["SOUL.md"]);
    expect(entry.checkpointSource).toBe("bafkreitest123");
    expect(entry.restoredCount).toBe(1);
    expect(entry.restored).toEqual(["SOUL.md"]);
    expect(entry.timestamp).toBeDefined();
  });

  it("returns error when no patterns provided", async () => {
    const result = await partialRestore({
      includePatterns: [],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("no_patterns");
  });

  it("succeeds with no_matches when patterns match nothing", async () => {
    await writeCheckpointFile("SOUL.md", "soul");

    const result = await partialRestore({
      includePatterns: ["nonexistent/*.txt"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBe("no_matches");
    expect(result.restored).toHaveLength(0);
    expect(result.skipped).toContain("SOUL.md");
  });

  it("handles empty checkpoint directory", async () => {
    const result = await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("empty_checkpoint");
  });

  it("dry run does not copy files or write log", async () => {
    await writeCheckpointFile("SOUL.md", "soul content");

    const result = await partialRestore({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
      contentDir: workspaceDir,
      backupDir,
      logPath,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.restored).toHaveLength(1);

    // File should NOT exist in workspace
    expect(await fileExists(join(workspaceDir, "SOUL.md"))).toBe(false);

    // Log should NOT exist
    expect(await fileExists(logPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe("createPartialResurrectionService", () => {
  it("starts and stops cleanly", async () => {
    const logger = makeLogger();
    const events: string[] = [];
    const service = createPartialResurrectionService({
      config: makeConfig(),
      logger,
      emit: (event) => events.push(event),
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(service.name).toBe("amcp-partial-resurrection");
    await service.start();
    const status = await service.status();
    expect(status.running).toBe(true);
    await service.stop();
    const statusAfter = await service.status();
    expect(statusAfter.running).toBe(false);
  });

  it("restorePartial emits completion event", async () => {
    const logger = makeLogger();
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const service = createPartialResurrectionService({
      config: makeConfig(),
      logger,
      emit: (event, data) => events.push({ event, data }),
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    await writeCheckpointFile("SOUL.md", "soul");

    await service.start();
    const result = await service.restorePartial({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
    });

    expect(result.success).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("amcp:partial-resurrection:completed");
    expect(events[0].data?.restored).toBe(1);
  });

  it("emits error event on failure", async () => {
    const logger = makeLogger();
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const service = createPartialResurrectionService({
      config: makeConfig(),
      logger,
      emit: (event, data) => events.push({ event, data }),
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    await service.start();
    const result = await service.restorePartial({
      includePatterns: [],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
    });

    expect(result.success).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("amcp:partial-resurrection:error");
  });

  it("getLastResult returns last restore result", async () => {
    const logger = makeLogger();
    const service = createPartialResurrectionService({
      config: makeConfig(),
      logger,
      emit: () => {},
      contentDir: workspaceDir,
      backupDir,
      logPath,
    });

    expect(service.getLastResult()).toBeNull();

    await writeCheckpointFile("SOUL.md", "soul");
    await service.start();
    await service.restorePartial({
      includePatterns: ["SOUL.md"],
      checkpointContentDir: checkpointDir,
      checkpointSource: "bafkreitest123",
    });

    const last = service.getLastResult();
    expect(last).not.toBeNull();
    expect(last!.success).toBe(true);
    expect(last!.restored).toHaveLength(1);
  });
});
