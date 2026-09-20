/**
 * `@ses/domain` — pure domain layer shared by the mobile app and the API.
 *
 * Zero runtime dependencies and no framework imports: this package must
 * compile unchanged for Hermes and for Node (Roadmap: "packages/domain may
 * not import @nestjs/*, drizzle-orm, react, or any provider SDK").
 */

export * from "./shared/ids";

export * from "./society/society";
export * from "./society/join-code";
export * from "./society/errors";
export * from "./society/rules";
export * from "./society/ports";
