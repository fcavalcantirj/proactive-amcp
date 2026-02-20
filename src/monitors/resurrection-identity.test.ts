/**
 * Tests for resurrection-identity — verifies identity auto-injection on
 * resurrection, identity mismatch detection, and service lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  verifyAndInjectIdentity,
  createResurrectionIdentityService,
} from "./resurrection-identity.js";
import type { PluginLogger } from "../types.js";

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

function makeEmitter(): {
  emitted: Array<{ event: string; data?: Record<string, unknown> }>;
  emit: (event: string, data?: Record<string, unknown>) => void;
} {
  const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
  return {
    emitted,
    emit: (event, data) => emitted.push({ event, data }),
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

/** Different valid identity (different AID). */
function differentIdentity(): Record<string, unknown> {
  return {
    aid: "BABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
    publicKey: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
    created: "2025-02-01T12:00:00Z",
    kel: [
      {
        type: "inception",
        aid: "BABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
        publicKey: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
        timestamp: "2025-02-01T12:00:00Z",
      },
    ],
  };
}

/** Create a recent recovery record. */
function recentRecovery(
  method: string = "rehydrate",
  cid?: string,
): Record<string, unknown> {
  return {
    method,
    cid: cid ?? "bafkreiexamplecid123456789012345678901234567890123456",
    downtime: 42,
    timestamp: new Date().toISOString(),
  };
}

/** Create an old recovery record. */
function oldRecovery(): Record<string, unknown> {
  const old = new Date();
  old.setHours(old.getHours() - 1); // 1 hour ago
  return {
    method: "restart",
    downtime: 10,
    timestamp: old.toISOString(),
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-resurrection-id-test-"));
  await mkdir(join(tmpDir, "amcp"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// verifyAndInjectIdentity()
// ---------------------------------------------------------------------------

describe("verifyAndInjectIdentity", () => {
  it("skips when no recovery record exists", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const result = await verifyAndInjectIdentity({
      identityPath: join(tmpDir, "identity.json"),
      lastRecoveryPath: join(tmpDir, "nonexistent.json"),
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
      logger,
      emit,
    });

    expect(result.verified).toBe(false);
    expect(result.injected).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("skips when recovery is not recent", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    await writeFile(idPath, JSON.stringify(validIdentity()));
    await writeFile(recoveryPath, JSON.stringify(oldRecovery()));

    const result = await verifyAndInjectIdentity({
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
      logger,
      emit,
    });

    expect(result.verified).toBe(false);
    expect(result.injected).toBe(false);
    expect(
      logger.messages.debug.some((m) => m.includes("not recent")),
    ).toBe(true);
  });

  it("skips when last recovery was failed", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const recoveryPath = join(tmpDir, "last-recovery.json");
    await writeFile(
      recoveryPath,
      JSON.stringify({ method: "failed", timestamp: new Date().toISOString() }),
    );

    const result = await verifyAndInjectIdentity({
      identityPath: join(tmpDir, "identity.json"),
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
      logger,
      emit,
    });

    expect(result.verified).toBe(false);
    expect(result.injected).toBe(false);
    expect(
      logger.messages.warn.some((m) => m.includes("failed")),
    ).toBe(true);
  });

  it("verifies and injects identity on recent recovery with matching checkpoint", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const id = validIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");

    await writeFile(idPath, JSON.stringify(id));
    await writeFile(recoveryPath, JSON.stringify(recentRecovery()));
    await writeFile(
      checkpointPath,
      JSON.stringify({
        cid: "bafkreiexample",
        aid: id.aid,
        publicKey: id.publicKey,
        checkpointTimestamp: "2025-01-15T10:30:00Z",
      }),
    );

    const result = await verifyAndInjectIdentity({
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: checkpointPath,
      logger,
      emit,
    });

    expect(result.verified).toBe(true);
    expect(result.injected).toBe(true);
    expect(result.mismatch).toBe(false);
    expect(result.currentIdentity?.aid).toBe(id.aid as string);
    expect(result.checkpointIdentity?.aid).toBe(id.aid as string);

    // Should emit identity:injected
    expect(
      emitted.some((e) => e.event === "amcp:identity:injected"),
    ).toBe(true);
    const injectedEvent = emitted.find(
      (e) => e.event === "amcp:identity:injected",
    );
    expect(injectedEvent?.data?.aid).toBe(id.aid as string);
    expect(injectedEvent?.data?.source).toBe("checkpoint-verified");
  });

  it("alerts on identity mismatch between current and checkpoint", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const currentId = validIdentity();
    const checkpointId = differentIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");

    await writeFile(idPath, JSON.stringify(currentId));
    await writeFile(recoveryPath, JSON.stringify(recentRecovery()));
    await writeFile(
      checkpointPath,
      JSON.stringify({
        cid: "bafkreiexample",
        aid: checkpointId.aid,
        publicKey: checkpointId.publicKey,
      }),
    );

    const result = await verifyAndInjectIdentity({
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: checkpointPath,
      logger,
      emit,
    });

    expect(result.verified).toBe(false);
    expect(result.injected).toBe(false);
    expect(result.mismatch).toBe(true);
    expect(result.mismatchDetails).toContain("AID mismatch");
    expect(result.mismatchDetails).toContain(currentId.aid as string);
    expect(result.mismatchDetails).toContain(checkpointId.aid as string);

    // Should emit identity:mismatch alert
    expect(
      emitted.some((e) => e.event === "amcp:identity:mismatch"),
    ).toBe(true);
    const mismatchEvent = emitted.find(
      (e) => e.event === "amcp:identity:mismatch",
    );
    expect(mismatchEvent?.data?.currentAid).toBe(currentId.aid as string);
    expect(mismatchEvent?.data?.checkpointAid).toBe(
      checkpointId.aid as string,
    );

    // Should log error
    expect(
      logger.messages.error.some((m) => m.includes("IDENTITY MISMATCH")),
    ).toBe(true);
  });

  it("injects current identity when checkpoint has no embedded identity", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const id = validIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");

    await writeFile(idPath, JSON.stringify(id));
    await writeFile(recoveryPath, JSON.stringify(recentRecovery("restart")));
    // Checkpoint metadata without embedded identity
    await writeFile(
      checkpointPath,
      JSON.stringify({
        cid: "bafkreiexample",
        timestamp: "2025-01-15T10:30:00Z",
      }),
    );

    const result = await verifyAndInjectIdentity({
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: checkpointPath,
      logger,
      emit,
    });

    // When checkpoint identity matches current (fallback reads same file),
    // it should still verify and inject
    expect(result.injected).toBe(true);
    expect(result.currentIdentity?.aid).toBe(id.aid as string);

    expect(
      emitted.some((e) => e.event === "amcp:identity:injected"),
    ).toBe(true);
  });

  it("errors when current identity is invalid", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const recoveryPath = join(tmpDir, "last-recovery.json");
    const idPath = join(tmpDir, "identity.json");

    await writeFile(recoveryPath, JSON.stringify(recentRecovery()));
    await writeFile(idPath, JSON.stringify({ aid: "invalid" }));

    const result = await verifyAndInjectIdentity({
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
      logger,
      emit,
    });

    expect(result.verified).toBe(false);
    expect(result.injected).toBe(false);
    expect(
      emitted.some((e) => e.event === "amcp:identity:invalid"),
    ).toBe(true);
  });

  it("respects custom recentThresholdMs", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const id = validIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");

    await writeFile(idPath, JSON.stringify(id));
    // Recovery 10 seconds ago
    const tenSecondsAgo = new Date();
    tenSecondsAgo.setSeconds(tenSecondsAgo.getSeconds() - 10);
    await writeFile(
      recoveryPath,
      JSON.stringify({
        method: "restart",
        timestamp: tenSecondsAgo.toISOString(),
      }),
    );

    // With 5-second threshold, should skip (recovery too old)
    const result = await verifyAndInjectIdentity({
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
      logger,
      emit,
      recentThresholdMs: 5_000,
    });

    expect(result.injected).toBe(false);
    expect(
      logger.messages.debug.some((m) => m.includes("not recent")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createResurrectionIdentityService()
// ---------------------------------------------------------------------------

describe("createResurrectionIdentityService", () => {
  it("starts, checks for recovery, and stops cleanly", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const service = createResurrectionIdentityService({
      logger,
      emit,
      identityPath: join(tmpDir, "identity.json"),
      lastRecoveryPath: join(tmpDir, "nonexistent.json"),
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
    });

    expect(service.name).toBe("amcp-resurrection-identity");

    await service.start();
    const status = await service.status();
    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-resurrection-identity");

    await service.stop();
    const stoppedStatus = await service.status();
    expect(stoppedStatus.running).toBe(false);

    expect(
      logger.messages.info.some((m) =>
        m.includes("amcp-resurrection-identity: started"),
      ),
    ).toBe(true);
    expect(
      logger.messages.info.some((m) =>
        m.includes("amcp-resurrection-identity: stopped"),
      ),
    ).toBe(true);
  });

  it("auto-injects identity on start when recent recovery exists", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const id = validIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");

    await writeFile(idPath, JSON.stringify(id));
    await writeFile(recoveryPath, JSON.stringify(recentRecovery()));
    await writeFile(
      checkpointPath,
      JSON.stringify({
        cid: "bafkreiexample",
        aid: id.aid,
        publicKey: id.publicKey,
      }),
    );

    const service = createResurrectionIdentityService({
      logger,
      emit,
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: checkpointPath,
    });

    await service.start();

    expect(
      logger.messages.info.some((m) => m.includes("auto-injected")),
    ).toBe(true);
    expect(
      emitted.some((e) => e.event === "amcp:identity:injected"),
    ).toBe(true);

    const lastResult = service.getLastResult();
    expect(lastResult).not.toBeNull();
    expect(lastResult?.verified).toBe(true);
    expect(lastResult?.injected).toBe(true);
  });

  it("verifyNow() re-checks identity on demand", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const id = validIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");

    await writeFile(idPath, JSON.stringify(id));
    await writeFile(recoveryPath, JSON.stringify(recentRecovery()));
    await writeFile(
      checkpointPath,
      JSON.stringify({
        cid: "bafkreiexample",
        aid: id.aid,
        publicKey: id.publicKey,
      }),
    );

    const service = createResurrectionIdentityService({
      logger,
      emit,
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: checkpointPath,
    });

    await service.start();

    // Clear emitted events and verify again
    emitted.length = 0;
    const result = await service.verifyNow();

    expect(result.verified).toBe(true);
    expect(result.injected).toBe(true);
    expect(
      emitted.some((e) => e.event === "amcp:identity:injected"),
    ).toBe(true);
  });

  it("status() includes verification details", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const id = validIdentity();
    const idPath = join(tmpDir, "identity.json");
    const recoveryPath = join(tmpDir, "last-recovery.json");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");

    await writeFile(idPath, JSON.stringify(id));
    await writeFile(recoveryPath, JSON.stringify(recentRecovery()));
    await writeFile(
      checkpointPath,
      JSON.stringify({
        cid: "bafkreiexample",
        aid: id.aid,
        publicKey: id.publicKey,
      }),
    );

    const service = createResurrectionIdentityService({
      logger,
      emit,
      identityPath: idPath,
      lastRecoveryPath: recoveryPath,
      lastCheckpointPath: checkpointPath,
    });

    await service.start();

    const status = await service.status();
    const details = status.details as Record<string, unknown>;
    const lastVerification = details.lastVerification as Record<
      string,
      unknown
    >;

    expect(lastVerification).not.toBeNull();
    expect(lastVerification.verified).toBe(true);
    expect(lastVerification.mismatch).toBe(false);
    expect(lastVerification.injected).toBe(true);
    expect(lastVerification.currentAid).toBe(id.aid as string);
  });
});
