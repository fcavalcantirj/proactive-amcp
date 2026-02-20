/**
 * Tests for 'openclaw amcp verify' CLI command (P4-CLI-06).
 *
 * Verifies:
 * - Reads checkpoint file and validates structure
 * - Computes SHA-256 hash of checkpoint content
 * - Detects signature presence
 * - Falls back to latest checkpoint from last-checkpoint.json
 * - Accepts CID or local path argument
 * - --json outputs machine-readable JSON
 * - Corrupt checkpoint detected and reported
 * - Missing files handled gracefully
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runVerify,
  formatVerifyResult,
  createVerifyHandler,
} from "./verify-command.js";
import type {
  VerifyCommandDeps,
  VerifyResult,
} from "./verify-command.js";
import type { AmcpPluginConfig, PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeTempDir(): string {
  return join(
    tmpdir(),
    `amcp-verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  overrides: Partial<VerifyCommandDeps> = {},
): VerifyCommandDeps {
  const { logger } = makeLogger();
  return {
    logger,
    config: makeConfig(),
    lastCheckpointPath: join(testDir, "last-checkpoint.json"),
    checkpointDir: join(testDir, "checkpoints"),
    scriptDir: join(testDir, "scripts"),
    ...overrides,
  };
}

/** Create a valid-looking checkpoint JSON file. */
function makeCheckpoint(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    aid: "Btest1234567890abcdefghijklmnopqrstuvwxyz_-AB",
    timestamp: "2025-01-20T10:30:00.000Z",
    protocolVersion: "0.2",
    soul: { name: "TestAgent", principles: ["test"] },
    content: { memory: { entries: [] } },
    encryptedSecrets: "encrypted_blob_base64_here",
    signature: "ed25519_sig_base64_here",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = makeTempDir();
  await mkdir(join(testDir, "checkpoints"), { recursive: true });
  await mkdir(join(testDir, "scripts"), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: local file verification
// ---------------------------------------------------------------------------

describe("verify: local file", () => {
  it("verifies a valid checkpoint file by path", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.success).toBe(true);
    expect(result.source).toBe("local");
    expect(result.checks.length).toBeGreaterThan(0);

    // file_readable should pass
    const readCheck = result.checks.find((c) => c.name === "file_readable");
    expect(readCheck?.passed).toBe(true);

    // valid_json should pass
    const jsonCheck = result.checks.find((c) => c.name === "valid_json");
    expect(jsonCheck?.passed).toBe(true);

    // has_content should pass
    const contentCheck = result.checks.find((c) => c.name === "has_content");
    expect(contentCheck?.passed).toBe(true);
  });

  it("reports error for nonexistent file", async () => {
    const deps = makeDeps();
    const result = await runVerify(deps, {
      target: join(testDir, "nonexistent.amcp"),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("detects checkpoint with no signature", async () => {
    const cpPath = join(testDir, "checkpoints", "unsigned.amcp");
    await writeFile(
      cpPath,
      makeCheckpoint({ signature: undefined }),
    );

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.success).toBe(true);
    const sigCheck = result.checks.find((c) => c.name === "signature_present");
    expect(sigCheck?.passed).toBe(false);
    expect(sigCheck?.detail).toContain("No signature");
  });

  it("detects checkpoint with signature present", async () => {
    const cpPath = join(testDir, "checkpoints", "signed.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    const sigCheck = result.checks.find((c) => c.name === "signature_present");
    expect(sigCheck?.passed).toBe(true);
    expect(sigCheck?.detail).toContain("Ed25519 signature present");
  });

  it("computes SHA-256 hash of checkpoint", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    const hashCheck = result.checks.find((c) => c.name === "hash_computed");
    expect(hashCheck?.passed).toBe(true);
    expect(hashCheck?.detail).toContain("SHA-256:");
  });

  it("detects AID in checkpoint", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    const aidCheck = result.checks.find((c) => c.name === "aid_present");
    expect(aidCheck?.passed).toBe(true);
    expect(aidCheck?.detail).toContain("Btest1234567890");
  });

  it("reports missing AID", async () => {
    const cpPath = join(testDir, "checkpoints", "no-aid.amcp");
    await writeFile(
      cpPath,
      makeCheckpoint({ aid: undefined, agentId: undefined }),
    );

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    const aidCheck = result.checks.find((c) => c.name === "aid_present");
    expect(aidCheck?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: corrupt checkpoint detection
// ---------------------------------------------------------------------------

describe("verify: corrupt checkpoint", () => {
  it("detects corrupt JSON (not valid JSON)", async () => {
    const cpPath = join(testDir, "checkpoints", "corrupt.amcp");
    await writeFile(cpPath, "this is not json at all {{{");

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.success).toBe(true);
    expect(result.intact).toBe(false);

    const jsonCheck = result.checks.find((c) => c.name === "valid_json");
    expect(jsonCheck?.passed).toBe(false);
    expect(jsonCheck?.detail).toContain("corrupt");
  });

  it("detects checkpoint with no content or soul", async () => {
    const cpPath = join(testDir, "checkpoints", "empty.amcp");
    await writeFile(
      cpPath,
      makeCheckpoint({
        soul: undefined,
        content: undefined,
      }),
    );

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    const contentCheck = result.checks.find((c) => c.name === "has_content");
    expect(contentCheck?.passed).toBe(false);
  });

  it("reports intact=false when checks fail", async () => {
    const cpPath = join(testDir, "checkpoints", "bad.amcp");
    await writeFile(cpPath, "not json");

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.intact).toBe(false);
    expect(result.passed).toBeLessThan(result.total);
  });

  it("detects empty file as corrupt", async () => {
    const cpPath = join(testDir, "checkpoints", "empty-file.amcp");
    await writeFile(cpPath, "");

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.intact).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: latest checkpoint fallback
// ---------------------------------------------------------------------------

describe("verify: latest checkpoint", () => {
  it("uses last-checkpoint.json localPath when no target given", async () => {
    const cpPath = join(testDir, "checkpoints", "latest.amcp");
    await writeFile(cpPath, makeCheckpoint());
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({ cid: "bafkreitestcid", localPath: cpPath }),
    );

    const deps = makeDeps();
    const result = await runVerify(deps);

    expect(result.success).toBe(true);
    expect(result.source).toBe("last-checkpoint");
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it("reports error when no checkpoint exists and no target given", async () => {
    // No last-checkpoint.json, no target
    const deps = makeDeps();
    const result = await runVerify(deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No checkpoint found");
  });

  it("handles stale localPath in last-checkpoint.json", async () => {
    // localPath points to non-existent file, no CID to fall back to
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({ localPath: "/tmp/does-not-exist.amcp" }),
    );

    const deps = makeDeps();
    const result = await runVerify(deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("No checkpoint found");
  });

  it("reads pinataCid from last-checkpoint.json with local file", async () => {
    // Create a local checkpoint file and reference it via pinataCid + localPath
    const cpPath = join(testDir, "checkpoints", "pinata.amcp");
    await writeFile(cpPath, makeCheckpoint());
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({ pinataCid: "QmTestPinataCid", localPath: cpPath }),
    );

    const deps = makeDeps();
    const result = await runVerify(deps);

    expect(result.success).toBe(true);
    expect(result.source).toBe("last-checkpoint");
    expect(result.checks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatVerifyResult
// ---------------------------------------------------------------------------

describe("verify: formatVerifyResult", () => {
  it("formats successful intact verification", () => {
    const result: VerifyResult = {
      success: true,
      target: "bafkreitestcid",
      source: "local",
      checks: [
        { name: "file_readable", passed: true, detail: "File readable (42KB)" },
        { name: "valid_json", passed: true, detail: "Valid JSON" },
        { name: "hash_computed", passed: true, detail: "SHA-256: abc123" },
      ],
      passed: 3,
      total: 3,
      intact: true,
      error: null,
    };

    const output = formatVerifyResult(result);

    expect(output).toContain("=== Checkpoint Verification ===");
    expect(output).toContain("INTACT");
    expect(output).toContain("[PASS]");
    expect(output).toContain("3/3 checks passed");
    expect(output).not.toContain("WARNING");
  });

  it("formats failed verification with warnings", () => {
    const result: VerifyResult = {
      success: true,
      target: "/path/to/corrupt.amcp",
      source: "local",
      checks: [
        { name: "file_readable", passed: true, detail: "File readable (10B)" },
        { name: "valid_json", passed: false, detail: "Not valid JSON" },
      ],
      passed: 1,
      total: 2,
      intact: false,
      error: null,
    };

    const output = formatVerifyResult(result);

    expect(output).toContain("ISSUES DETECTED");
    expect(output).toContain("[FAIL]");
    expect(output).toContain("1/2 checks passed");
    expect(output).toContain("WARNING");
    expect(output).toContain("corrupt");
  });

  it("formats error when verification couldn't run", () => {
    const result: VerifyResult = {
      success: false,
      target: "(none)",
      source: "unknown",
      checks: [],
      passed: 0,
      total: 0,
      intact: false,
      error: "No checkpoint found",
    };

    const output = formatVerifyResult(result);

    expect(output).toContain("Error: No checkpoint found");
  });

  it("shows target and source in output", () => {
    const result: VerifyResult = {
      success: true,
      target: "bafkreimycid",
      source: "ipfs (solvr)",
      checks: [
        { name: "file_readable", passed: true, detail: "OK" },
      ],
      passed: 1,
      total: 1,
      intact: true,
      error: null,
    };

    const output = formatVerifyResult(result);

    expect(output).toContain("Target: bafkreimycid");
    expect(output).toContain("Source: ipfs (solvr)");
  });
});

// ---------------------------------------------------------------------------
// Tests: createVerifyHandler
// ---------------------------------------------------------------------------

describe("verify: handler", () => {
  it("outputs JSON when --json flag is passed", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({ localPath: cpPath }),
    );

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createVerifyHandler(deps);

    await handler(["--json"]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.success).toBe(true);
    expect(parsed.checks).toBeDefined();
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it("outputs human-readable text by default", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());
    await writeFile(
      join(testDir, "last-checkpoint.json"),
      JSON.stringify({ localPath: cpPath }),
    );

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createVerifyHandler(deps);

    await handler([]);

    const output = logs.join("\n");
    expect(output).toContain("Checkpoint Verification");
    expect(output).toContain("[PASS]");
  });

  it("accepts positional CID-like argument with local match", async () => {
    // Create a checkpoint file that contains the CID in its metadata
    const cpPath = join(testDir, "checkpoints", "bycid.amcp");
    await writeFile(
      cpPath,
      JSON.stringify({
        cid: "bafkreitestcid123",
        aid: "Btest",
        soul: { name: "Test" },
        content: { memory: {} },
        signature: "sig123",
        encryptedSecrets: "enc123",
      }),
    );

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createVerifyHandler(deps);

    await handler(["bafkreitestcid123"]);

    const output = logs.join("\n");
    expect(output).toContain("bafkreitestcid123");
    expect(output).toContain("Checkpoint Verification");
  });

  it("accepts --checkpoint flag for local file", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createVerifyHandler(deps);

    await handler(["--checkpoint", cpPath]);

    const output = logs.join("\n");
    expect(output).toContain("Checkpoint Verification");
    expect(output).toContain("[PASS]");
  });

  it("reports all check names for a complete checkpoint", async () => {
    const cpPath = join(testDir, "checkpoints", "complete.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createVerifyHandler(deps);

    await handler(["--json", "--checkpoint", cpPath]);

    const jsonLog = logs.find((l) => l.includes('"success"'));
    const parsed = JSON.parse(jsonLog!);
    const checkNames = parsed.checks.map(
      (c: { name: string }) => c.name,
    );

    expect(checkNames).toContain("file_readable");
    expect(checkNames).toContain("valid_json");
    expect(checkNames).toContain("has_content");
    expect(checkNames).toContain("has_secrets");
    expect(checkNames).toContain("hash_computed");
    expect(checkNames).toContain("signature_present");
    expect(checkNames).toContain("aid_present");
  });
});

// ---------------------------------------------------------------------------
// Tests: P4-CLI-06 verification — corrupt checkpoint detected
// ---------------------------------------------------------------------------

describe("verify: P4-CLI-06 verification", () => {
  it("detects corrupt checkpoint and reports ISSUES DETECTED", async () => {
    const cpPath = join(testDir, "checkpoints", "corrupt.amcp");
    await writeFile(cpPath, "definitely not valid json {{{");

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.success).toBe(true);
    expect(result.intact).toBe(false);

    const formatted = formatVerifyResult(result);
    expect(formatted).toContain("ISSUES DETECTED");
    expect(formatted).toContain("[FAIL]");
  });

  it("confirms intact checkpoint passes all checks", async () => {
    const cpPath = join(testDir, "checkpoints", "good.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    // All non-signature-verify checks should pass
    // (signature_valid requires amcp CLI which isn't available in test)
    const checksWithoutSigVerify = result.checks.filter(
      (c) => c.name !== "signature_valid",
    );
    const allOthersPassed = checksWithoutSigVerify.every((c) => c.passed);
    expect(allOthersPassed).toBe(true);
  });

  it("reports integrity status with pass/total count", async () => {
    const cpPath = join(testDir, "checkpoints", "test.amcp");
    await writeFile(cpPath, makeCheckpoint());

    const deps = makeDeps();
    const result = await runVerify(deps, { target: cpPath });

    expect(result.passed).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
    expect(typeof result.intact).toBe("boolean");

    const formatted = formatVerifyResult(result);
    expect(formatted).toContain(`${result.passed}/${result.total} checks passed`);
  });
});
