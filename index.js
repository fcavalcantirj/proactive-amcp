// Root entry point — satisfies OpenClaw gateway Tier 2 plugin discovery.
// Without this, the gateway falls through to Tier 3 directory scanning,
// which resolves dist/, src/index.ts, AND vitest.config.ts as separate
// plugin instances (triple-loading → memory bloat → crash).
export { default } from "./dist/index.js";
export * from "./dist/index.js";
