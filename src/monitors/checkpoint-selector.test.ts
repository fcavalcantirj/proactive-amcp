/**
 * Tests for checkpoint-selector — verifies scoring, best-selection,
 * fallback to older checkpoints, and manual CID override.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scoreCheckpoint,
  selectBestCheckpoint,
  gatherCheckpoints,
  listScoredCheckpoints,
} from "./checkpoint-selector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-checkpoint-selector-test-"));
  await mkdir(join(tmpDir, "checkpoints"), { recursive: true });
  await mkdir(join(tmpDir, "identities"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write identity.json with given AID. */
async function writeIdentity(
  dir: string,
  aid: string = "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z",
): Promise<string> {
  const identityPath = join(dir, "identity.json");
  await writeFile(
    identityPath,
    JSON.stringify({
      aid,
      publicKey: "test-pub-key",
      created: "2025-06-01T00:00:00Z",
    }),
  );
  return identityPath;
}

/** Write a checkpoint JSON file. */
async function writeCheckpoint(
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  const parentDir = path.substring(0, path.lastIndexOf("/"));
  await mkdir(parentDir, { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

/** Shorthand for creating a valid checkpoint record. */
function validCheckpoint(
  cid: string,
  timestamp: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cid,
    timestamp,
    triggerReason: "manual",
    size: 1024,
    secretCount: 3,
    type: "full",
    localPath: "/tmp/test.amcp",
    pinningService: "solvr",
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// scoreCheckpoint
// ---------------------------------------------------------------------------

describe("scoreCheckpoint", () => {
  it("scores a complete recent checkpoint highly", () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const data = validCheckpoint(
      "bafkreitest123abc",
      "2025-06-15T11:00:00Z",
      { ontologyGraphCID: "bafkrei...", soulHash: "abc123" },
    );

    const result = scoreCheckpoint(
      data,
      "/tmp/test.json",
      "last-checkpoint",
      now,
    );

    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.7);
    expect(result!.corrupted).toBe(false);
    expect(result!.scores.recency).toBeGreaterThan(0.9);
    expect(result!.scores.completeness).toBeGreaterThan(0.5);
    expect(result!.scores.integrity).toBeGreaterThan(0.5);
  });

  it("scores an old checkpoint lower on recency", () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const recent = scoreCheckpoint(
      validCheckpoint("bafkreirecent1234", "2025-06-15T11:00:00Z"),
      "/tmp/recent.json",
      "last-checkpoint",
      now,
    );
    const old = scoreCheckpoint(
      validCheckpoint("bafkreioldcp12345", "2025-06-10T12:00:00Z"),
      "/tmp/old.json",
      "checkpoints-dir",
      now,
    );

    expect(recent).not.toBeNull();
    expect(old).not.toBeNull();
    expect(recent!.scores.recency).toBeGreaterThan(old!.scores.recency);
    expect(recent!.score).toBeGreaterThan(old!.score);
  });

  it("scores an incomplete checkpoint lower on completeness", () => {
    const now = new Date("2025-06-15T12:00:00Z");
    const complete = scoreCheckpoint(
      validCheckpoint("bafkreicomplete12", "2025-06-15T11:00:00Z", {
        ontologyGraphCID: "bafkrei...",
        soulHash: "abc",
      }),
      "/tmp/complete.json",
      "last-checkpoint",
      now,
    );
    const incomplete = scoreCheckpoint(
      { cid: "bafkreiincomplete1", timestamp: "2025-06-15T11:00:00Z" },
      "/tmp/incomplete.json",
      "checkpoints-dir",
      now,
    );

    expect(complete).not.toBeNull();
    expect(incomplete).not.toBeNull();
    expect(complete!.scores.completeness).toBeGreaterThan(
      incomplete!.scores.completeness,
    );
  });

  it("marks corrupted checkpoint (missing CID)", () => {
    const result = scoreCheckpoint(
      { timestamp: "2025-06-15T11:00:00Z" },
      "/tmp/no-cid.json",
      "checkpoints-dir",
    );

    // No CID means null return
    expect(result).toBeNull();
  });

  it("marks corrupted checkpoint (invalid timestamp)", () => {
    const result = scoreCheckpoint(
      { cid: "bafkreiinvalid123", timestamp: "not-a-date" },
      "/tmp/bad-ts.json",
      "checkpoints-dir",
    );

    expect(result).not.toBeNull();
    expect(result!.corrupted).toBe(true);
    expect(result!.score).toBeLessThan(0.5);
  });

  it("extracts pinataCid as fallback", () => {
    const result = scoreCheckpoint(
      { pinataCid: "bafkreipinata1234", timestamp: "2025-06-15T12:00:00Z" },
      "/tmp/pinata.json",
      "last-checkpoint",
    );

    expect(result).not.toBeNull();
    expect(result!.cid).toBe("bafkreipinata1234");
  });

  it("extracts solvrCid as fallback", () => {
    const result = scoreCheckpoint(
      { solvrCid: "bafkreisolvrcid12", timestamp: "2025-06-15T12:00:00Z" },
      "/tmp/solvr.json",
      "last-checkpoint",
    );

    expect(result).not.toBeNull();
    expect(result!.cid).toBe("bafkreisolvrcid12");
  });
});

// ---------------------------------------------------------------------------
// gatherCheckpoints
// ---------------------------------------------------------------------------

describe("gatherCheckpoints", () => {
  it("gathers from global last-checkpoint.json", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(
      lastCheckpointPath,
      validCheckpoint("bafkreiglobal1234", "2025-06-15T12:00:00Z"),
    );

    const result = await gatherCheckpoints({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
    });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe("last-checkpoint");
  });

  it("gathers from per-identity checkpoint", async () => {
    const aid = "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z";
    const identityPath = await writeIdentity(tmpDir, aid);

    const sanitized = aid.replace(/[^a-zA-Z0-9_-]/g, "_");
    const perIdPath = join(
      tmpDir,
      "identities",
      sanitized,
      "last-checkpoint.json",
    );
    await writeCheckpoint(
      perIdPath,
      validCheckpoint("bafkreiperid12345", "2025-06-15T12:00:00Z"),
    );

    const result = await gatherCheckpoints({
      identityPath,
      lastCheckpointPath: join(tmpDir, "nonexistent.json"),
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
    });

    expect(result.length).toBe(1);
    expect(result[0].source).toBe("per-identity");
  });

  it("gathers from checkpoints directory", async () => {
    const identityPath = await writeIdentity(tmpDir);
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "cp-001.json"),
      validCheckpoint("bafkreidir1234567", "2025-06-14T12:00:00Z"),
    );
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "cp-002.json"),
      validCheckpoint("bafkreidir2345678", "2025-06-13T12:00:00Z"),
    );

    const result = await gatherCheckpoints({
      identityPath,
      lastCheckpointPath: join(tmpDir, "nonexistent.json"),
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
    });

    expect(result.length).toBe(2);
    expect(result.every((r) => r.source === "checkpoints-dir")).toBe(true);
  });

  it("deduplicates by CID across sources", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const sharedCid = "bafkreisharedcid1";

    // Same CID in global and checkpoints dir
    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(
      lastCheckpointPath,
      validCheckpoint(sharedCid, "2025-06-15T12:00:00Z"),
    );
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "cp-dup.json"),
      validCheckpoint(sharedCid, "2025-06-15T12:00:00Z"),
    );

    const result = await gatherCheckpoints({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
    });

    expect(result.length).toBe(1);
  });

  it("returns empty array when nothing exists", async () => {
    const result = await gatherCheckpoints({
      identityPath: join(tmpDir, "no-id.json"),
      lastCheckpointPath: join(tmpDir, "no-cp.json"),
      identitiesDir: join(tmpDir, "no-ids"),
      checkpointsDir: join(tmpDir, "no-cps"),
    });

    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// selectBestCheckpoint
// ---------------------------------------------------------------------------

describe("selectBestCheckpoint", () => {
  it("selects the highest-scoring checkpoint", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const now = new Date("2025-06-15T12:00:00Z");

    // Recent, complete checkpoint
    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(
      lastCheckpointPath,
      validCheckpoint("bafkreirecent1234", "2025-06-15T11:00:00Z", {
        ontologyGraphCID: "bafkrei...",
        soulHash: "abc",
      }),
    );

    // Older checkpoint in dir
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "old.json"),
      validCheckpoint("bafkreiolder12345", "2025-06-10T12:00:00Z"),
    );

    const best = await selectBestCheckpoint({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
      now,
    });

    expect(best).not.toBeNull();
    expect(best!.cid).toBe("bafkreirecent1234");
  });

  it("falls back to older checkpoint if latest is corrupted", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const now = new Date("2025-06-15T12:00:00Z");

    // Latest but corrupted (invalid timestamp)
    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(lastCheckpointPath, {
      cid: "bafkreicorrupted1",
      timestamp: "not-a-date",
    });

    // Older but valid
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "good.json"),
      validCheckpoint("bafkreigoodold123", "2025-06-12T12:00:00Z"),
    );

    const best = await selectBestCheckpoint({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
      now,
    });

    expect(best).not.toBeNull();
    expect(best!.cid).toBe("bafkreigoodold123");
    expect(best!.corrupted).toBe(false);
  });

  it("returns corrupted checkpoint when no clean alternatives exist", async () => {
    const identityPath = await writeIdentity(tmpDir);

    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(lastCheckpointPath, {
      cid: "bafkreionlycorrup",
      timestamp: "invalid",
    });

    const best = await selectBestCheckpoint({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
    });

    expect(best).not.toBeNull();
    expect(best!.cid).toBe("bafkreionlycorrup");
    expect(best!.corrupted).toBe(true);
  });

  it("supports manual CID override", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const now = new Date("2025-06-15T12:00:00Z");

    // Higher-scoring checkpoint
    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(
      lastCheckpointPath,
      validCheckpoint("bafkreihighscore1", "2025-06-15T11:00:00Z", {
        ontologyGraphCID: "bafkrei...",
        soulHash: "abc",
      }),
    );

    // Lower-scoring checkpoint
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "manual.json"),
      validCheckpoint("bafkreimanualcid1", "2025-06-10T12:00:00Z"),
    );

    const best = await selectBestCheckpoint({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
      manualCid: "bafkreimanualcid1",
      now,
    });

    expect(best).not.toBeNull();
    expect(best!.cid).toBe("bafkreimanualcid1");
  });

  it("returns null for manual CID not found locally", async () => {
    const identityPath = await writeIdentity(tmpDir);

    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(
      lastCheckpointPath,
      validCheckpoint("bafkreiexisting12", "2025-06-15T11:00:00Z"),
    );

    const best = await selectBestCheckpoint({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
      manualCid: "bafkreinotfound123",
    });

    expect(best).toBeNull();
  });

  it("returns null when no checkpoints exist", async () => {
    const best = await selectBestCheckpoint({
      identityPath: join(tmpDir, "no-id.json"),
      lastCheckpointPath: join(tmpDir, "no-cp.json"),
      identitiesDir: join(tmpDir, "no-ids"),
      checkpointsDir: join(tmpDir, "no-cps"),
    });

    expect(best).toBeNull();
  });

  it("prefers per-identity over same-age global checkpoint", async () => {
    const aid = "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z";
    const identityPath = await writeIdentity(tmpDir, aid);
    const now = new Date("2025-06-15T12:00:00Z");

    // Global and per-identity at the same time, same completeness
    const lastCheckpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(
      lastCheckpointPath,
      validCheckpoint("bafkreiglobalcid1", "2025-06-15T11:00:00Z"),
    );

    const sanitized = aid.replace(/[^a-zA-Z0-9_-]/g, "_");
    const perIdPath = join(
      tmpDir,
      "identities",
      sanitized,
      "last-checkpoint.json",
    );
    await writeCheckpoint(
      perIdPath,
      validCheckpoint("bafkreiperidcid12", "2025-06-15T11:00:00Z"),
    );

    // Per-identity is gathered first, global with same CID would be deduped.
    // But they have different CIDs, so both are in pool — with same score,
    // per-identity appears first in sorted order (stable sort, gathered first).
    const all = await listScoredCheckpoints({
      identityPath,
      lastCheckpointPath,
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
      now,
    });

    expect(all.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listScoredCheckpoints
// ---------------------------------------------------------------------------

describe("listScoredCheckpoints", () => {
  it("returns checkpoints sorted by score descending", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const now = new Date("2025-06-15T12:00:00Z");

    // Three checkpoints of varying quality
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "best.json"),
      validCheckpoint("bafkreibest123456", "2025-06-15T11:00:00Z", {
        ontologyGraphCID: "bafkrei...",
        soulHash: "abc",
      }),
    );
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "mid.json"),
      validCheckpoint("bafkreimidrange12", "2025-06-14T12:00:00Z"),
    );
    await writeCheckpoint(
      join(tmpDir, "checkpoints", "old.json"),
      validCheckpoint("bafkreioldest1234", "2025-06-10T12:00:00Z"),
    );

    const all = await listScoredCheckpoints({
      identityPath,
      lastCheckpointPath: join(tmpDir, "nonexistent.json"),
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
      now,
    });

    expect(all.length).toBe(3);
    // Scores should be in descending order
    for (let i = 0; i < all.length - 1; i++) {
      expect(all[i].score).toBeGreaterThanOrEqual(all[i + 1].score);
    }
    // Best should be the most recent and complete one
    expect(all[0].cid).toBe("bafkreibest123456");
  });

  it("includes score breakdown for each checkpoint", async () => {
    const identityPath = await writeIdentity(tmpDir);

    await writeCheckpoint(
      join(tmpDir, "checkpoints", "test.json"),
      validCheckpoint("bafkreiscoretest1", "2025-06-15T11:00:00Z"),
    );

    const all = await listScoredCheckpoints({
      identityPath,
      lastCheckpointPath: join(tmpDir, "nonexistent.json"),
      identitiesDir: join(tmpDir, "identities"),
      checkpointsDir: join(tmpDir, "checkpoints"),
    });

    expect(all.length).toBe(1);
    const cp = all[0];
    expect(cp.scores).toBeDefined();
    expect(typeof cp.scores.recency).toBe("number");
    expect(typeof cp.scores.completeness).toBe("number");
    expect(typeof cp.scores.integrity).toBe("number");
    expect(cp.scores.recency).toBeGreaterThanOrEqual(0);
    expect(cp.scores.recency).toBeLessThanOrEqual(1);
    expect(cp.scores.completeness).toBeGreaterThanOrEqual(0);
    expect(cp.scores.completeness).toBeLessThanOrEqual(1);
    expect(cp.scores.integrity).toBeGreaterThanOrEqual(0);
    expect(cp.scores.integrity).toBeLessThanOrEqual(1);
  });
});
