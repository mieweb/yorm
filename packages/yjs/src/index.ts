/**
 * @yorm/yjs — canonical document runtime. Implemented in Milestone 2 (see PLAN.md).
 *
 * Real objects live in a `Y.Doc`; changes trigger projection through a
 * policy-driven scheduler. See packages/yjs/README.md.
 */
export const YORM_YJS_VERSION = "0.1.0";

export * from "./codecs/json.js";
export * from "./scheduler/policy.js";
export * from "./runtime/memory.js";
export * from "./proposals/index.js";
export * from "./createYorm.js";
