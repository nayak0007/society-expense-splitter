/**
 * `audit_logs` — the append-only record of every audited mutation (T050, ADR-0014).
 *
 * The **constraints, indexes, policies, the writer function and the grants live in
 * `supabase/migrations/20261015120000_audit_logs.sql`**, which is the schema's
 * source of truth (ADR-0008). This module describes the same columns for the API's
 * typed queries; the mobile replica does not sync audit rows, so nothing here is
 * part of the offline contract.
 *
 * Four decisions are visible in the column list and worth stating once:
 *
 * 1. **`id` is an identity column, not a uuid.** Audit rows are a stream, and the
 *    gaps an identity leaves when a transaction rolls back are expected rather than
 *    a problem — an audit id is a position in the log, and nothing may infer
 *    "exactly once" from it. Idempotency is `operation_id`'s job (below).
 * 2. **`operation_id` is unique.** A replay of the same operation therefore fails
 *    the insert with `23505`, which rolls the whole transaction back — deliberately
 *    *not* `ON CONFLICT DO NOTHING`, because silently dropping a second audit entry
 *    is how an audit trail stops being evidence (ADR-0014 D4).
 * 3. **`society_id` is `NOT NULL` and its foreign key is `ON DELETE RESTRICT`.**
 *    PRD §11.7's illustrative DDL says nullable + `CASCADE`; SAD §13.7 (7-year
 *    retention, tenant-scoped reads) wins, and the resolution is recorded in
 *    ADR-0014 D2 — a `CASCADE` would delete a society's audit history exactly when
 *    it is most likely to be wanted.
 * 4. **`actor_user_id` is `ON DELETE SET NULL`, and the action is not.** Deleting
 *    the user must not delete the record that they did something; the row keeps the
 *    action, the entity and the timestamp, and loses only the identity link.
 *
 * `before`/`after`/`metadata` are `jsonb` and are persisted **already redacted**
 * (`redactAuditPayload`, `packages/domain/src/audit/audit.ts`) — the column cannot
 * enforce that, so the type at the call site does.
 */

import {
  bigint,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const auditLogs = pgTable("audit_logs", {
  /** Position in the log. `GENERATED ALWAYS AS IDENTITY`; gaps are expected. */
  id: bigint("id", { mode: "bigint" }).primaryKey(),

  societyId: uuid("society_id").notNull(),
  actorUserId: uuid("actor_user_id"),
  /** The actor's role **at the time of the action**, captured from the membership. */
  actorRole: varchar("actor_role", { length: 32 }),

  /** `financial | other` — the split a Treasurer's `audit.view` narrows to. */
  category: varchar("category", { length: 32 }).notNull(),
  /** Dotted action name; the migration constrains the shape with a regex. */
  action: varchar("action", { length: 64 }).notNull(),

  entityType: varchar("entity_type", { length: 32 }).notNull(),
  entityId: uuid("entity_id"),

  /** The row as it was, and as it is, after redaction. `null` means "absent". */
  before: jsonb("before"),
  after: jsonb("after"),
  /** Trusted request facts (request id, IP, user agent) plus recorded extras. */
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),

  /** The idempotency key. `UNIQUE` in the migration; a duplicate fails closed. */
  operationId: uuid("operation_id").notNull(),

  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AuditLogInsert = typeof auditLogs.$inferInsert;
