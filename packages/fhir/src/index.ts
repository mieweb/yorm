/**
 * @yorm/fhir — FHIR codecs, stable element identity, extension helpers.
 * Implemented in Milestone 5a (see PLAN.md and packages/fhir/README.md).
 */
export const YORM_FHIR_VERSION = "0.1.0";

export * from "./types.js";
export * from "./codecs/resource.js";
export * from "./identity/elementId.js";
export * from "./extensions.js";
