/**
 * `@ses/domain` — pure domain layer shared by the mobile app and the API.
 *
 * Zero runtime dependencies and no framework imports: this package must compile
 * unchanged for Hermes and for Node (Roadmap: "packages/domain may not import
 * @nestjs/*, drizzle-orm, react, or any provider SDK").
 *
 * Layout:
 *  - `shared/`  — primitives every module reuses: `Result`, `Clock`, `Paise`,
 *                 branded ids, the `DomainError` base;
 *  - `society/` — the Society module: entity, value objects, rules and the
 *                 repository port.
 *
 * Use cases are deliberately NOT here. They are the application layer
 * (`@ses/application`), which depends on this package and never the other way
 * round; keeping them here would make "domain" mean two layers (SAD §3.1).
 */

export * from "./shared/clock";
export * from "./shared/errors";
export * from "./shared/ids";
export * from "./shared/money";
export * from "./shared/result";

export * from "./society/society";
export * from "./society/join-code";
export * from "./society/errors";
export * from "./society/rules";
export * from "./society/ports";
export * from "./society/value-objects";
