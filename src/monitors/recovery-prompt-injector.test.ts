/**
 * Tests for recovery-prompt-injector — verifies prompt generation,
 * checkpoint discovery, identity integration, and event emission.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRecoveryPromptInjector,
  findLatestCheckpoint,
  generateRecoveryPrompt,
} from "./recovery-prompt-injector.js";
import type { PluginLogger, AmcpPluginConfig } from "../types.js";

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

function makeConfig(
  overrides?: Partial<AmcpPluginConfig>,
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
    identity: {
      autoInject: true,
      verifyOnStart: true,
    },
    resurrection: {
      autoDetect: true,
      injectRecoveryPrompt: true,
    },
    ...overrides,
  };
}

/** Write a valid identity.json for tests. */
async function writeIdentity(
  dir: string,
  aid: string = "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z",
  publicKey: string = "IKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z",
): Promise<string> {
  const identityPath = join(dir, "identity.json");
  await writeFile(
    identityPath,
    JSON.stringify({
      aid,
      publicKey,
      created: "2025-06-01T00:00:00Z",
      kel: [{ type: "inception", aid }],
    }),
  );
  return identityPath;
}

/** Write a last-checkpoint.json for tests. */
async function writeCheckpoint(
  path: string,
  cid: string = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenosa",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(path, "..").replace(/\/\.\.$/, ""), { recursive: true });
  // Ensure parent dir is created properly
  const parentDir = path.substring(0, path.lastIndexOf("/"));
  await mkdir(parentDir, { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      cid,
      timestamp: "2025-06-15T12:00:00Z",
      triggerReason: "manual",
      size: 1024,
      pinningService: "solvr",
      ...extra,
    }),
  );
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "amcp-recovery-prompt-test-"));
  await mkdir(join(tmpDir, "amcp"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateRecoveryPrompt
// ---------------------------------------------------------------------------

describe("generateRecoveryPrompt", () => {
  it("includes checkpoint CID in prompt", () => {
    const prompt = generateRecoveryPrompt({
      checkpoint: {
        cid: "bafkreitest123",
        timestamp: "2025-06-15T12:00:00Z",
        source: "last-checkpoint",
      },
      aid: "BTestAid123",
    });

    expect(prompt).toContain("bafkreitest123");
  });

  it("includes agent AID in prompt", () => {
    const prompt = generateRecoveryPrompt({
      checkpoint: {
        cid: "bafkreitest123",
        timestamp: "2025-06-15T12:00:00Z",
        source: "last-checkpoint",
      },
      aid: "BTestAid123",
    });

    expect(prompt).toContain("BTestAid123");
  });

  it("includes canonical loading order steps", () => {
    const prompt = generateRecoveryPrompt({
      checkpoint: {
        cid: "bafkreitest123",
        timestamp: "2025-06-15T12:00:00Z",
        source: "last-checkpoint",
      },
      aid: "BTestAid123",
    });

    expect(prompt).toContain("SOUL.md");
    expect(prompt).toContain("USER.md");
    expect(prompt).toContain("Ontology Schema");
    expect(prompt).toContain("Ontology Graph");
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).toContain("Daily Notes");
    expect(prompt).toContain("TOOLS.md");
    expect(prompt).toContain("[SEAM]");
  });

  it("includes identity verification section", () => {
    const prompt = generateRecoveryPrompt({
      checkpoint: {
        cid: "bafkreitest123",
        timestamp: "2025-06-15T12:00:00Z",
        source: "last-checkpoint",
      },
      aid: "BTestAid123",
    });

    expect(prompt).toContain("Identity Verification");
    expect(prompt).toContain("amcp identity validate");
    expect(prompt).toContain("`BTestAid123`");
  });

  it("includes recovery commands with CID", () => {
    const prompt = generateRecoveryPrompt({
      checkpoint: {
        cid: "bafkreitest123",
        timestamp: "2025-06-15T12:00:00Z",
        source: "last-checkpoint",
      },
      aid: "BTestAid123",
    });

    expect(prompt).toContain("resuscitate.sh --from-cid bafkreitest123");
  });

  it("includes checkpoint timestamp", () => {
    const prompt = generateRecoveryPrompt({
      checkpoint: {
        cid: "bafkreitest123",
        timestamp: "2025-06-15T12:00:00Z",
        source: "last-checkpoint",
      },
      aid: "BTestAid123",
    });

    expect(prompt).toContain("2025-06-15T12:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// findLatestCheckpoint
// ---------------------------------------------------------------------------

describe("findLatestCheckpoint", () => {
  it("finds global last-checkpoint.json", async () => {
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    const identityPath = await writeIdentity(tmpDir);
    await writeCheckpoint(checkpointPath, "bafkreiglobal123");

    const result = await findLatestCheckpoint({
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
    });

    expect(result).not.toBeNull();
    expect(result!.cid).toBe("bafkreiglobal123");
    expect(result!.source).toBe("last-checkpoint");
  });

  it("prefers per-identity checkpoint over global", async () => {
    const aid = "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z";
    const identityPath = await writeIdentity(tmpDir, aid);

    // Global checkpoint
    const globalPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(globalPath, "bafkreiglobal");

    // Per-identity checkpoint
    const sanitizedAid = aid.replace(/[^a-zA-Z0-9_-]/g, "_");
    const perIdDir = join(tmpDir, "identities", sanitizedAid);
    await mkdir(perIdDir, { recursive: true });
    const perIdPath = join(perIdDir, "last-checkpoint.json");
    await writeCheckpoint(perIdPath, "bafkreiperid");

    const result = await findLatestCheckpoint({
      identityPath,
      lastCheckpointPath: globalPath,
      identitiesDir: join(tmpDir, "identities"),
    });

    expect(result).not.toBeNull();
    expect(result!.cid).toBe("bafkreiperid");
    expect(result!.source).toBe("per-identity");
  });

  it("returns null when no checkpoint exists", async () => {
    const identityPath = await writeIdentity(tmpDir);

    const result = await findLatestCheckpoint({
      identityPath,
      lastCheckpointPath: join(tmpDir, "nonexistent.json"),
      identitiesDir: join(tmpDir, "identities"),
    });

    expect(result).toBeNull();
  });

  it("falls back to global when per-identity has no CID", async () => {
    const aid = "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z";
    const identityPath = await writeIdentity(tmpDir, aid);

    // Per-identity checkpoint with empty CID
    const sanitizedAid = aid.replace(/[^a-zA-Z0-9_-]/g, "_");
    const perIdDir = join(tmpDir, "identities", sanitizedAid);
    await mkdir(perIdDir, { recursive: true });
    await writeFile(
      join(perIdDir, "last-checkpoint.json"),
      JSON.stringify({ timestamp: "2025-06-15T12:00:00Z" }),
    );

    // Global with valid CID
    const globalPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(globalPath, "bafkreifallback");

    const result = await findLatestCheckpoint({
      identityPath,
      lastCheckpointPath: globalPath,
      identitiesDir: join(tmpDir, "identities"),
    });

    expect(result).not.toBeNull();
    expect(result!.cid).toBe("bafkreifallback");
    expect(result!.source).toBe("last-checkpoint");
  });

  it("reads pinataCid as fallback CID field", async () => {
    const identityPath = await writeIdentity(tmpDir);
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeFile(
      checkpointPath,
      JSON.stringify({
        pinataCid: "bafkreipinata123",
        timestamp: "2025-06-15T12:00:00Z",
      }),
    );

    const result = await findLatestCheckpoint({
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
    });

    expect(result).not.toBeNull();
    expect(result!.cid).toBe("bafkreipinata123");
  });
});

// ---------------------------------------------------------------------------
// createRecoveryPromptInjector
// ---------------------------------------------------------------------------

describe("createRecoveryPromptInjector", () => {
  it("starts and stops cleanly", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath: join(tmpDir, "identity.json"),
      lastCheckpointPath: join(tmpDir, "last-checkpoint.json"),
    });

    expect(injector.name).toBe("amcp-recovery-prompt-injector");

    await injector.start();
    const status = await injector.status();
    expect(status.running).toBe(true);
    expect(
      (status.details as Record<string, unknown>).service,
    ).toBe("amcp-recovery-prompt-injector");

    await injector.stop();
    const stoppedStatus = await injector.status();
    expect(stoppedStatus.running).toBe(false);
  });

  it("emits recovery-prompt:ready on injectNow with valid checkpoint", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const identityPath = await writeIdentity(tmpDir);
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(checkpointPath, "bafkreiinjected");

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    const result = await injector.injectNow();

    expect(result.injected).toBe(true);
    expect(result.prompt).not.toBeNull();
    expect(result.checkpoint).not.toBeNull();
    expect(result.checkpoint!.cid).toBe("bafkreiinjected");
    expect(result.aid).toBe(
      "BIKu8-00b7dSvokkEcXkP2VZ_IuuSNJk_hW4Wx7_Fc9Z",
    );

    // Check event emitted
    const readyEvent = emitted.find(
      (e) => e.event === "amcp:recovery-prompt:ready",
    );
    expect(readyEvent).toBeDefined();
    expect(readyEvent!.data!.cid).toBe("bafkreiinjected");
    expect(readyEvent!.data!.prompt).toBeDefined();
    expect(typeof readyEvent!.data!.prompt).toBe("string");

    await injector.stop();
  });

  it("prompt includes CID and AID from checkpoint and identity", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const aid = "BMyTestAgent123";
    const identityPath = await writeIdentity(tmpDir, aid, "MyTestAgent123");
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(checkpointPath, "bafkreimyprompt");

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    const result = await injector.injectNow();

    expect(result.prompt).toContain("bafkreimyprompt");
    expect(result.prompt).toContain(aid);
    expect(result.prompt).toContain("Canonical Loading Order");
    expect(result.prompt).toContain("Identity Verification");

    await injector.stop();
  });

  it("emits error when no checkpoint exists", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const identityPath = await writeIdentity(tmpDir);

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath,
      lastCheckpointPath: join(tmpDir, "nonexistent.json"),
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    const result = await injector.injectNow();

    expect(result.injected).toBe(false);
    expect(result.error).toBe("no_checkpoint");
    expect(result.prompt).toBeNull();

    const errorEvent = emitted.find(
      (e) => e.event === "amcp:recovery-prompt:error",
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data!.reason).toBe("no_checkpoint");

    await injector.stop();
  });

  it("emits error when no identity exists", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(checkpointPath, "bafkreinoidentity");

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath: join(tmpDir, "nonexistent-identity.json"),
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    const result = await injector.injectNow();

    expect(result.injected).toBe(false);
    expect(result.error).toBe("no_identity");

    const errorEvent = emitted.find(
      (e) => e.event === "amcp:recovery-prompt:error",
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data!.reason).toBe("no_identity");

    await injector.stop();
  });

  it("respects injectRecoveryPrompt config flag (disabled)", async () => {
    const logger = makeLogger();
    const { emitted, emit } = makeEmitter();

    const identityPath = await writeIdentity(tmpDir);
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(checkpointPath, "bafkreidisabled");

    const config = makeConfig();
    config.resurrection.injectRecoveryPrompt = false;

    const injector = createRecoveryPromptInjector({
      config,
      logger,
      emit,
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    const result = await injector.injectNow();

    expect(result.injected).toBe(false);
    expect(result.prompt).toBeNull();
    expect(emitted).toHaveLength(0);

    // Confirm logger indicates it was disabled
    expect(
      logger.messages.info.some((m) =>
        m.includes("injectRecoveryPrompt disabled"),
      ),
    ).toBe(true);

    await injector.stop();
  });

  it("getLastResult returns null before any injection", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
    });

    expect(injector.getLastResult()).toBeNull();
  });

  it("getLastResult returns result after injection", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const identityPath = await writeIdentity(tmpDir);
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(checkpointPath, "bafkreilastresult");

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    await injector.injectNow();

    const last = injector.getLastResult();
    expect(last).not.toBeNull();
    expect(last!.injected).toBe(true);
    expect(last!.checkpoint!.cid).toBe("bafkreilastresult");

    await injector.stop();
  });

  it("status includes injection details after injection", async () => {
    const logger = makeLogger();
    const { emit } = makeEmitter();

    const identityPath = await writeIdentity(tmpDir);
    const checkpointPath = join(tmpDir, "last-checkpoint.json");
    await writeCheckpoint(checkpointPath, "bafkreistatus");

    const injector = createRecoveryPromptInjector({
      config: makeConfig(),
      logger,
      emit,
      identityPath,
      lastCheckpointPath: checkpointPath,
      identitiesDir: join(tmpDir, "identities"),
      lastRecoveryPath: join(tmpDir, "last-recovery.json"),
    });

    await injector.start();
    await injector.injectNow();

    const status = await injector.status();
    const details = status.details as Record<string, unknown>;
    const lastInjection = details.lastInjection as Record<string, unknown>;

    expect(lastInjection).not.toBeNull();
    expect(lastInjection.injected).toBe(true);
    expect(lastInjection.cid).toBe("bafkreistatus");

    await injector.stop();
  });
});
