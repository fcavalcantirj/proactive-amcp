/**
 * Checkpoint Selector — auto-select best checkpoint for recovery.
 *
 * Scans available checkpoints (per-identity + global + checkpoints dir),
 * scores each by recency, completeness, and integrity, then selects the
 * best candidate. Falls back to older checkpoints when the latest is
 * corrupted. Supports manual CID override.
 *
 * Scoring weights:
 *   - Recency (40%): newer checkpoints score higher, exponential decay
 *   - Completeness (35%): presence of key fields (size, secrets, ontology, soul)
 *   - Integrity (25%): valid CID format, valid timestamp, not corrupted
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { IpfsPinningService } from "../types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHECKPOINTS_DIR = join(homedir(), ".amcp", "checkpoints");
const DEFAULT_LAST_CHECKPOINT_PATH = join(
  homedir(),
  ".amcp",
  "last-checkpoint.json",
);
const DEFAULT_IDENTITY_PATH = join(homedir(), ".amcp", "identity.json");
const DEFAULT_IDENTITIES_DIR = join(homedir(), ".amcp", "identities");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw checkpoint data read from a JSON file. */
export interface CheckpointData {
  cid?: string;
  pinataCid?: string;
  solvrCid?: string;
  timestamp?: string;
  checkpointTimestamp?: string;
  triggerReason?: string;
  size?: number;
  contentSize?: string;
  checkpointSize?: string;
  secretCount?: number;
  type?: string;
  localPath?: string;
  previousCID?: string;
  ontologyGraphCID?: string;
  soulHash?: string;
  pinningService?: string;
}

/** A scored checkpoint candidate for recovery. */
export interface ScoredCheckpoint {
  /** The resolved CID. */
  cid: string;
  /** ISO-8601 timestamp of checkpoint creation. */
  timestamp: string;
  /** Source path the checkpoint was loaded from. */
  sourcePath: string;
  /** Where this checkpoint was found. */
  source: "last-checkpoint" | "per-identity" | "checkpoints-dir";
  /** Overall score (0-1). */
  score: number;
  /** Individual scores for transparency. */
  scores: {
    recency: number;
    completeness: number;
    integrity: number;
  };
  /** Trigger reason, if known. */
  triggerReason?: string;
  /** File size, if known. */
  size?: number;
  /** Pinning service used, if known. */
  pinningService?: string;
  /** Whether checkpoint has integrity issues. */
  corrupted: boolean;
}

/** Options for checkpoint selection. */
export interface CheckpointSelectorOpts {
  /** Path to identity.json. */
  identityPath?: string;
  /** Path to global last-checkpoint.json. */
  lastCheckpointPath?: string;
  /** Path to identities directory (per-identity checkpoints). */
  identitiesDir?: string;
  /** Path to checkpoints directory (local checkpoint files). */
  checkpointsDir?: string;
  /** Manual CID override — if set, only this CID is considered. */
  manualCid?: string;
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHT_RECENCY = 0.40;
const WEIGHT_COMPLETENESS = 0.35;
const WEIGHT_INTEGRITY = 0.25;

/** Half-life for recency decay in hours. After this many hours, score is 0.5. */
const RECENCY_HALF_LIFE_HOURS = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract CID from checkpoint data (tries cid, pinataCid, solvrCid).
 */
function extractCid(data: CheckpointData): string | null {
  if (typeof data.cid === "string" && data.cid.length > 0) return data.cid;
  if (typeof data.pinataCid === "string" && data.pinataCid.length > 0)
    return data.pinataCid;
  if (typeof data.solvrCid === "string" && data.solvrCid.length > 0)
    return data.solvrCid;
  return null;
}

/**
 * Extract timestamp from checkpoint data (tries timestamp, checkpointTimestamp).
 */
function extractTimestamp(data: CheckpointData): string | null {
  if (typeof data.timestamp === "string" && data.timestamp.length > 0)
    return data.timestamp;
  if (
    typeof data.checkpointTimestamp === "string" &&
    data.checkpointTimestamp.length > 0
  )
    return data.checkpointTimestamp;
  return null;
}

/**
 * Check if a string looks like a valid CIDv1 (starts with "bafkrei" or "bafy").
 * Also accepts CIDv0 starting with "Qm".
 */
function isValidCidFormat(cid: string): boolean {
  return /^(bafkrei|bafy|Qm)[a-zA-Z0-9]+$/.test(cid);
}

/**
 * Check if a string is a valid ISO-8601 timestamp.
 */
function isValidTimestamp(ts: string): boolean {
  const d = new Date(ts);
  return !isNaN(d.getTime()) && d.getTime() > 0;
}

/**
 * Compute recency score using exponential decay.
 * Score of 1.0 for "now", 0.5 after half-life, approaches 0 asymptotically.
 */
function scoreRecency(timestamp: string, now: Date): number {
  const ts = new Date(timestamp);
  if (isNaN(ts.getTime())) return 0;
  const ageMs = now.getTime() - ts.getTime();
  if (ageMs < 0) return 1; // future timestamp — treat as most recent
  const ageHours = ageMs / (1000 * 60 * 60);
  return Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);
}

/**
 * Compute completeness score based on presence of key metadata fields.
 * Each field contributes equally to the score.
 */
function scoreCompleteness(data: CheckpointData): number {
  const fields = [
    extractCid(data) !== null, // CID present
    extractTimestamp(data) !== null, // timestamp present
    typeof data.size === "number" || typeof data.contentSize === "string", // size info
    typeof data.secretCount === "number", // secrets counted
    typeof data.ontologyGraphCID === "string", // ontology included
    typeof data.soulHash === "string", // SOUL tracked
    typeof data.type === "string", // type declared
    typeof data.localPath === "string", // local path tracked
  ];
  const present = fields.filter(Boolean).length;
  return present / fields.length;
}

/**
 * Compute integrity score based on data validity checks.
 */
function scoreIntegrity(data: CheckpointData): number {
  let score = 0;
  let checks = 0;

  // CID format validity
  checks++;
  const cid = extractCid(data);
  if (cid && isValidCidFormat(cid)) {
    score++;
  }

  // Timestamp validity
  checks++;
  const ts = extractTimestamp(data);
  if (ts && isValidTimestamp(ts)) {
    score++;
  }

  // JSON structure — if we got here, it parsed fine
  checks++;
  score++; // always passes if data was read

  // No empty CID
  checks++;
  if (cid && cid.length > 10) {
    score++;
  }

  return checks > 0 ? score / checks : 0;
}

/**
 * Determine if a checkpoint is corrupted (missing required fields or invalid data).
 */
function isCorrupted(data: CheckpointData): boolean {
  const cid = extractCid(data);
  if (!cid) return true;
  const ts = extractTimestamp(data);
  if (!ts || !isValidTimestamp(ts)) return true;
  return false;
}

/**
 * Read and parse a checkpoint JSON file. Returns null if unreadable.
 */
async function readCheckpointFile(
  path: string,
): Promise<CheckpointData | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as CheckpointData;
  } catch {
    return null;
  }
}

/**
 * Get AID from identity file.
 */
async function getAid(identityPath: string): Promise<string | null> {
  try {
    const content = await readFile(identityPath, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;
    return typeof data.aid === "string" ? data.aid : null;
  } catch {
    return null;
  }
}

/**
 * Sanitize AID for filesystem use.
 */
function sanitizeAid(aid: string): string {
  return aid.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ---------------------------------------------------------------------------
// Core: gather & score
// ---------------------------------------------------------------------------

/**
 * Gather all available checkpoint candidates from multiple sources.
 */
export async function gatherCheckpoints(
  opts: CheckpointSelectorOpts,
): Promise<
  Array<{ data: CheckpointData; sourcePath: string; source: ScoredCheckpoint["source"] }>
> {
  const identityPath = opts.identityPath ?? DEFAULT_IDENTITY_PATH;
  const lastCheckpointPath =
    opts.lastCheckpointPath ?? DEFAULT_LAST_CHECKPOINT_PATH;
  const identitiesDir = opts.identitiesDir ?? DEFAULT_IDENTITIES_DIR;
  const checkpointsDir = opts.checkpointsDir ?? DEFAULT_CHECKPOINTS_DIR;

  const candidates: Array<{
    data: CheckpointData;
    sourcePath: string;
    source: ScoredCheckpoint["source"];
  }> = [];

  const seenCids = new Set<string>();

  // 1. Per-identity checkpoint (highest priority source)
  const aid = await getAid(identityPath);
  if (aid) {
    const perIdPath = join(
      identitiesDir,
      sanitizeAid(aid),
      "last-checkpoint.json",
    );
    const perIdData = await readCheckpointFile(perIdPath);
    if (perIdData) {
      const cid = extractCid(perIdData);
      if (cid) seenCids.add(cid);
      candidates.push({
        data: perIdData,
        sourcePath: perIdPath,
        source: "per-identity",
      });
    }
  }

  // 2. Global last-checkpoint.json
  const globalData = await readCheckpointFile(lastCheckpointPath);
  if (globalData) {
    const cid = extractCid(globalData);
    if (cid && !seenCids.has(cid)) {
      seenCids.add(cid);
      candidates.push({
        data: globalData,
        sourcePath: lastCheckpointPath,
        source: "last-checkpoint",
      });
    }
  }

  // 3. Checkpoints directory — scan for JSON files with CIDs
  try {
    const dirStat = await stat(checkpointsDir);
    if (dirStat.isDirectory()) {
      const entries = await readdir(checkpointsDir);
      const jsonFiles = entries.filter((e) => e.endsWith(".json"));

      for (const file of jsonFiles) {
        const filePath = join(checkpointsDir, file);
        const fileData = await readCheckpointFile(filePath);
        if (fileData) {
          const cid = extractCid(fileData);
          if (cid && !seenCids.has(cid)) {
            seenCids.add(cid);
            candidates.push({
              data: fileData,
              sourcePath: filePath,
              source: "checkpoints-dir",
            });
          }
        }
      }
    }
  } catch {
    // Directory doesn't exist or unreadable — fine
  }

  return candidates;
}

/**
 * Score a single checkpoint candidate.
 */
export function scoreCheckpoint(
  data: CheckpointData,
  sourcePath: string,
  source: ScoredCheckpoint["source"],
  now?: Date,
): ScoredCheckpoint | null {
  const cid = extractCid(data);
  if (!cid) return null;

  const ts = extractTimestamp(data) ?? new Date().toISOString();
  const currentTime = now ?? new Date();

  const recency = scoreRecency(ts, currentTime);
  const completeness = scoreCompleteness(data);
  const integrity = scoreIntegrity(data);
  const corrupted = isCorrupted(data);

  // Corrupted checkpoints get a heavy penalty but aren't excluded entirely
  const integrityFinal = corrupted ? integrity * 0.1 : integrity;

  const score =
    recency * WEIGHT_RECENCY +
    completeness * WEIGHT_COMPLETENESS +
    integrityFinal * WEIGHT_INTEGRITY;

  return {
    cid,
    timestamp: ts,
    sourcePath,
    source,
    score,
    scores: {
      recency,
      completeness,
      integrity: integrityFinal,
    },
    triggerReason:
      typeof data.triggerReason === "string" ? data.triggerReason : undefined,
    size: typeof data.size === "number" ? data.size : undefined,
    pinningService:
      typeof data.pinningService === "string"
        ? data.pinningService
        : undefined,
    corrupted,
  };
}

/**
 * Select the best checkpoint for recovery.
 *
 * Gathers all available checkpoints, scores them, and returns the highest-
 * scoring non-corrupted candidate. Falls back to corrupted checkpoints
 * only if no clean ones exist.
 *
 * If `manualCid` is provided, returns that specific checkpoint regardless
 * of score (manual override).
 *
 * Returns null if no checkpoints are available.
 */
export async function selectBestCheckpoint(
  opts: CheckpointSelectorOpts & { now?: Date },
): Promise<ScoredCheckpoint | null> {
  const candidates = await gatherCheckpoints(opts);
  if (candidates.length === 0) return null;

  const scored: ScoredCheckpoint[] = [];
  for (const c of candidates) {
    const s = scoreCheckpoint(c.data, c.sourcePath, c.source, opts.now);
    if (s) scored.push(s);
  }

  if (scored.length === 0) return null;

  // Manual CID override — find exact match
  if (opts.manualCid) {
    const manual = scored.find((s) => s.cid === opts.manualCid);
    if (manual) return manual;
    // If manual CID not found locally, return null (can't score unknown checkpoint)
    return null;
  }

  // Prefer non-corrupted checkpoints
  const clean = scored.filter((s) => !s.corrupted);
  const pool = clean.length > 0 ? clean : scored;

  // Sort descending by score
  pool.sort((a, b) => b.score - a.score);

  return pool[0];
}

/**
 * Get all scored checkpoints, sorted by score descending.
 * Useful for showing checkpoint history and selection rationale.
 */
export async function listScoredCheckpoints(
  opts: CheckpointSelectorOpts & { now?: Date },
): Promise<ScoredCheckpoint[]> {
  const candidates = await gatherCheckpoints(opts);
  const scored: ScoredCheckpoint[] = [];

  for (const c of candidates) {
    const s = scoreCheckpoint(c.data, c.sourcePath, c.source, opts.now);
    if (s) scored.push(s);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
