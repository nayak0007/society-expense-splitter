/**
 * `@ses/contracts` — Zod schemas defining the API contract, shared by the
 * client and the server (SAD §7). Types are always inferred from the schema,
 * never hand-written twice.
 */

export * from "./primitives";
export * from "./common/envelope";
export * from "./common/errors";
export * from "./common/pagination";
export * from "./auth";
export * from "./society";
