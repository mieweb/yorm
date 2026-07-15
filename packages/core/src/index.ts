/**
 * @yorm/core — mapping DSL, projection planner, and store contracts.
 *
 * Zero runtime dependencies: pure functions and types only.
 * See packages/core/README.md and the root README for the full design.
 */
export const YORM_CORE_VERSION = "0.1.0";

export * from "./mapping/index.js";
export * from "./planner/index.js";
export * from "./provenance/index.js";
export * from "./stores/index.js";
