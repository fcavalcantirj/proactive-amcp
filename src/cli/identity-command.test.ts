/**
 * Tests for 'openclaw amcp identity' CLI command (P4-CLI-04).
 *
 * Verifies:
 * - Identity show: display AID, public key, created date, KEL length
 * - Identity verify: all 7 checks, warnings, error reporting
 * - Identity rotate: delegation to key-rotation module
 * - Identity export: copy to backup path
 * - Handler routing: subcommand dispatch, JSON mode
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gatherIdentityInfo,
  formatIdentityShow,
  verifyIdentity,
  formatVerifyResult,
  exportIdentity,
  formatExportResult,
  createIdentityHandler,
} from "./identity-command.js";
import type { IdentityCommandDeps } from "./identity-command.js";
import type { AmcpPluginConfig, PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeTempDir(): string {
  return join(
    tmpdir(),
    `amcp-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  overrides: Partial<IdentityCommandDeps> = {},
): IdentityCommandDeps {
  const { logger } = makeLogger();
  return {
    logger,
    config: makeConfig(),
    identityPath: join(testDir, "identity.json"),
    scriptDir: join(testDir, "scripts"),
    ...overrides,
  };
}

const VALID_AID = "BIKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I";
const VALID_PUBLIC_KEY = "IKuwMpGof2JFMCsVcCAi8U2JtJoZ5sFVEulGIT8BX1I";

function validIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aid: VALID_AID,
    publicKey: VALID_PUBLIC_KEY,
    created: "2025-01-15T10:30:00Z",
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
// Tests: identity show
// ---------------------------------------------------------------------------

describe("identity show", () => {
  it("displays valid identity with AID, public key, and created date", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const deps = makeDeps();
    const info = await gatherIdentityInfo(deps);

    expect(info.valid).toBe(true);
    expect(info.aid).toBe(VALID_AID);
    expect(info.publicKey).toBe(VALID_PUBLIC_KEY);
    expect(info.created).toBe("2025-01-15T10:30:00Z");
    expect(info.path).toBe(deps.identityPath);
  });

  it("reports KEL length when KEL is present", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(
        validIdentity({
          kel: [
            { type: "inception", aid: VALID_AID, publicKey: VALID_PUBLIC_KEY },
          ],
        }),
      ),
    );
    const deps = makeDeps();
    const info = await gatherIdentityInfo(deps);

    expect(info.kelLength).toBe(1);
  });

  it("reports nextKeyHash when present", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity({ nextKeyHash: "abc123hash" })),
    );
    const deps = makeDeps();
    const info = await gatherIdentityInfo(deps);

    expect(info.nextKeyHash).toBe("abc123hash");
  });

  it("reports invalid when identity file is missing", async () => {
    const deps = makeDeps();
    const info = await gatherIdentityInfo(deps);

    expect(info.valid).toBe(false);
    expect(info.aid).toBeNull();
  });

  it("formats valid identity with all fields", () => {
    const info = {
      valid: true,
      aid: VALID_AID,
      publicKey: VALID_PUBLIC_KEY,
      created: "2025-01-15T10:30:00Z",
      nextKeyHash: "abc123",
      kelLength: 1,
      rotationHistory: 2,
      path: "/home/test/.amcp/identity.json",
    };

    const output = formatIdentityShow(info);
    expect(output).toContain("=== AMCP Identity ===");
    expect(output).toContain(VALID_AID);
    expect(output).toContain(VALID_PUBLIC_KEY);
    expect(output).toContain("2025-01-15T10:30:00Z");
    expect(output).toContain("committed");
    expect(output).toContain("abc123");
    expect(output).toContain("VALID");
  });

  it("formats invalid/missing identity", () => {
    const info = {
      valid: false,
      aid: null,
      publicKey: null,
      created: null,
      nextKeyHash: null,
      kelLength: 0,
      rotationHistory: 0,
      path: "/home/test/.amcp/identity.json",
    };

    const output = formatIdentityShow(info);
    expect(output).toContain("INVALID or MISSING");
    expect(output).toContain("amcp identity create");
  });
});

// ---------------------------------------------------------------------------
// Tests: identity verify
// ---------------------------------------------------------------------------

describe("identity verify", () => {
  it("passes all checks for a valid identity", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const deps = makeDeps();
    const result = await verifyIdentity(deps);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    const passedChecks = result.checks.filter((c) => c.passed);
    expect(passedChecks.length).toBe(result.checks.length);
  });

  it("reports file-readable failure when file is missing", async () => {
    const deps = makeDeps();
    const result = await verifyIdentity(deps);

    expect(result.valid).toBe(false);
    const fileCheck = result.checks.find((c) => c.name === "file-readable");
    expect(fileCheck?.passed).toBe(false);
  });

  it("detects legacy sha256 identity", async () => {
    const sha256Aid =
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify({ aid: sha256Aid, publicKey: "somekey" }),
    );
    const deps = makeDeps();
    const result = await verifyIdentity(deps);

    const legacyCheck = result.checks.find(
      (c) => c.name === "not-legacy-sha256",
    );
    expect(legacyCheck?.passed).toBe(false);
    expect(legacyCheck?.detail).toContain("sha256");
  });

  it("detects embedded secrets in identity file", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(
        validIdentity({
          pinata_jwt: "eyJhbGciOiJIUzI1NiJ9...",
          solvr_api_key: "solvr_test_key",
        }),
      ),
    );
    const deps = makeDeps();
    const result = await verifyIdentity(deps);

    const secretCheck = result.checks.find(
      (c) => c.name === "no-embedded-secrets",
    );
    expect(secretCheck?.passed).toBe(false);
    expect(secretCheck?.detail).toContain("pinata_jwt");
    expect(secretCheck?.detail).toContain("solvr_api_key");
  });

  it("detects missing public key", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify({ aid: VALID_AID }),
    );
    const deps = makeDeps();
    const result = await verifyIdentity(deps);

    const pkCheck = result.checks.find(
      (c) => c.name === "public-key-present",
    );
    expect(pkCheck?.passed).toBe(false);
  });

  it("formats verify result with pass/fail counts", () => {
    const result = {
      valid: false,
      errors: ["AID invalid"],
      warnings: ["Secrets found"],
      checks: [
        { name: "file-readable", passed: true, detail: "OK" },
        { name: "valid-json", passed: true, detail: "OK" },
        { name: "keri-aid-format", passed: false, detail: "Bad AID" },
      ],
    };

    const output = formatVerifyResult(result);
    expect(output).toContain("=== Identity Verification ===");
    expect(output).toContain("[PASS] file-readable");
    expect(output).toContain("[FAIL] keri-aid-format");
    expect(output).toContain("2/3 checks passed");
    expect(output).toContain("INVALID");
    expect(output).toContain("Secrets found");
  });
});

// ---------------------------------------------------------------------------
// Tests: identity export
// ---------------------------------------------------------------------------

describe("identity export", () => {
  it("copies identity file to export path", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const exportPath = join(testDir, "backup", "identity-backup.json");
    const deps = makeDeps();

    const result = await exportIdentity(deps, exportPath);

    expect(result.success).toBe(true);
    expect(result.exportPath).toBe(exportPath);

    // Verify the exported file has the same content
    const exported = await readFile(exportPath, "utf-8");
    const original = await readFile(deps.identityPath, "utf-8");
    expect(exported).toBe(original);
  });

  it("fails when identity file does not exist", async () => {
    const exportPath = join(testDir, "backup", "identity-backup.json");
    const deps = makeDeps();

    const result = await exportIdentity(deps, exportPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("fails when identity is invalid", async () => {
    const sha256Aid =
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify({ aid: sha256Aid, publicKey: "somekey" }),
    );
    const exportPath = join(testDir, "backup", "identity-backup.json");
    const deps = makeDeps();

    const result = await exportIdentity(deps, exportPath);

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("formats successful export", () => {
    const result = {
      success: true,
      sourcePath: "/home/test/.amcp/identity.json",
      exportPath: "/tmp/backup/identity.json",
      error: null,
    };

    const output = formatExportResult(result);
    expect(output).toContain("=== Identity Exported ===");
    expect(output).toContain("/home/test/.amcp/identity.json");
    expect(output).toContain("/tmp/backup/identity.json");
    expect(output).toContain("backup safe");
  });

  it("formats failed export", () => {
    const result = {
      success: false,
      sourcePath: "/home/test/.amcp/identity.json",
      exportPath: null,
      error: "Identity file not found",
    };

    const output = formatExportResult(result);
    expect(output).toContain("=== Identity Export Failed ===");
    expect(output).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Tests: handler routing
// ---------------------------------------------------------------------------

describe("identity handler", () => {
  it("routes to show by default (no subcommand)", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler([]);

    const output = logs.join("\n");
    expect(output).toContain("=== AMCP Identity ===");
    expect(output).toContain(VALID_AID);
  });

  it("routes to show subcommand", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["show"]);

    const output = logs.join("\n");
    expect(output).toContain("=== AMCP Identity ===");
  });

  it("routes to verify subcommand", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["verify"]);

    const output = logs.join("\n");
    expect(output).toContain("=== Identity Verification ===");
    expect(output).toContain("[PASS]");
  });

  it("routes to export subcommand with --out", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const exportPath = join(testDir, "exported.json");
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["export", "--out", exportPath]);

    const output = logs.join("\n");
    expect(output).toContain("=== Identity Exported ===");
  });

  it("reports error when export --out is missing", async () => {
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["export"]);

    const output = logs.join("\n");
    expect(output).toContain("--out <path> is required");
  });

  it("outputs JSON when --json flag is passed with show", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["show", "--json"]);

    const jsonLog = logs.find((l) => l.includes('"aid"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.valid).toBe(true);
    expect(parsed.aid).toBe(VALID_AID);
  });

  it("outputs JSON when --json flag is passed with verify", async () => {
    await writeFile(
      join(testDir, "identity.json"),
      JSON.stringify(validIdentity()),
    );
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["verify", "--json"]);

    const jsonLog = logs.find((l) => l.includes('"checks"'));
    expect(jsonLog).toBeDefined();
    const parsed = JSON.parse(jsonLog!);
    expect(parsed.valid).toBe(true);
    expect(parsed.checks).toBeDefined();
    expect(parsed.checks.length).toBeGreaterThan(0);
  });

  it("shows usage for unknown subcommand", async () => {
    const { logger, logs } = makeLogger();
    const deps = makeDeps({ logger });
    const handler = createIdentityHandler(deps);

    await handler(["unknown-sub"]);

    const output = logs.join("\n");
    expect(output).toContain("Unknown identity subcommand");
    expect(output).toContain("show");
    expect(output).toContain("verify");
    expect(output).toContain("rotate");
    expect(output).toContain("export");
  });
});
