/**
 * Prompt Injection Scanner — detect injection patterns in memory files.
 *
 * P4-MEM-03: Scan memory files for prompt injection patterns.
 *
 * Defines a set of known prompt injection patterns (case-insensitive),
 * scans file content against them, and returns structured alerts with
 * file location and matched pattern. Integrates with the memory integrity
 * monitor for periodic scanning during poll cycles.
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { PluginLogger } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InjectionPattern {
  /** Human-readable name for this pattern. */
  name: string;
  /** Regex to match against file content (applied with 'gi' flags). */
  pattern: RegExp;
  /** Severity: how dangerous this injection pattern is. */
  severity: "critical" | "high" | "medium";
}

export interface InjectionDetection {
  /** ISO-8601 timestamp of detection. */
  timestamp: string;
  /** Relative file path where the injection was found. */
  filePath: string;
  /** Name of the matched injection pattern. */
  patternName: string;
  /** Severity of the matched pattern. */
  severity: "critical" | "high" | "medium";
  /** The matched text snippet (truncated to 120 chars). */
  matchedText: string;
  /** Line number (1-based) where the match was found. */
  lineNumber: number;
}

export interface InjectionScanResult {
  /** Files that were scanned. */
  scannedFiles: string[];
  /** All detections found across all files. */
  detections: InjectionDetection[];
  /** Human-readable summary. */
  summary: string;
}

export interface InjectionAlert {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Total number of injections found. */
  totalDetections: number;
  /** Detections grouped by file. */
  detections: InjectionDetection[];
  /** Human-readable summary. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Built-in Injection Patterns
// ---------------------------------------------------------------------------

/**
 * Known prompt injection patterns. Case-insensitive matching.
 * Patterns target common injection techniques:
 * - Identity override ("you are now", "act as")
 * - Instruction override ("ignore previous", "disregard")
 * - System prompt extraction ("repeat your", "show me your")
 * - Role manipulation ("new instructions", "override")
 * - Jailbreak attempts ("DAN mode", "developer mode")
 */
export const INJECTION_PATTERNS: InjectionPattern[] = [
  // Identity override — critical
  {
    name: "identity_override",
    pattern: /you are now (?:a |an )?(?:new |different )?/gi,
    severity: "critical",
  },
  {
    name: "identity_reassignment",
    pattern: /from now on,?\s+you (?:are|will be|shall be)/gi,
    severity: "critical",
  },
  {
    name: "persona_injection",
    pattern: /act as (?:a |an )?(?:different |new |my )?/gi,
    severity: "critical",
  },
  {
    name: "pretend_injection",
    pattern: /pretend (?:you are|to be|that you)/gi,
    severity: "critical",
  },

  // Instruction override — critical
  {
    name: "ignore_previous",
    pattern: /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions?|prompts?|rules?|guidelines?)/gi,
    severity: "critical",
  },
  {
    name: "disregard_instructions",
    pattern: /disregard (?:all |any )?(?:your )?(?:previous|prior|above|earlier) (?:instructions?|prompts?|rules?|guidelines?)/gi,
    severity: "critical",
  },
  {
    name: "forget_instructions",
    pattern: /forget (?:all |any )?(?:previous|prior|above|earlier|your) (?:instructions?|prompts?|rules?|guidelines?)/gi,
    severity: "critical",
  },
  {
    name: "override_instructions",
    pattern: /(?:new|updated|revised|override) (?:system )?instructions?:/gi,
    severity: "critical",
  },

  // System prompt extraction — high
  {
    name: "system_prompt_extract",
    pattern: /(?:repeat|show|display|print|reveal|output) (?:your |the )?(?:system )?(?:prompt|instructions?|rules?|guidelines?)/gi,
    severity: "high",
  },
  {
    name: "initial_prompt_extract",
    pattern: /what (?:are|were|is) your (?:initial|original|system|base) (?:prompt|instructions?)/gi,
    severity: "high",
  },

  // Role manipulation — high
  {
    name: "developer_mode",
    pattern: /(?:enable|enter|activate|switch to) (?:developer|dev|debug|admin|root|sudo) mode/gi,
    severity: "high",
  },
  {
    name: "dan_mode",
    pattern: /\bDAN\b.*(?:mode|enabled|activated|jailbreak)/gi,
    severity: "high",
  },
  {
    name: "jailbreak_attempt",
    pattern: /(?:jailbreak|bypass|circumvent|escape) (?:your |the )?(?:safety|restrictions?|filters?|guardrails?|limitations?)/gi,
    severity: "high",
  },

  // Boundary manipulation — high
  {
    name: "end_system_prompt",
    pattern: /(?:END|STOP|EXIT)\s+(?:SYSTEM|PROMPT|INSTRUCTIONS?)\s*(?:>|]|}|\|)/gi,
    severity: "high",
  },
  {
    name: "fake_system_tag",
    pattern: /<\/?(?:system|admin|root|developer|internal)(?:\s[^>]*)?\s*>/gi,
    severity: "high",
  },

  // Context manipulation — medium
  {
    name: "context_reset",
    pattern: /(?:reset|clear|wipe|erase) (?:your |the )?(?:context|memory|conversation|history)/gi,
    severity: "medium",
  },
  {
    name: "hidden_instruction",
    pattern: /\[INST\]|\[\/INST\]|<<SYS>>|<\|im_start\|>|<\|im_end\|>/gi,
    severity: "medium",
  },
  {
    name: "base64_payload",
    pattern: /(?:decode|execute|eval|run)\s+(?:this\s+)?(?:base64|encoded):/gi,
    severity: "medium",
  },
];

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

const DEFAULT_INJECTION_LOG_PATH = join(
  homedir(),
  ".amcp",
  "injection-alerts.jsonl",
);

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Scan a single file's content for prompt injection patterns.
 * Returns all detections found in the content.
 */
export function scanContent(
  content: string,
  filePath: string,
  patterns: InjectionPattern[] = INJECTION_PATTERNS,
): InjectionDetection[] {
  const detections: InjectionDetection[] = [];
  const lines = content.split("\n");
  const now = new Date().toISOString();

  for (const pattern of patterns) {
    // Reset regex state for each file
    const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let match: RegExpExecArray | null;

      // Reset regex for each line
      regex.lastIndex = 0;
      while ((match = regex.exec(line)) !== null) {
        const matchedText = match[0].length > 120
          ? match[0].slice(0, 117) + "..."
          : match[0];

        detections.push({
          timestamp: now,
          filePath,
          patternName: pattern.name,
          severity: pattern.severity,
          matchedText,
          lineNumber: lineIdx + 1,
        });

        // Prevent infinite loops on zero-length matches
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
    }
  }

  return detections;
}

/**
 * Scan multiple memory files for prompt injection patterns.
 * Reads each file from contentDir and scans its content.
 */
export async function scanMemoryFiles(
  contentDir: string,
  filePaths: string[],
  patterns: InjectionPattern[] = INJECTION_PATTERNS,
): Promise<InjectionScanResult> {
  const detections: InjectionDetection[] = [];

  for (const relPath of filePaths) {
    const fullPath = join(contentDir, relPath);
    try {
      const content = await readFile(fullPath, "utf-8");
      const fileDetections = scanContent(content, relPath, patterns);
      detections.push(...fileDetections);
    } catch {
      // File disappeared or unreadable — skip
    }
  }

  const summary = buildInjectionSummary(detections);
  return {
    scannedFiles: filePaths,
    detections,
    summary,
  };
}

/**
 * Build a human-readable summary of injection detections.
 */
export function buildInjectionSummary(
  detections: InjectionDetection[],
): string {
  if (detections.length === 0) return "No injection patterns detected";

  const byFile = new Map<string, InjectionDetection[]>();
  for (const d of detections) {
    const existing = byFile.get(d.filePath) ?? [];
    existing.push(d);
    byFile.set(d.filePath, existing);
  }

  const parts: string[] = [];
  for (const [file, dets] of byFile) {
    const patternNames = [...new Set(dets.map((d) => d.patternName))];
    parts.push(`${file}: ${patternNames.join(", ")}`);
  }

  const critical = detections.filter((d) => d.severity === "critical").length;
  const high = detections.filter((d) => d.severity === "high").length;
  const medium = detections.filter((d) => d.severity === "medium").length;

  const severitySummary = [
    critical > 0 ? `${critical} critical` : "",
    high > 0 ? `${high} high` : "",
    medium > 0 ? `${medium} medium` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return `Prompt injection detected (${severitySummary}): ${parts.join("; ")}`;
}

/**
 * Append an injection alert to the log file (JSONL).
 */
export async function appendInjectionLog(
  logPath: string,
  alert: InjectionAlert,
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(alert) + "\n", "utf-8");
}

/**
 * Process scan results: log to file, call logger, emit event.
 * Returns the alert if detections found, null otherwise.
 */
export async function processInjectionResults(
  result: InjectionScanResult,
  logger: PluginLogger,
  emit: (event: string, data?: Record<string, unknown>) => void,
  logPath: string = DEFAULT_INJECTION_LOG_PATH,
): Promise<InjectionAlert | null> {
  if (result.detections.length === 0) return null;

  const alert: InjectionAlert = {
    timestamp: new Date().toISOString(),
    totalDetections: result.detections.length,
    detections: result.detections,
    summary: result.summary,
  };

  // Log warning
  logger.warn(
    `amcp-memory-integrity: ${result.summary}`,
  );

  // Append to log file
  await appendInjectionLog(logPath, alert);

  // Emit event
  emit("amcp:memory:prompt_injection_detected", {
    totalDetections: result.detections.length,
    detections: result.detections.map((d) => ({
      filePath: d.filePath,
      patternName: d.patternName,
      severity: d.severity,
      matchedText: d.matchedText,
      lineNumber: d.lineNumber,
    })),
    summary: result.summary,
    timestamp: alert.timestamp,
  });

  return alert;
}

export { DEFAULT_INJECTION_LOG_PATH };
