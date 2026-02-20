/**
 * Tests for 'openclaw amcp resurrect' CLI command (P4-CLI-03).
 *
 * Verifies:
 * - Resurrection execution delegates to resuscitate.sh
 * - Optional CID argument (default: latest from last-checkpoint.json)
 * - IPFS fetch and workspace restore
 * - Recovery prompt injection
 * - JSON output mode
 * - Error handling when script is missing
 * - Output parsing (tier, files restored, secrets injected)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runResurrect,
  formatResurrectResult,
  buildRecoveryPrompt,
  createResurrectHandler,
} from "./resurrect-command.js";
import type {
  ResurrectCommandDeps,
  ResurrectResult,
} from "./resurrect-command.js";
import type { AmcpPluginConfig, PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;
let scriptDir: string;

function makeTempDir(): string {
  return join(
    tmpdir(),
    `amcp-resurrect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  overrides: Partial<ResurrectCommandDeps> = {},
): ResurrectCommandDeps {
  const { logger } = makeLogger();
  return {
    logger,
    config: makeConfig(),
    lastCheckpointPath: join(testDir, "last-checkpoint.json"),
    scriptDir,
    ...overrides,
  };
}

/**
 * Create a mock resuscitate.sh that simulates resurrection output.
 */
async function createMockResurrectScript(
  output: string,
  exitCode: number = 0,
): Promise<void> {
  const script = `#!/bin/bash
# Mock resuscitate.sh for testing
${output}
exit ${exitCode}
`;
  const scriptPath = join(scriptDir, "resuscitate.sh");
  await writeFile(scriptPath, script, { mode: 0o755 });
}

/**
 * Create a mock that simulates a successful Tier 3 resurrection.
 */
async function createSuccessScript(): Promise<void> {
  const output = `
echo "=== TIER 1: Restart gateway ==="
echo "Gateway not responding, escalating..."
echo ""
echo "=== TIER 2: Restore config backup ==="
echo "Config backup not found, escalating..."
echo ""
echo "=== TIER 3: Full rehydrate from IPFS ==="
echo "Fetching checkpoint: bafkreitestresurrect123456789abcdef"
echo "Decrypting checkpoint..."
echo "Restoring workspace..."
echo "Restored 42 files to workspace"
echo "Running inject-secrets.sh..."
echo "Injected 8 secrets into config"
echo ""
echo "=== RESURRECTION COMPLETE ==="
echo "CID: bafkreitestresurrect123456789abcdef"
echo "Tier: 3"
`;
  await createMockResurrectScript(output, 0);
}

/**
 * Create a mock that simulates a Tier 1 (restart-only) success.
 */
async function createTier1SuccessScript(): Promise<void> {
  const output = `
echo "=== TIER 1: Restart gateway ==="
echo "Gateway restarted successfully"
echo "=== RESURRECTION COMPLETE ==="
`;
  await createMockResurrectScript(output, 0);
}

/**
 * Create a mock that simulates a failed resurrection.
 */
async function createFailScript(): Promise<void> {
  const output = `
echo "=== TIER 1: Restart gateway ==="
echo "Gateway not responding, escalating..."
echo ""
echo "=== TIER 2: Restore config backup ==="
echo "Config backup not found, escalating..."
echo ""
echo "=== TIER 3: Full rehydrate from IPFS ==="
echo "FATAL: Cannot fetch checkpoint from any gateway" >&2
`;
  await createMockResurrectScript(output, 1);
}

/**
 * Create a mock that echoes the CID argument it receives.
 */
async function createArgEchoScript(): Promise<void> {
  const script = `#!/bin/bash
# Echo arguments for testing
for arg in "$@"; do
  echo "ARG: $arg"
done
echo "=== RESURRECTION COMPLETE ==="
echo "Restored 10 files to workspace"
echo "Injected 3 secrets into config"
echo "Tier 1"
`;
  const scriptPath = join(scriptDir, "resuscitate.sh");
  await writeFile(scriptPath, script, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = makeTempDir();
  scriptDir = join(testDir, "scripts");
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: resurrection execution
// ---------------------------------------------------------------------------

describe("resurrect: execution", () => {
  it("delegates to resuscitate.sh and reports success", async () => {
    await createSuccessScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitestresurrect123456789abcdef",
    });

    expect(result.success).toBe(true);
    expect(result.cid).toBe("bafkreitestresurrect123456789abcdef");
    expect(result.error).toBeNull();
  });

  it("parses recovery tier from output", async () => {
    await createSuccessScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitestresurrect123456789abcdef",
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe(3);
  });

  it("parses files restored count from output", async () => {
    await createSuccessScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitestresurrect123456789abcdef",
    });

    expect(result.filesRestored).toBe(42);
  });

  it("parses secrets injected count from output", async () => {
    await createSuccessScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitestresurrect123456789abcdef",
    });

    expect(result.secretsInjected).toBe(8);
  });

  it("handles Tier 1 success (no IPFS fetch)", async () => {
    await createTier1SuccessScript();

    const deps = makeDeps();
    const result = await runResurrect(deps);

    expect(result.success).toBe(true);
    expect(result.tier).toBe(1);
  });

  it("reports failure when script exits non-zero", async () => {
    await createFailScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreifailedcid",
    });

    expect(result.success).toBe(false);
    expect(result.cid).toBe("bafkreifailedcid");
    expect(result.error).toBeTruthy();
    expect(result.tier).toBe(3);
  });

  it("reports error when script is missing", async () => {
    // Don't create the script — scriptDir exists but no resuscitate.sh
    const deps = makeDeps();
    const result = await runResurrect(deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Tests: CID resolution
// ---------------------------------------------------------------------------

describe("resurrect: CID resolution", () => {
  it("uses explicit CID when provided", async () => {
    await createArgEchoScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreiexplicitcid",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --from-cid");
    expect(result.output).toContain("ARG: bafkreiexplicitcid");
  });

  it("reads latest CID from last-checkpoint.json when no CID given", async () => {
    await createArgEchoScript();

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        cid: "bafkreifromlastcheckpoint",
        timestamp: "2025-06-01T12:00:00Z",
      }),
    );

    const deps = makeDeps();
    const result = await runResurrect(deps);

    expect(result.success).toBe(true);
    expect(result.cid).toBe("bafkreifromlastcheckpoint");
    expect(result.output).toContain("ARG: --from-cid");
    expect(result.output).toContain("ARG: bafkreifromlastcheckpoint");
  });

  it("falls back to pinataCid in last-checkpoint.json", async () => {
    await createArgEchoScript();

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        pinataCid: "QmPinataCidFallback",
      }),
    );

    const deps = makeDeps();
    const result = await runResurrect(deps);

    expect(result.success).toBe(true);
    expect(result.cid).toBe("QmPinataCidFallback");
  });

  it("runs without CID when no checkpoint available", async () => {
    await createTier1SuccessScript();

    const deps = makeDeps();
    const result = await runResurrect(deps);

    // Should still succeed (Tier 1 doesn't need CID)
    expect(result.success).toBe(true);
    expect(result.cid).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: flag passthrough
// ---------------------------------------------------------------------------

describe("resurrect: flags", () => {
  it("passes --gateway flag to script", async () => {
    await createArgEchoScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitest",
      gateway: "pinata",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --gateway");
    expect(result.output).toContain("ARG: pinata");
  });

  it("passes --content-dir flag to script", async () => {
    await createArgEchoScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitest",
      contentDir: "/custom/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --content-dir");
    expect(result.output).toContain("ARG: /custom/workspace");
  });

  it("passes --agent-name flag to script", async () => {
    await createArgEchoScript();

    const deps = makeDeps();
    const result = await runResurrect(deps, {
      fromCid: "bafkreitest",
      agentName: "test-agent",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --agent-name");
    expect(result.output).toContain("ARG: test-agent");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatResurrectResult
// ---------------------------------------------------------------------------

describe("resurrect: formatResurrectResult", () => {
  it("formats successful full resurrection", () => {
    const result: ResurrectResult = {
      success: true,
      cid: "bafkreitestcid123456789abcdefghijklmnop",
      tier: 3,
      filesRestored: 42,
      secretsInjected: 8,
      output: "",
      error: null,
    };

    const output = formatResurrectResult(result);

    expect(output).toContain("=== Resurrection Complete ===");
    expect(output).toContain("bafkreitestcid123456789abcdefghijklmnop");
    expect(output).toContain("3");
    expect(output).toContain("42");
    expect(output).toContain("8");
  });

  it("formats Tier 1 success (no CID or files)", () => {
    const result: ResurrectResult = {
      success: true,
      cid: null,
      tier: 1,
      filesRestored: null,
      secretsInjected: null,
      output: "",
      error: null,
    };

    const output = formatResurrectResult(result);

    expect(output).toContain("=== Resurrection Complete ===");
    expect(output).toContain("1");
  });

  it("formats local-only recovery (no tier/cid/files)", () => {
    const result: ResurrectResult = {
      success: true,
      cid: null,
      tier: null,
      filesRestored: null,
      secretsInjected: null,
      output: "",
      error: null,
    };

    const output = formatResurrectResult(result);

    expect(output).toContain("=== Resurrection Complete ===");
    expect(output).toContain("local tier");
  });

  it("formats failed resurrection with error and tier", () => {
    const result: ResurrectResult = {
      success: false,
      cid: "bafkreifailed",
      tier: 3,
      filesRestored: null,
      secretsInjected: null,
      output: "",
      error: "Cannot fetch checkpoint from any gateway",
    };

    const output = formatResurrectResult(result);

    expect(output).toContain("=== Resurrection Failed ===");
    expect(output).toContain("Cannot fetch checkpoint from any gateway");
    expect(output).toContain("Last tier attempted: 3");
    expect(output).toContain("bafkreifailed");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildRecoveryPrompt
// ---------------------------------------------------------------------------

describe("resurrect: buildRecoveryPrompt", () => {
  it("builds recovery prompt for successful resurrection", () => {
    const result: ResurrectResult = {
      success: true,
      cid: "bafkreitestcid",
      tier: 3,
      filesRestored: 42,
      secretsInjected: 8,
      output: "",
      error: null,
    };

    const prompt = buildRecoveryPrompt(result);

    expect(prompt).not.toBeNull();
    expect(prompt).toContain("resurrected");
    expect(prompt).toContain("bafkreitestcid");
    expect(prompt).toContain("42 files");
    expect(prompt).toContain("8 secrets");
    expect(prompt).toContain("SOUL.md");
  });

  it("returns null for failed resurrection", () => {
    const result: ResurrectResult = {
      success: false,
      cid: null,
      tier: null,
      filesRestored: null,
      secretsInjected: null,
      output: "",
      error: "failed",
    };

    const prompt = buildRecoveryPrompt(result);
    expect(prompt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: createResurrectHandler
// ---------------------------------------------------------------------------

describe("resurrect: handler", () => {
  it("outputs JSON when --json flag is passed", async () => {
    await createSuccessScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createResurrectHandler(deps);

    await handler(["--from-cid", "bafkreitest", "--json"]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.success).toBe(true);
  });

  it("outputs human-readable text by default", async () => {
    await createSuccessScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createResurrectHandler(deps);

    await handler(["--from-cid", "bafkreitest"]);

    const output = logs.join("\n");
    expect(output).toContain("Resurrection Complete");
  });

  it("logs progress message on start with CID", async () => {
    await createSuccessScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createResurrectHandler(deps);

    await handler(["--from-cid", "bafkreiexplicit"]);

    expect(logs[0]).toContain("amcp resurrect: restoring from bafkreiexplicit");
  });

  it("logs 'latest' when no CID provided", async () => {
    await createTier1SuccessScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createResurrectHandler(deps);

    await handler([]);

    expect(logs[0]).toContain("restoring from latest");
  });

  it("passes --gateway through to execution", async () => {
    await createArgEchoScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createResurrectHandler(deps);

    await handler(["--from-cid", "bafkreitest", "--gateway", "solvr", "--json"]);

    // In JSON mode, the full result including output is logged
    const jsonLog = logs.find((l) => l.includes('"success"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toContain("ARG: --gateway");
    expect(parsed.output).toContain("ARG: solvr");
  });
});
