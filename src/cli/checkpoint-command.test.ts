/**
 * Tests for 'openclaw amcp checkpoint' CLI command (P4-CLI-02).
 *
 * Verifies:
 * - Checkpoint execution delegates to full-checkpoint.sh
 * - Progress and CID are shown on completion
 * - --dry-run shows what would be included without creating
 * - JSON output mode
 * - Error handling when script is missing
 * - Output parsing (CID, secrets, size)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runCheckpoint,
  formatCheckpointResult,
  createCheckpointHandler,
} from "./checkpoint-command.js";
import type {
  CheckpointCommandDeps,
  CheckpointResult,
} from "./checkpoint-command.js";
import type { AmcpPluginConfig, PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;
let scriptDir: string;

function makeTempDir(): string {
  return join(
    tmpdir(),
    `amcp-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  overrides: Partial<CheckpointCommandDeps> = {},
): CheckpointCommandDeps {
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
 * Create a mock full-checkpoint.sh that simulates checkpoint output.
 */
async function createMockCheckpointScript(
  output: string,
  exitCode: number = 0,
): Promise<void> {
  const script = `#!/bin/bash
# Mock full-checkpoint.sh for testing
ARGS="$*"

# Check for --dry-run
for arg in "$@"; do
  case $arg in
    --dry-run)
      echo "=== STAGE 1: Extracting secrets ==="
      echo "Found 12 secrets across 3 sources"
      echo ""
      echo "=== STAGE 2: Preparing content ==="
      echo "Staging directory contents:"
      echo "1.2M workspace"
      echo ""
      echo "Total staging size: 1.5M"
      echo ""
      echo "=== DRY RUN COMPLETE ==="
      echo "Would checkpoint 12 secrets and 1.5M of content"
      exit 0
      ;;
  esac
done

${output}
exit ${exitCode}
`;
  const scriptPath = join(scriptDir, "full-checkpoint.sh");
  await writeFile(scriptPath, script, { mode: 0o755 });
}

/**
 * Create a mock that simulates a successful checkpoint with CID output.
 */
async function createSuccessScript(): Promise<void> {
  const output = `
echo "=== STAGE 1: Extracting secrets ==="
echo "Found 8 secrets across 2 sources"
echo ""
echo "=== STAGE 2: Preparing content ==="
echo "Total staging size: 2.1M"
echo ""
echo "=== STAGE 3: Creating encrypted checkpoint ==="
echo "Checkpoint created: /tmp/test-checkpoint.amcp (532K)"
echo ""
echo "=== STAGE 4: Pinning to IPFS (provider: solvr) ==="
echo "Uploading to Solvr..."
echo "  Solvr: bafkreitestcid123456789abcdefghijklmnop"
echo "Pinned to IPFS!"
echo "   CID: bafkreitestcid123456789abcdefghijklmnop"
echo ""
echo "=== STAGE 5: Cleanup ==="
echo ""
echo "=============================================="
echo "  FULL CHECKPOINT COMPLETE"
echo "=============================================="
echo "CID: bafkreitestcid123456789abcdefghijklmnop"
echo "Path: /tmp/test-checkpoint.amcp"
echo "Secrets: 8"
echo "Size: 532K"
echo "=============================================="
`;
  await createMockCheckpointScript(output, 0);
}

/**
 * Create a mock that simulates a failed checkpoint.
 */
async function createFailScript(): Promise<void> {
  const output = `
echo "=== STAGE 1: Extracting secrets ==="
echo "FATAL: Invalid AMCP identity" >&2
`;
  await createMockCheckpointScript(output, 1);
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
// Tests: checkpoint execution
// ---------------------------------------------------------------------------

describe("checkpoint: execution", () => {
  it("delegates to full-checkpoint.sh and reports success with CID", async () => {
    await createSuccessScript();

    // Also write a last-checkpoint.json that the handler reads after execution
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        cid: "bafkreitestcid123456789abcdefghijklmnop",
        localPath: "/tmp/test-checkpoint.amcp",
        secretCount: 8,
        checkpointSize: "532K",
        type: "full",
        pinningProvider: "solvr",
      }),
    );

    const deps = makeDeps();
    const result = await runCheckpoint(deps);

    expect(result.success).toBe(true);
    expect(result.cid).toBe("bafkreitestcid123456789abcdefghijklmnop");
    expect(result.dryRun).toBe(false);
    expect(result.error).toBeNull();
  });

  it("parses secret count from output", async () => {
    await createSuccessScript();

    const deps = makeDeps();
    const result = await runCheckpoint(deps);

    expect(result.success).toBe(true);
    // Either from last-checkpoint.json or parsed from output
    expect(result.secretCount).toBe(8);
  });

  it("reports failure when script exits non-zero", async () => {
    await createFailScript();

    const deps = makeDeps();
    const result = await runCheckpoint(deps);

    expect(result.success).toBe(false);
    expect(result.cid).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("reports error when script is missing", async () => {
    // Don't create the script — scriptDir exists but no full-checkpoint.sh
    const deps = makeDeps();
    const result = await runCheckpoint(deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Tests: dry-run mode
// ---------------------------------------------------------------------------

describe("checkpoint: dry-run", () => {
  it("shows what would be included without creating checkpoint", async () => {
    await createMockCheckpointScript("", 0);

    const deps = makeDeps();
    const result = await runCheckpoint(deps, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.cid).toBeNull();
    expect(result.secretCount).toBe(12);
    expect(result.output).toContain("DRY RUN COMPLETE");
  });

  it("parses content size from dry-run output", async () => {
    await createMockCheckpointScript("", 0);

    const deps = makeDeps();
    const result = await runCheckpoint(deps, { dryRun: true });

    expect(result.size).toBe("1.5M");
  });
});

// ---------------------------------------------------------------------------
// Tests: flag passthrough
// ---------------------------------------------------------------------------

describe("checkpoint: flags", () => {
  it("passes --force flag to script", async () => {
    const scriptPath = join(scriptDir, "full-checkpoint.sh");
    await writeFile(
      scriptPath,
      `#!/bin/bash
for arg in "$@"; do
  echo "ARG: $arg"
done
echo "CID: bafkreitest"
echo "Path: /tmp/test.amcp"
echo "Secrets: 0"
echo "Size: 1K"
`,
      { mode: 0o755 },
    );

    const deps = makeDeps();
    const result = await runCheckpoint(deps, { force: true });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --force");
  });

  it("passes --smart flag to script", async () => {
    const scriptPath = join(scriptDir, "full-checkpoint.sh");
    await writeFile(
      scriptPath,
      `#!/bin/bash
for arg in "$@"; do
  echo "ARG: $arg"
done
echo "CID: bafkreitest"
echo "Path: /tmp/test.amcp"
echo "Secrets: 0"
echo "Size: 1K"
`,
      { mode: 0o755 },
    );

    const deps = makeDeps();
    const result = await runCheckpoint(deps, { smart: true });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --smart");
  });

  it("passes --skip-evolution flag to script", async () => {
    const scriptPath = join(scriptDir, "full-checkpoint.sh");
    await writeFile(
      scriptPath,
      `#!/bin/bash
for arg in "$@"; do
  echo "ARG: $arg"
done
echo "CID: bafkreitest"
echo "Path: /tmp/test.amcp"
echo "Secrets: 0"
echo "Size: 1K"
`,
      { mode: 0o755 },
    );

    const deps = makeDeps();
    const result = await runCheckpoint(deps, { skipEvolution: true });

    expect(result.success).toBe(true);
    expect(result.output).toContain("ARG: --skip-evolution");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatCheckpointResult
// ---------------------------------------------------------------------------

describe("checkpoint: formatCheckpointResult", () => {
  it("formats successful checkpoint with CID", () => {
    const result: CheckpointResult = {
      success: true,
      cid: "bafkreitestcid123456789abcdefghijklmnop",
      localPath: "/tmp/test.amcp",
      secretCount: 8,
      size: "532K",
      dryRun: false,
      output: "",
      error: null,
    };

    const output = formatCheckpointResult(result);

    expect(output).toContain("=== Checkpoint Complete ===");
    expect(output).toContain("bafkreitestcid123456789abcdefghijklmnop");
    expect(output).toContain("/tmp/test.amcp");
    expect(output).toContain("8");
    expect(output).toContain("532K");
  });

  it("formats dry-run result", () => {
    const result: CheckpointResult = {
      success: true,
      cid: null,
      localPath: null,
      secretCount: 12,
      size: "1.5M",
      dryRun: true,
      output: "",
      error: null,
    };

    const output = formatCheckpointResult(result);

    expect(output).toContain("=== Checkpoint Dry Run ===");
    expect(output).toContain("12");
    expect(output).toContain("1.5M");
    expect(output).toContain("No checkpoint was created");
  });

  it("formats failed checkpoint", () => {
    const result: CheckpointResult = {
      success: false,
      cid: null,
      localPath: null,
      secretCount: null,
      size: null,
      dryRun: false,
      output: "",
      error: "Invalid AMCP identity",
    };

    const output = formatCheckpointResult(result);

    expect(output).toContain("=== Checkpoint Failed ===");
    expect(output).toContain("Invalid AMCP identity");
  });

  it("handles local-only checkpoint (no CID)", () => {
    const result: CheckpointResult = {
      success: true,
      cid: null,
      localPath: "/tmp/test.amcp",
      secretCount: 5,
      size: "200K",
      dryRun: false,
      output: "",
      error: null,
    };

    const output = formatCheckpointResult(result);

    expect(output).toContain("=== Checkpoint Complete ===");
    expect(output).toContain("local only");
  });
});

// ---------------------------------------------------------------------------
// Tests: createCheckpointHandler (JSON mode)
// ---------------------------------------------------------------------------

describe("checkpoint: handler", () => {
  it("outputs JSON when --json flag is passed", async () => {
    await createSuccessScript();
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        cid: "bafkreitestcid123456789abcdefghijklmnop",
        secretCount: 8,
        checkpointSize: "532K",
      }),
    );

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createCheckpointHandler(deps);

    await handler(["--json"]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.success).toBe(true);
    expect(parsed.cid).toBe("bafkreitestcid123456789abcdefghijklmnop");
  });

  it("outputs human-readable text by default", async () => {
    await createSuccessScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createCheckpointHandler(deps);

    await handler([]);

    const output = logs.join("\n");
    expect(output).toContain("Checkpoint Complete");
  });

  it("handles --dry-run via handler", async () => {
    await createMockCheckpointScript("", 0);

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createCheckpointHandler(deps);

    await handler(["--dry-run"]);

    const output = logs.join("\n");
    expect(output).toContain("Dry Run");
    expect(output).toContain("No checkpoint was created");
  });

  it("logs progress message on start", async () => {
    await createSuccessScript();

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createCheckpointHandler(deps);

    await handler([]);

    expect(logs[0]).toContain("amcp checkpoint: creating");
  });

  it("logs dry-run progress message on start", async () => {
    await createMockCheckpointScript("", 0);

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createCheckpointHandler(deps);

    await handler(["--dry-run"]);

    expect(logs[0]).toContain("dry-run");
  });
});

// ---------------------------------------------------------------------------
// Tests: last-checkpoint.json reading
// ---------------------------------------------------------------------------

describe("checkpoint: last-checkpoint.json", () => {
  it("prefers CID from last-checkpoint.json over parsed output", async () => {
    await createSuccessScript();

    // Write a last-checkpoint.json with a specific CID
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        cid: "bafkreifromlastcheckpointjson",
        secretCount: 42,
        checkpointSize: "1.2M",
        localPath: "/specific/path.amcp",
      }),
    );

    const deps = makeDeps();
    const result = await runCheckpoint(deps);

    expect(result.success).toBe(true);
    expect(result.cid).toBe("bafkreifromlastcheckpointjson");
    expect(result.secretCount).toBe(42);
    expect(result.size).toBe("1.2M");
    expect(result.localPath).toBe("/specific/path.amcp");
  });

  it("falls back to pinataCid in last-checkpoint.json", async () => {
    await createSuccessScript();

    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({
        pinataCid: "QmPinataCidExample",
        secretCount: 5,
      }),
    );

    const deps = makeDeps();
    const result = await runCheckpoint(deps);

    expect(result.success).toBe(true);
    expect(result.cid).toBe("QmPinataCidExample");
  });
});
