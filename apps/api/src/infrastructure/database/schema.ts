/**
 * The Drizzle schema the API knows about.
 *
 * Table definitions live in `@ses/db-schema` and are re-exported here rather than
 * declared per-module, because the **same** definitions also describe the mobile
 * replica's SQLite subset — two copies would drift, and a drifted column is a
 * sync bug that only appears on a real device.
 *
 * Empty of tables today: T017 adds the first ones. `drizzle-kit generate` against
 * a schema with no tables would emit a migration that changes nothing, which is
 * why this file exists now but is not yet wired into `drizzle.config.ts`.
 */
export * from "@ses/db-schema";
