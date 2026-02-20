/**
 * Tests for key-rotation — verifies pre-rotation key reading, rotation need
 * detection, rotation execution, history logging, and service lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readNextKeyHash,
  detectRotationNeed,
  rotateKey,
  loadRotationHistory,
  createKeyRotationService,
} from "./key-rotation.js";
import { validateIdentity } from "./identity-manager.js";
import type { AmcpIdentity, PluginLogger } from "./types.js";

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

/** Valid KERI-style identity with nextKeyHash for testing. */
function validIdentityWithNextKey(): Record<string, unknown> {
  return {
    aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    created: "2025-01-15T10:30:00Z",
    nextKeyHash: "WIVSHoPhtTyQaiqrLXOW76rIBP5qybcXWenLHAkjg5Q",
    kel: [
      {
        type: "inception",
        aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
        publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
        nextKeyHash: "WIVSHoPhtTyQaiqrLXOW76rIBP5qybcXWenLHAkjg5Q",
        timestamp: "2025-01-15T10:30:00Z",
      },
    ],
  };
}

/** Valid identity without nextKeyHash. */
function validIdentityWithoutNextKey(): Record<string, unknown> {
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

/** Identity with nextKeyHash only in KEL event's "next" field (protocol format). */
function identityWithKelNext(): Record<string, unknown> {
  return {
    aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    created: "2025-01-15T10:30:00Z",
    kel: [
      {
        type: "inception",
        aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
        publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
        next: "EOWDAJvex5dZzDxeHBANyaIoUG3kxyz",
        timestamp: "2025-01-15T10:30:00Z",
      },
    ],
  };
}

/** Build a parsed AmcpIdentity from raw data. */
function toIdentity(raw: Record<string, unknown>): AmcpIdentity {
  const kelEvents = raw.kel as Array<Record<string, unknown>> | undefined;
  let nextKeyHash: string | undefined;
  if (typeof raw.nextKeyHash === "string") {
    nextKeyHash = raw.nextKeyHash;
  } else if (kelEvents && kelEvents.length > 0) {
    const last = kelEvents[kelEvents.length - 1];
    if (typeof last.nextKeyHash === "string") nextKeyHash = last.nextKeyHash;
    else if (typeof last.next === "string") nextKeyHash = last.next;
  }
  return {
    aid: raw.aid as string,
    publicKey: raw.publicKey as string,
    created: raw.created as string,
    kel: raw.kel as unknown[],
    nextKeyHash,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-rotation-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readNextKeyHash()
// ---------------------------------------------------------------------------

describe("readNextKeyHash", () => {
  it("reads nextKeyHash from top-level identity field", () => {
    const identity = toIdentity(validIdentityWithNextKey());
    expect(readNextKeyHash(identity)).toBe(
      "WIVSHoPhtTyQaiqrLXOW76rIBP5qybcXWenLHAkjg5Q",
    );
  });

  it("reads nextKeyHash from KEL event 'next' field", () => {
    const identity = toIdentity(identityWithKelNext());
    expect(readNextKeyHash(identity)).toBe("EOWDAJvex5dZzDxeHBANyaIoUG3kxyz");
  });

  it("returns null when no nextKeyHash exists", () => {
    const identity = toIdentity(validIdentityWithoutNextKey());
    expect(readNextKeyHash(identity)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateIdentity() reads nextKeyHash
// ---------------------------------------------------------------------------

describe("validateIdentity nextKeyHash extraction", () => {
  it("extracts top-level nextKeyHash into identity", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentityWithNextKey()));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
    expect(result.identity?.nextKeyHash).toBe(
      "WIVSHoPhtTyQaiqrLXOW76rIBP5qybcXWenLHAkjg5Q",
    );
  });

  it("extracts nextKeyHash from KEL 'next' field", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(identityWithKelNext()));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
    expect(result.identity?.nextKeyHash).toBe(
      "EOWDAJvex5dZzDxeHBANyaIoUG3kxyz",
    );
  });

  it("returns undefined nextKeyHash when absent", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentityWithoutNextKey()));

    const result = await validateIdentity(idPath);

    expect(result.valid).toBe(true);
    expect(result.identity?.nextKeyHash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectRotationNeed()
// ---------------------------------------------------------------------------

describe("detectRotationNeed", () => {
  it("detects compromise trigger", () => {
    const identity = toIdentity(validIdentityWithNextKey());
    const result = detectRotationNeed(identity, { compromised: true });

    expect(result.needed).toBe(true);
    expect(result.trigger).toBe("compromise");
    expect(result.reason).toContain("compromise");
  });

  it("detects scheduled rotation when identity is old", () => {
    const identity = toIdentity(validIdentityWithNextKey());
    // Set "now" to 100 days after creation
    const now = new Date("2025-04-25T10:30:00Z");
    const result = detectRotationNeed(identity, {
      maxAgeDays: 90,
      now,
    });

    expect(result.needed).toBe(true);
    expect(result.trigger).toBe("scheduled");
    expect(result.reason).toContain("100 days old");
  });

  it("reports no rotation needed for fresh identity", () => {
    const identity = toIdentity(validIdentityWithNextKey());
    const now = new Date("2025-01-20T10:30:00Z"); // 5 days old
    const result = detectRotationNeed(identity, {
      maxAgeDays: 90,
      now,
    });

    expect(result.needed).toBe(false);
    expect(result.trigger).toBeNull();
  });

  it("compromise takes priority over scheduled", () => {
    const identity = toIdentity(validIdentityWithNextKey());
    const now = new Date("2025-04-25T10:30:00Z"); // old enough for scheduled
    const result = detectRotationNeed(identity, {
      compromised: true,
      maxAgeDays: 90,
      now,
    });

    expect(result.trigger).toBe("compromise");
  });

  it("uses default maxAgeDays of 90", () => {
    const identity = toIdentity(validIdentityWithNextKey());
    const now = new Date("2025-04-16T10:30:00Z"); // exactly 91 days
    const result = detectRotationNeed(identity, { now });

    expect(result.needed).toBe(true);
    expect(result.trigger).toBe("scheduled");
  });
});

// ---------------------------------------------------------------------------
// rotateKey()
// ---------------------------------------------------------------------------

describe("rotateKey", () => {
  it("fails when identity is invalid", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, '{"aid": "invalid"}');

    const result = await rotateKey("manual", { identityPath: idPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Current identity invalid");
  });

  it("fails when no nextKeyHash exists", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentityWithoutNextKey()));

    const result = await rotateKey("manual", { identityPath: idPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No nextKeyHash");
    expect(result.error).toContain("pre-rotation commitment required");
  });

  it("fails when amcp CLI is not found", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentityWithNextKey()));

    const result = await rotateKey("manual", {
      identityPath: idPath,
      amcpCli: "/nonexistent/amcp",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("amcp identity rotate failed");
  });

  it("succeeds with mock amcp CLI that performs rotation", async () => {
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentityWithNextKey()));

    // Write the rotated identity — AID stays the same (KERI: AID = inception key),
    // but publicKey (current signing key) changes after rotation
    const rotatedIdentity = {
      aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
      publicKey: "xYz9AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_90",
      created: "2025-01-15T10:30:00Z",
      nextKeyHash: "newNextKeyHashAfterRotation123456",
      kel: [
        {
          type: "inception",
          aid: "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
          publicKey: "IFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
          nextKeyHash: "WIVSHoPhtTyQaiqrLXOW76rIBP5qybcXWenLHAkjg5Q",
          timestamp: "2025-01-15T10:30:00Z",
        },
        {
          type: "rotation",
          publicKey: "xYz9AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_90",
          nextKeyHash: "newNextKeyHashAfterRotation123456",
          timestamp: "2025-04-25T12:00:00Z",
        },
      ],
    };
    const rotatedPath = join(tmpDir, "rotated-identity.json");
    await writeFile(rotatedPath, JSON.stringify(rotatedIdentity, null, 2));

    // Mock amcp CLI: on "identity rotate", copies rotated identity to the target path
    const mockBin = join(tmpDir, "mock-amcp");
    const { chmod } = await import("node:fs/promises");
    await writeFile(
      mockBin,
      [
        "#!/bin/bash",
        'if [ "$1" = "identity" ] && [ "$2" = "rotate" ]; then',
        "  IDPATH=",
        "  shift 2",
        '  while [ $# -gt 0 ]; do',
        '    case "$1" in',
        '      --identity) IDPATH="$2"; shift 2 ;;',
        "      *) shift ;;",
        "    esac",
        "  done",
        `  [ -n "$IDPATH" ] && cp "${rotatedPath}" "$IDPATH"`,
        "  exit 0",
        "fi",
        'if [ "$1" = "identity" ] && [ "$2" = "validate" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n") + "\n",
    );
    await chmod(mockBin, 0o755);

    const rotationsPath = join(tmpDir, "key-rotations.jsonl");
    const logger = makeLogger();

    const result = await rotateKey("scheduled", {
      identityPath: idPath,
      rotationsPath,
      amcpCli: mockBin,
      logger,
    });

    expect(result.success).toBe(true);
    expect(result.record).not.toBeNull();
    expect(result.record!.trigger).toBe("scheduled");
    expect(result.record!.previousAid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
    // In KERI, AID stays the same across rotations (derived from inception key)
    expect(result.record!.newAid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
    expect(result.record!.kelSequenceNumber).toBe(2);
    expect(result.record!.nextKeyHash).toBe(
      "newNextKeyHashAfterRotation123456",
    );

    // Verify rotation logged
    expect(
      logger.messages.info.some((m) => m.includes("rotation complete")),
    ).toBe(true);

    // Verify history was written
    const history = await loadRotationHistory(rotationsPath);
    expect(history).toHaveLength(1);
    expect(history[0].trigger).toBe("scheduled");
    expect(history[0].previousAid).toBe(
      "BIFp5TDh1oEFPVh11v4Zy4R9d_MjfPIjPjC7cFiZwmJE",
    );
  });
});

// ---------------------------------------------------------------------------
// loadRotationHistory()
// ---------------------------------------------------------------------------

describe("loadRotationHistory", () => {
  it("returns empty array for nonexistent file", async () => {
    const history = await loadRotationHistory(
      join(tmpDir, "nonexistent.jsonl"),
    );
    expect(history).toEqual([]);
  });

  it("returns empty array for empty file", async () => {
    const path = join(tmpDir, "empty.jsonl");
    await writeFile(path, "");
    const history = await loadRotationHistory(path);
    expect(history).toEqual([]);
  });

  it("parses multi-line JSONL", async () => {
    const path = join(tmpDir, "rotations.jsonl");
    const records = [
      {
        timestamp: "2025-03-01T00:00:00Z",
        trigger: "scheduled",
        previousAid: "Bprev1",
        newAid: "Bnew1",
        previousPublicKey: "pk1",
        newPublicKey: "pk2",
        kelSequenceNumber: 1,
        nextKeyHash: "hash1",
      },
      {
        timestamp: "2025-06-01T00:00:00Z",
        trigger: "manual",
        previousAid: "Bnew1",
        newAid: "Bnew2",
        previousPublicKey: "pk2",
        newPublicKey: "pk3",
        kelSequenceNumber: 2,
        nextKeyHash: "hash2",
      },
    ];
    await writeFile(
      path,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const history = await loadRotationHistory(path);
    expect(history).toHaveLength(2);
    expect(history[0].trigger).toBe("scheduled");
    expect(history[1].trigger).toBe("manual");
    expect(history[1].kelSequenceNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createKeyRotationService()
// ---------------------------------------------------------------------------

describe("createKeyRotationService", () => {
  it("starts, checks rotation need, and reports status", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const idPath = join(tmpDir, "identity.json");
    // Use a recent created date so rotation is not needed
    const freshIdentity = {
      ...validIdentityWithNextKey(),
      created: new Date().toISOString(),
    };
    await writeFile(idPath, JSON.stringify(freshIdentity));

    const service = createKeyRotationService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identityPath: idPath,
    });

    expect(service.name).toBe("amcp-key-rotation");

    await service.start();

    const status = await service.status();
    expect(status.running).toBe(true);
    expect(status.details?.service).toBe("amcp-key-rotation");
    expect(status.details?.totalRotations).toBe(0);

    expect(
      logger.messages.info.some((m) => m.includes("no rotation needed")),
    ).toBe(true);
  });

  it("emits rotation:needed for old identity", async () => {
    const logger = makeLogger();
    const emitted: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const idPath = join(tmpDir, "identity.json");
    // Create an identity from 2024 — over 90 days old
    const oldIdentity = {
      ...validIdentityWithNextKey(),
      created: "2024-01-15T10:30:00Z",
    };
    await writeFile(idPath, JSON.stringify(oldIdentity));

    const service = createKeyRotationService({
      logger,
      emit: (event, data) => emitted.push({ event, data }),
      identityPath: idPath,
      maxAgeDays: 90,
    });

    await service.start();

    expect(
      emitted.some((e) => e.event === "amcp:rotation:needed"),
    ).toBe(true);
    expect(
      logger.messages.warn.some((m) => m.includes("days old")),
    ).toBe(true);
  });

  it("checkRotationNeed returns correct result", async () => {
    const logger = makeLogger();
    const idPath = join(tmpDir, "identity.json");
    // Use a recent created date so rotation is not needed
    const freshIdentity = {
      ...validIdentityWithNextKey(),
      created: new Date().toISOString(),
    };
    await writeFile(idPath, JSON.stringify(freshIdentity));

    const service = createKeyRotationService({
      logger,
      emit: () => {},
      identityPath: idPath,
    });

    await service.start();

    const need = await service.checkRotationNeed();
    expect(need.needed).toBe(false);
  });

  it("getHistory returns rotation records", async () => {
    const logger = makeLogger();
    const rotPath = join(tmpDir, "rotations.jsonl");
    await writeFile(
      rotPath,
      JSON.stringify({
        timestamp: "2025-03-01T00:00:00Z",
        trigger: "manual",
        previousAid: "Bprev",
        newAid: "Bnew",
        previousPublicKey: "pk1",
        newPublicKey: "pk2",
        kelSequenceNumber: 1,
        nextKeyHash: "hash1",
      }) + "\n",
    );

    const service = createKeyRotationService({
      logger,
      emit: () => {},
      rotationsPath: rotPath,
    });

    const history = await service.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].trigger).toBe("manual");
  });

  it("stops cleanly", async () => {
    const logger = makeLogger();
    const idPath = join(tmpDir, "identity.json");
    await writeFile(idPath, JSON.stringify(validIdentityWithNextKey()));

    const service = createKeyRotationService({
      logger,
      emit: () => {},
      identityPath: idPath,
    });

    await service.start();
    await service.stop();

    const status = await service.status();
    expect(status.running).toBe(false);
    expect(
      logger.messages.info.some((m) => m.includes("amcp-key-rotation: stopped")),
    ).toBe(true);
  });
});
