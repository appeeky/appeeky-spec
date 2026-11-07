/**
 * Browser-safe part of Appeeky Spec: schema, limits, lint rules, keyword
 * coverage and diffing. No Node built-ins, so editors can run it in the UI.
 */
export * from "./schema.js";
export * from "./limits.js";
export * from "./text.js";
export * from "./lint.js";
export * from "./coverage.js";
export * from "./storefronts.js";
export * from "./diff.js";
export * from "./suggest.js";
export * from "./verify.js";
export * from "./metrics.js";
export type { FieldChange, PushResult, RemoteState, StoreAdapter } from "./stores/types.js";
