/**
 * The Drizzle schema the API queries through.
 *
 * Table definitions live in `@ses/db-schema` and are re-exported here rather than
 * declared per-module, because the **same** definitions also describe the mobile
 * replica's SQLite subset — two copies would drift, and a drifted column is a
 * sync bug that only appears on a real device.
 *
 * Empty of tables today: the schema's source of truth is the ordered SQL in
 * `supabase/migrations/` applied by the project runner (ADR-0008) — Drizzle is
 * the runtime **query executor** (typed `select`/`insert` over postgres.js) and
 * no longer the schema owner or migrator. Types for the tables land as
 * `@ses/db-schema` grows; the reverse path (ORM → SQL) is exactly what produced
 * the inert migration tooling this ADR replaces.
 */
export * from "@ses/db-schema";
