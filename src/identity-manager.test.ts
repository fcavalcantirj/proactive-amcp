/**
 * Tests for identity-manager — verifies KERI identity loading, AID format
 * validation, KEL chain integrity checks, legacy identity rejection,
 * secret detection warnings, and service lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateIdentity,
  getIdentity,
  createIdentityService,
} from "./identity-manager.js";
import type { PluginLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Valid KERI-style identity for testing. */
function validIdentity(): Record<string, unknown> {
  return {
    aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    created: "2025-01-15T10:30:00Z",
    kel: [
      {
        type: "inception",
        aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
        publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
        timestamp: "2025-01-15T10:30:00Z",
      },
    ],
  };
}

/** sha256-style legacy identity (from openclaw-deploy). */
function legacyIdentity(): Record<string, unknown> {
  return {
    aid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    publicKey: "some-old-key",
    pinata_jwt: "eyJhbGciOiJIUzI1NiJ9.test.signature",
    solvr_api_key: "solvr_test_key",
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-identity-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateIdentity()
// ---------------------------------------------------------------------------

describe("validateIdentity", () => {
  it("validates a correct KERI identity", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentity()));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity?.aid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
    expect(result.identity?.publicKey).toBe(
      "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
    expect(result.errors).toEqual([]);
  });

  it("returns error for missing identity file", async () => {
    const result = await validateIdentity(join(tmpDir, "nonexistent.json"));

    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("not found or unreadable");
  });

  it("returns error for invalid JSON", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, "not valid json{{{");

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.errors[0]).toContain("not found or unreadable");
  });

  it("rejects AID without B prefix", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.aid = "XIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE";
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"B" prefix'))).toBe(true);
  });

  it("rejects AID that is too short", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.aid = "Bshort";
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("KERI format"))).toBe(true);
  });

  it("rejects sha256 hex AID (legacy openclaw-deploy)", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(legacyIdentity()));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sha256 hash"))).toBe(true);
    expect(
      result.errors.some((e) => e.includes("legacy identity")),
    ).toBe(true);
  });

  it("rejects missing AID field", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify({ publicKey: "test" }));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("AID is missing"))).toBe(true);
  });

  it("rejects missing publicKey field", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(
      idPath,
      JSON.stringify({
        aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
      }),
    );

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("publicKey is missing")),
    ).toBe(true);
  });

  it("warns about secrets in identity file", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = {
      ...validIdentity(),
      pinata_jwt: "eyJhbGciOiJIUzI1NiJ9.test",
      solvr_api_key: "solvr_test",
    };
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    // Identity itself is still valid — secrets are warnings, not errors
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(
      result.warnings.some((w) => w.includes("Secrets found")),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("pinata_jwt")),
    ).toBe(true);
  });

  it("accepts identity without KEL (newly created)", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    delete identity.kel;
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
  });

  it("accepts identity with empty KEL", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.kel = [];
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
  });

  it("rejects KEL with wrong inception type", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.kel = [{ type: "rotation", aid: identity.aid }];
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('must be type "inception"')),
    ).toBe(true);
  });

  it("rejects KEL with mismatched inception AID", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.kel = [
      {
        type: "inception",
        aid: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaaa",
        publicKey: "test",
      },
    ];
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("does not match identity AID")),
    ).toBe(true);
  });

  it("validates KEL with inception and rotation events", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.kel = [
      {
        type: "inception",
        aid: identity.aid,
        publicKey: identity.publicKey,
        nextKeyHash: "abc123hash",
        timestamp: "2025-01-15T10:30:00Z",
      },
      {
        type: "rotation",
        publicKey: "newKey12345678901234567890123456789012345",
        nextKeyHash: "def456hash",
        timestamp: "2025-02-01T12:00:00Z",
      },
    ];
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
    // Should have a warning about pre-rotation commitment needing CLI
    expect(
      result.warnings.some((w) => w.includes("pre-rotation commitment")),
    ).toBe(true);
  });

  it("rejects non-rotation events after inception", async () => {
    const idPath = join(tmpDir, "identity.json");
    const identity = validIdentity();
    identity.kel = [
      {
        type: "inception",
        aid: identity.aid,
      },
      {
        type: "inception",
        aid: identity.aid,
      },
    ];
    await writeFile(idPath, JSON.stringify(identity));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes('must be type "rotation"')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getIdentity()
// ---------------------------------------------------------------------------

describe("getIdentity", () => {
  it("returns identity for valid file", async () => {
    const logger = makeLogger();
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentity()));

    const identity = await getIdentity(logger, idPath);

    expect(identity).not.toBeNull();
    expect(identity?.aid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
    expect(logger.messages.error).toHaveLength(0);
  });

  it("returns null and logs errors for invalid file", async () => {
    const logger = makeLogger();
    const idPath = join(tmpDir, "nonexistent.json");

    const identity = await getIdentity(logger, idPath);

    expect(identity).toBeNull();
    expect(logger.messages.error.length).toBeGreaterThan(0);
    expect(
      logger.messages.error.some((e) => e.includes("not found")),
    ).toBe(true);
  });

  it("logs warnings for secrets in identity file", async () => {
    const logger = makeLogger();
    const idPath = join(tmpDir, "identity.json");
    const identity = {
      ...validIdentity(),
      pinata_jwt: "secret-jwt",
    };
    await writeFile(idPath, JSON.stringify(identity));

    const result = await getIdentity(logger, idPath);

    expect(result).not.toBeNull();
    expect(
      logger.messages.warn.some((w) => w.includes("Secrets found")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createIdentityService()
// ---------------------------------------------------------------------------

describe("createIdentityService", () => {
  it("starts and validates a correct identity", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentity()));

    const service = createIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identityPath: idPath,
    });

    expect(service.name).toBe("amcp-identity-manager");
    await service.start();

    expect(service.isValid()).toBe(true);
    expect(service.getIdentity()).not.toBeNull();
    expect(service.getIdentity()?.aid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
    expect(
      emitted.some((e) => e.event === "amcp:identity:validated"),
    ).toBe(true);

    const status = await service.status();
    expect(status.running).toBe(true);
    expect(status.details?.identityValid).toBe(true);
    expect(status.details?.aid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
  });

  it("emits alert on invalid identity and blocks checkpoints", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];

    const service = createIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identityPath: join(tmpDir, "nonexistent.json"),
    });

    await service.start();

    expect(service.isValid()).toBe(false);
    expect(service.getIdentity()).toBeNull();

    // Should emit amcp:identity:invalid alert
    expect(
      emitted.some((e) => e.event === "amcp:identity:invalid"),
    ).toBe(true);

    // Error logged about blocking checkpoints
    expect(
      logger.messages.error.some((e) => e.includes("checkpoints blocked")),
    ).toBe(true);

    const status = await service.status();
    expect(status.details?.identityValid).toBe(false);
  });

  it("emits alert on legacy sha256 identity", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(legacyIdentity()));

    const service = createIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identityPath: idPath,
    });

    await service.start();

    expect(service.isValid()).toBe(false);
    expect(
      emitted.some((e) => e.event === "amcp:identity:invalid"),
    ).toBe(true);
    expect(
      logger.messages.error.some((e) => e.includes("sha256")),
    ).toBe(true);
  });

  it("stops cleanly", async () => {
    const logger = makeLogger();
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentity()));

    const service = createIdentityService({
      logger,
      emit: () => {},
      identityPath: idPath,
    });

    await service.start();
    expect(service.isValid()).toBe(true);

    await service.stop();
    const status = await service.status();
    expect(status.running).toBe(false);
  });
});
