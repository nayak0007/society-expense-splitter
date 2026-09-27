import { z } from "zod";

/**
 * Normalising a Postgres timestamp, once.
 *
 * Extracted from the society module's `society.rows.ts` when the building module
 * needed the same three cases. Sharing it is what keeps `Building.createdAt` and
 * `Society.createdAt` the same *shape* on the wire — if the two modules
 * normalised independently, one would eventually emit a `Date` and a client that
 * parsed both would see two types for one field.
 */

/**
 * One canonical timestamp shape.
 *
 * Three serialisations reach this function and all must become the same string:
 * `postgres.js` returns a `timestamptz` column as a JavaScript `Date`, `jsonb`
 * (every RPC snapshot field) carries the same instant as an ISO string, and
 * Postgres's own text form is `2026-09-20 10:00:00+00`. The domain compares
 * against `Date.parse` and renders through `Intl`, so normalising here is what
 * makes an entity's timestamps identical to what a mock and
 * `new Date().toISOString()` produce.
 */
export function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** An instant on a `NOT NULL` column: always an ISO string out. */
export const timestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => toIso(value) ?? "");

/** An instant on a nullable column: `null` in means `null` out. */
export const nullableTimestampSchema = z
  .union([z.string(), z.date(), z.null()])
  .transform((value) => toIso(value));
