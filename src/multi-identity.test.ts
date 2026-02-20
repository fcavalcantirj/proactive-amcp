/**
 * Tests for multi-identity manager — verifies identity storage by AID,
 * identity switching, per-identity checkpoint history, and cross-identity
 * resurrection prevention.
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
  listIdentities,
  getActiveAid,
  storeIdentity,
  switchIdentity,
  getCheckpointPathForAid,
  validateCheckpointOwnership,
  createMultiIdentityService,
} from "./multi-identity.js";
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

/** Valid KERI-style identity for testing — agent A. */
function identityA(): Record<string, unknown> {
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

/** Valid KERI-style identity for testing — agent B (different AID). */
function identityB(): Record<string, unknown> {
  return {
    aid: "BxYz7890AbCdEfGhIjKlMnOpQrStUvWxYz0123456abc",
    publicKey: "xYz7890AbCdEfGhIjKlMnOpQrStUvWxYz0123456abc",
    created: "2025-02-01T12:00:00Z",
    kel: [
      {
        type: "inception",
        aid: "BxYz7890AbCdEfGhIjKlMnOpQrStUvWxYz0123456abc",
        publicKey: "xYz7890AbCdEfGhIjKlMnOpQrStUvWxYz0123456abc",
        timestamp: "2025-02-01T12:00:00Z",
      },
    ],
  };
}

let tmpDir: string;
let identitiesDir: string;
let mainIdentityPath: string;
let activeMarkerPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-multi-id-test-"));
  identitiesDir = join(tmpDir, "identities");
  mainIdentityPath = join(tmpDir, "identity.json");
  activeMarkerPath = join(tmpDir, "active-identity");
  await mkdir(identitiesDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// listIdentities()
// ---------------------------------------------------------------------------

describe("listIdentities", () => {
  it("returns empty array when no identities stored", async () => {
    const results = await listIdentities(identitiesDir);
    expect(results).toEqual([]);
  });

  it("returns empty array when directory does not exist", async () => {
    const results = await listIdentities(join(tmpDir, "nonexistent"));
    expect(results).toEqual([]);
  });

  it("lists stored identities", async () => {
    // Store identity A
    const aidA = (identityA() as { aid: string }).aid;
    const dirA = join(identitiesDir, aidA);
    await mkdir(dirA, { recursive: true });
    await writeFile(join(dirA, "identity.json"), JSON.stringify(identityA()));

    // Store identity B
    const aidB = (identityB() as { aid: string }).aid;
    const dirB = join(identitiesDir, aidB);
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, "identity.json"), JSON.stringify(identityB()));

    const results = await listIdentities(identitiesDir);
    expect(results).toHaveLength(2);
    const aids = results.map((r) => r.aid).sort();
    expect(aids).toContain(aidA);
    expect(aids).toContain(aidB);
  });

  it("skips invalid identity directories", async () => {
    // Store valid identity A
    const aidA = (identityA() as { aid: string }).aid;
    const dirA = join(identitiesDir, aidA);
    await mkdir(dirA, { recursive: true });
    await writeFile(join(dirA, "identity.json"), JSON.stringify(identityA()));

    // Create broken identity directory
    const dirBad = join(identitiesDir, "broken-id");
    await mkdir(dirBad, { recursive: true });
    await writeFile(join(dirBad, "identity.json"), "not valid json");

    const results = await listIdentities(identitiesDir);
    expect(results).toHaveLength(1);
    expect(results[0].aid).toBe(aidA);
  });
});

// ---------------------------------------------------------------------------
// getActiveAid()
// ---------------------------------------------------------------------------

describe("getActiveAid", () => {
  it("reads from marker file", async () => {
    const aid = "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE";
    await writeFile(activeMarkerPath, aid);

    const result = await getActiveAid(activeMarkerPath, mainIdentityPath);
    expect(result).toBe(aid);
  });

  it("falls back to main identity.json when no marker", async () => {
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const result = await getActiveAid(activeMarkerPath, mainIdentityPath);
    expect(result).toBe((identityA() as { aid: string }).aid);
  });

  it("returns null when neither marker nor identity exist", async () => {
    const result = await getActiveAid(
      join(tmpDir, "nonexistent-marker"),
      join(tmpDir, "nonexistent-identity.json"),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storeIdentity()
// ---------------------------------------------------------------------------

describe("storeIdentity", () => {
  it("stores a valid identity to identities/<aid>/", async () => {
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const result = await storeIdentity(mainIdentityPath, identitiesDir);

    expect(result).not.toBeNull();
    expect(result!.aid).toBe((identityA() as { aid: string }).aid);

    // Verify file was written
    const stored = JSON.parse(
      await readFile(join(result!.dirPath, "identity.json"), "utf-8"),
    );
    expect(stored.aid).toBe((identityA() as { aid: string }).aid);
  });

  it("returns null for invalid identity", async () => {
    const badPath = join(tmpDir, "bad-identity.json");
    await writeFile(badPath, JSON.stringify({ aid: "invalid" }));

    const result = await storeIdentity(badPath, identitiesDir);
    expect(result).toBeNull();
  });

  it("provides per-identity lastCheckpointPath", async () => {
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));
    const result = await storeIdentity(mainIdentityPath, identitiesDir);

    expect(result!.lastCheckpointPath).toContain("last-checkpoint.json");
    expect(result!.lastCheckpointPath).toContain(
      (identityA() as { aid: string }).aid,
    );
  });
});

// ---------------------------------------------------------------------------
// switchIdentity()
// ---------------------------------------------------------------------------

describe("switchIdentity", () => {
  it("switches active identity to a stored one", async () => {
    // Store both identities
    const pathA = join(tmpDir, "id-a.json");
    const pathB = join(tmpDir, "id-b.json");
    await writeFile(pathA, JSON.stringify(identityA()));
    await writeFile(pathB, JSON.stringify(identityB()));
    await storeIdentity(pathA, identitiesDir);
    await storeIdentity(pathB, identitiesDir);

    // Initially set A as active
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));
    await writeFile(activeMarkerPath, (identityA() as { aid: string }).aid);

    // Switch to B
    const aidB = (identityB() as { aid: string }).aid;
    const result = await switchIdentity(aidB, {
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });

    expect(result).not.toBeNull();
    expect(result!.aid).toBe(aidB);

    // Main identity.json should now be B
    const main = JSON.parse(await readFile(mainIdentityPath, "utf-8"));
    expect(main.aid).toBe(aidB);

    // Marker should be updated
    const marker = await readFile(activeMarkerPath, "utf-8");
    expect(marker.trim()).toBe(aidB);
  });

  it("returns null when target identity not found", async () => {
    const result = await switchIdentity("BnonexistentAid00000000000000000000000000000", {
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCheckpointPathForAid()
// ---------------------------------------------------------------------------

describe("getCheckpointPathForAid", () => {
  it("returns per-identity checkpoint path", () => {
    const aid = "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE";
    const path = getCheckpointPathForAid(aid, identitiesDir);
    expect(path).toBe(join(identitiesDir, aid, "last-checkpoint.json"));
  });

  it("each identity gets a different checkpoint path", () => {
    const aidA = (identityA() as { aid: string }).aid;
    const aidB = (identityB() as { aid: string }).aid;
    const pathA = getCheckpointPathForAid(aidA, identitiesDir);
    const pathB = getCheckpointPathForAid(aidB, identitiesDir);
    expect(pathA).not.toBe(pathB);
  });
});

// ---------------------------------------------------------------------------
// validateCheckpointOwnership()
// ---------------------------------------------------------------------------

describe("validateCheckpointOwnership", () => {
  it("allows checkpoint with matching AID", async () => {
    const aidA = (identityA() as { aid: string }).aid;
    const cpPath = join(tmpDir, "last-checkpoint.json");
    await writeFile(cpPath, JSON.stringify({ aid: aidA, cid: "bafkrei..." }));

    const result = await validateCheckpointOwnership(cpPath, aidA);
    expect(result.valid).toBe(true);
    expect(result.checkpointAid).toBe(aidA);
  });

  it("blocks checkpoint with different AID", async () => {
    const aidA = (identityA() as { aid: string }).aid;
    const aidB = (identityB() as { aid: string }).aid;
    const cpPath = join(tmpDir, "last-checkpoint.json");
    await writeFile(cpPath, JSON.stringify({ aid: aidB, cid: "bafkrei..." }));

    const result = await validateCheckpointOwnership(cpPath, aidA);
    expect(result.valid).toBe(false);
    expect(result.checkpointAid).toBe(aidB);
    expect(result.reason).toContain("not");
  });

  it("allows checkpoint with nested identity.aid", async () => {
    const aidA = (identityA() as { aid: string }).aid;
    const cpPath = join(tmpDir, "last-checkpoint.json");
    await writeFile(
      cpPath,
      JSON.stringify({ identity: { aid: aidA }, cid: "bafkrei..." }),
    );

    const result = await validateCheckpointOwnership(cpPath, aidA);
    expect(result.valid).toBe(true);
  });

  it("allows legacy checkpoint without AID (can't verify)", async () => {
    const aidA = (identityA() as { aid: string }).aid;
    const cpPath = join(tmpDir, "last-checkpoint.json");
    await writeFile(cpPath, JSON.stringify({ cid: "bafkrei..." }));

    const result = await validateCheckpointOwnership(cpPath, aidA);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe("no-aid-in-checkpoint");
  });

  it("allows when checkpoint file missing (new agent)", async () => {
    const aidA = (identityA() as { aid: string }).aid;
    const result = await validateCheckpointOwnership(
      join(tmpDir, "nonexistent.json"),
      aidA,
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toBe("checkpoint-unreadable");
  });
});

// ---------------------------------------------------------------------------
// createMultiIdentityService()
// ---------------------------------------------------------------------------

describe("createMultiIdentityService", () => {
  it("starts and registers current identity", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const service = createMultiIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });

    expect(service.name).toBe("amcp-multi-identity");
    await service.start();

    // Should have stored the identity
    const stored = await service.listIdentities();
    expect(stored).toHaveLength(1);
    expect(stored[0].aid).toBe((identityA() as { aid: string }).aid);

    // Active AID should be set
    const active = await service.getActiveAid();
    expect(active).toBe((identityA() as { aid: string }).aid);

    // Should emit started event
    expect(emitted.some((e) => e.event === "amcp:multi-identity:started")).toBe(
      true,
    );

    const status = await service.status();
    expect(status.running).toBe(true);
    expect(status.details?.activeAid).toBe(
      (identityA() as { aid: string }).aid,
    );
    expect(status.details?.storedCount).toBe(1);
  });

  it("switches identity via service method", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];

    // Store both identities
    const pathA = join(tmpDir, "id-a.json");
    const pathB = join(tmpDir, "id-b.json");
    await writeFile(pathA, JSON.stringify(identityA()));
    await writeFile(pathB, JSON.stringify(identityB()));
    await storeIdentity(pathA, identitiesDir);
    await storeIdentity(pathB, identitiesDir);

    // Start with A active
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const service = createMultiIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });
    await service.start();

    // Switch to B
    const aidB = (identityB() as { aid: string }).aid;
    const result = await service.switchIdentity(aidB);
    expect(result).not.toBeNull();
    expect(result!.aid).toBe(aidB);

    // Active AID should now be B
    const active = await service.getActiveAid();
    expect(active).toBe(aidB);

    // Should emit switched event
    expect(emitted.some((e) => e.event === "amcp:identity:switched")).toBe(true);
    const switchEvent = emitted.find((e) => e.event === "amcp:identity:switched");
    expect(switchEvent?.data?.newAid).toBe(aidB);
  });

  it("blocks cross-identity resurrection", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];

    // Start with identity A
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const service = createMultiIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });
    await service.start();

    // Create a checkpoint from identity B
    const cpPath = join(tmpDir, "checkpoint-b.json");
    const aidB = (identityB() as { aid: string }).aid;
    await writeFile(cpPath, JSON.stringify({ aid: aidB, cid: "bafkrei..." }));

    // Try to validate — should be blocked
    const result = await service.validateCheckpointOwnership(cpPath);
    expect(result.valid).toBe(false);
    expect(result.checkpointAid).toBe(aidB);

    // Should emit cross-identity-blocked event
    expect(
      emitted.some((e) => e.event === "amcp:identity:cross-identity-blocked"),
    ).toBe(true);

    // Should log error
    expect(
      logger.messages.error.some((e) =>
        e.includes("cross-identity resurrection blocked"),
      ),
    ).toBe(true);
  });

  it("logs error when switching to nonexistent identity", async () => {
    const logger = makeLogger();
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const service = createMultiIdentityService({
      logger,
      emit: () => {},
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });
    await service.start();

    const result = await service.switchIdentity(
      "BnonexistentAid00000000000000000000000000000",
    );
    expect(result).toBeNull();
    expect(
      logger.messages.error.some((e) => e.includes("not found in store")),
    ).toBe(true);
  });

  it("stops cleanly", async () => {
    const logger = makeLogger();
    await writeFile(mainIdentityPath, JSON.stringify(identityA()));

    const service = createMultiIdentityService({
      logger,
      emit: () => {},
      identitiesDir,
      identityPath: mainIdentityPath,
      activeMarkerPath,
    });
    await service.start();
    await service.stop();

    const status = await service.status();
    expect(status.running).toBe(false);
  });

  it("handles start without valid identity gracefully", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];

    const service = createMultiIdentityService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identitiesDir,
      identityPath: join(tmpDir, "nonexistent.json"),
      activeMarkerPath,
    });
    await service.start();

    // Should warn but not crash
    expect(
      logger.messages.warn.some((w) => w.includes("no valid identity")),
    ).toBe(true);

    const active = await service.getActiveAid();
    expect(active).toBeNull();
  });
});
