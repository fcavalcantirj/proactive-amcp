/**
 * Tests for 'openclaw amcp status' CLI command (P4-CLI-01).
 *
 * Verifies:
 * - Identity display (name, prefix, created date)
 * - Last checkpoint display (CID, timestamp, size)
 * - Monitor status (context, memory, resurrection)
 * - Config summary
 * - JSON output mode
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gatherStatus,
  formatStatus,
  createStatusHandler,
} from "./status-command.js";
import type {
  StatusCommandDeps,
  AmcpStatus,
} from "./status-command.js";
import type {
  AmcpPluginConfig,
  PluginLogger,
  PluginService,
} from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeTempDir(): string {
  return join(tmpdir(), `amcp-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeConfig(overrides: Partial<AmcpPluginConfig> = {}): AmcpPluginConfig {
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

function makeService(name: string, running: boolean, details: Record<string, unknown> = {}): PluginService {
  return {
    name,
    async start() { /* no-op */ },
    async stop() { /* no-op */ },
    async status() {
      return { running, details: { service: name, ...details } };
    },
  };
}

function makeDeps(overrides: Partial<StatusCommandDeps> = {}): StatusCommandDeps {
  const { logger } = makeLogger();
  return {
    logger,
    config: makeConfig(),
    identityPath: join(testDir, "identity.json"),
    lastCheckpointPath: join(testDir, "last-checkpoint.json"),
    services: [
      makeService("amcp-context-monitor", true),
      makeService("amcp-memory-integrity", true),
      makeService("amcp-resurrection-detector", true),
    ],
    ...overrides,
  };
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
// Tests: identity display
// ---------------------------------------------------------------------------

describe("status: identity", () => {
  it("displays valid identity with AID and created date", async () => {
    const identity = {
      aid: "BIKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I",
      publicKey: "IKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I",
      created: "2025-01-15T10:30:00Z",
    };
    await writeFile(join(testDir, "identity.json"), JSON.stringify(identity));

    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.identity.valid).toBe(true);
    expect(status.identity.aid).toBe(identity.aid);
    expect(status.identity.created).toBe(identity.created);
  });

  it("reports invalid identity when file is missing", async () => {
    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.identity.valid).toBe(false);
    expect(status.identity.aid).toBeNull();
  });

  it("reports invalid identity for sha256 AID", async () => {
    const identity = {
      aid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      publicKey: "somekey",
    };
    await writeFile(join(testDir, "identity.json"), JSON.stringify(identity));

    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.identity.valid).toBe(false);
    expect(status.identity.aid).toBe(identity.aid);
  });
});

// ---------------------------------------------------------------------------
// Tests: last checkpoint display
// ---------------------------------------------------------------------------

describe("status: last checkpoint", () => {
  it("displays checkpoint with CID, timestamp, and size", async () => {
    const checkpoint = {
      cid: "bafkreiexamplecid123456789abcdefghijklmnopqrstuvwx",
      timestamp: "2025-06-01T12:00:00Z",
      size: 42000,
      pinningService: "solvr",
    };
    await writeFile(join(testDir, "last-checkpoint.json"), JSON.stringify(checkpoint));

    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.lastCheckpoint.available).toBe(true);
    expect(status.lastCheckpoint.cid).toBe(checkpoint.cid);
    expect(status.lastCheckpoint.timestamp).toBe(checkpoint.timestamp);
    expect(status.lastCheckpoint.size).toBe(checkpoint.size);
    expect(status.lastCheckpoint.pinningService).toBe("solvr");
  });

  it("reports no checkpoint when file is missing", async () => {
    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.lastCheckpoint.available).toBe(false);
    expect(status.lastCheckpoint.cid).toBeNull();
  });

  it("falls back to pinataCid when cid is missing", async () => {
    const checkpoint = {
      pinataCid: "QmExamplePinataCid123456789",
      timestamp: "2025-06-01T12:00:00Z",
    };
    await writeFile(join(testDir, "last-checkpoint.json"), JSON.stringify(checkpoint));

    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.lastCheckpoint.available).toBe(true);
    expect(status.lastCheckpoint.cid).toBe(checkpoint.pinataCid);
  });
});

// ---------------------------------------------------------------------------
// Tests: monitor status
// ---------------------------------------------------------------------------

describe("status: monitors", () => {
  it("displays running monitors", async () => {
    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.monitors.context).not.toBeNull();
    expect(status.monitors.context!.running).toBe(true);
    expect(status.monitors.memory).not.toBeNull();
    expect(status.monitors.memory!.running).toBe(true);
    expect(status.monitors.resurrection).not.toBeNull();
    expect(status.monitors.resurrection!.running).toBe(true);
  });

  it("reports null for missing services", async () => {
    const deps = makeDeps({ services: [] });
    const status = await gatherStatus(deps);

    expect(status.monitors.context).toBeNull();
    expect(status.monitors.memory).toBeNull();
    expect(status.monitors.resurrection).toBeNull();
  });

  it("reports stopped for non-running services", async () => {
    const deps = makeDeps({
      services: [
        makeService("amcp-context-monitor", false),
        makeService("amcp-memory-integrity", false),
        makeService("amcp-resurrection-detector", false),
      ],
    });
    const status = await gatherStatus(deps);

    expect(status.monitors.context!.running).toBe(false);
    expect(status.monitors.memory!.running).toBe(false);
    expect(status.monitors.resurrection!.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: config summary
// ---------------------------------------------------------------------------

describe("status: config summary", () => {
  it("includes all config fields", async () => {
    const deps = makeDeps();
    const status = await gatherStatus(deps);

    expect(status.config.autoCheckpoint).toBe(true);
    expect(status.config.contextThreshold).toBe(70);
    expect(status.config.ipfsPinningService).toBe("solvr");
    expect(status.config.checkpointIntervalMs).toBe(0);
    expect(status.config.checkpointCooldownMs).toBe(300_000);
    expect(status.config.memoryIntegrity).toBe(true);
    expect(status.config.autoRestore).toBe(false);
    expect(status.config.promptInjectionScan).toBe(true);
  });

  it("reflects custom config values", async () => {
    const deps = makeDeps({
      config: makeConfig({
        contextThreshold: 90,
        ipfsPinningService: "pinata",
        checkpointIntervalMs: 600_000,
      }),
    });
    const status = await gatherStatus(deps);

    expect(status.config.contextThreshold).toBe(90);
    expect(status.config.ipfsPinningService).toBe("pinata");
    expect(status.config.checkpointIntervalMs).toBe(600_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatStatus output
// ---------------------------------------------------------------------------

describe("status: formatStatus", () => {
  it("includes identity section with AID", () => {
    const status: AmcpStatus = {
      identity: {
        valid: true,
        aid: "BIKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I",
        publicKey: "IKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I",
        created: "2025-01-15T10:30:00Z",
      },
      lastCheckpoint: {
        available: true,
        cid: "bafkreiexamplecid",
        timestamp: "2025-06-01T12:00:00Z",
        size: 42000,
        pinningService: "solvr",
      },
      monitors: {
        context: { running: true, details: {} },
        memory: { running: true, details: {} },
        resurrection: { running: false, details: {} },
      },
      config: {
        autoCheckpoint: true,
        contextThreshold: 70,
        ipfsPinningService: "solvr",
        checkpointIntervalMs: 0,
        checkpointCooldownMs: 300_000,
        memoryIntegrity: true,
        autoRestore: false,
        promptInjectionScan: true,
      },
    };

    const output = formatStatus(status);

    // Identity
    expect(output).toContain("Identity:");
    expect(output).toContain("BIKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I");
    expect(output).toContain("VALID");
    expect(output).toContain("2025-01-15T10:30:00Z");

    // Checkpoint
    expect(output).toContain("Last Checkpoint:");
    expect(output).toContain("bafkreiexamplecid");
    expect(output).toContain("42000 bytes");
    expect(output).toContain("solvr");

    // Monitors
    expect(output).toContain("context: RUNNING");
    expect(output).toContain("memory: RUNNING");
    expect(output).toContain("resurrection: STOPPED");

    // Config
    expect(output).toContain("Auto-checkpoint:");
    expect(output).toContain("70%");
  });

  it("shows INVALID for missing identity", () => {
    const status: AmcpStatus = {
      identity: { valid: false, aid: null, publicKey: null, created: null },
      lastCheckpoint: { available: false, cid: null, timestamp: null, size: null, pinningService: null },
      monitors: { context: null, memory: null, resurrection: null },
      config: {
        autoCheckpoint: true,
        contextThreshold: 70,
        ipfsPinningService: "solvr",
        checkpointIntervalMs: 0,
        checkpointCooldownMs: 300_000,
        memoryIntegrity: true,
        autoRestore: false,
        promptInjectionScan: true,
      },
    };

    const output = formatStatus(status);
    expect(output).toContain("INVALID or MISSING");
    expect(output).toContain("No checkpoint found");
    expect(output).toContain("NOT REGISTERED");
  });
});

// ---------------------------------------------------------------------------
// Tests: createStatusHandler (JSON mode)
// ---------------------------------------------------------------------------

describe("status: handler", () => {
  it("outputs JSON when --json flag is passed", async () => {
    const identity = {
      aid: "BIKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I",
      publicKey: "IKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I",
      created: "2025-01-15T10:30:00Z",
    };
    await writeFile(join(testDir, "identity.json"), JSON.stringify(identity));

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createStatusHandler(deps);

    await handler(["--json"]);

    // Should have logged a JSON string
    const jsonLog = logs.find((l) => l.includes('"identity"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.identity.valid).toBe(true);
    expect(parsed.identity.aid).toBe(identity.aid);
  });

  it("outputs human-readable text by default", async () => {
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createStatusHandler(deps);

    await handler([]);

    const output = logs.join("\n");
    expect(output).toContain("=== AMCP Status ===");
    expect(output).toContain("Identity:");
  });
});
