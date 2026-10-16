import { AUDIT_CATEGORIES, MEMBER_ROLES } from "@ses/domain";
import type { AuditJson, AuditLogRecord } from "@ses/domain";
import { z } from "zod";

import { timestampSchema } from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for `audit_logs` — T050 Stage E1.
 *
 * Rows are **validated, not trusted**, like every other adapter's: a renamed column or
 * a nullability change has to fail loudly here rather than reach a use case as
 * `undefined`.
 *
 * ## `id` is selected as text, not as a number
 *
 * `id` is `bigint GENERATED ALWAYS AS IDENTITY`, and the driver's own handling of
 * `int8` is exactly the thing this module must not depend on (a `Number` loses
 * precision past 2^53, and a BigInt has no JSON representation). So the repository
 * selects `id::text` and this schema keeps it the decimal spelling it already is —
 * the same choice `EXPENSE_COLUMNS` makes for `amount_paise`, and the same reason.
 *
 * ## `category` and `actor_role` are enums here because the database enforces them
 *
 * `category` has a `CHECK (category IN ('financial','other'))` and `actor_role` is the
 * `public.member_role` type, so a value outside either is a shape bug rather than a
 * forward-compatibility case, and it must fail the parse rather than flow on.
 * `action` and `entity_type` are the opposite: the migration constrains only their
 * *shape* (`varchar` + regex) precisely so a later deploy can record a name this build
 * has not heard of, so they stay plain strings (see `AuditLogRecord`).
 *
 * ## Redaction is not re-applied on the way out
 *
 * `before`/`after`/`metadata` were redacted at the write boundary and again on flush
 * (`redactAuditEntry`), so re-running redaction here would be a third pass over data
 * that already has no secret in it. What this file does check is that the payload is
 * a JSON value — `jsonb` cannot yield anything else, so a mismatch means the column
 * is not the one this schema thinks it is.
 */
const auditJsonSchema = z.custom<AuditJson>(
  (value) =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "object",
);

export const auditLogRowSchema = z.object({
  id: z.string().regex(/^\d+$/),
  occurred_at: timestampSchema,
  category: z.enum(AUDIT_CATEGORIES),
  action: z.string().min(1),
  entity_type: z.string().min(1),
  entity_id: z.uuid().nullable(),
  actor_user_id: z.uuid().nullable(),
  actor_role: z.enum(MEMBER_ROLES).nullable(),
  before: auditJsonSchema,
  after: auditJsonSchema,
  metadata: z.record(z.string(), auditJsonSchema),
});
export type AuditLogRow = z.infer<typeof auditLogRowSchema>;

/**
 * The columns every read returns, in one place.
 *
 * `id::text` is the only expression; everything else is a plain column, because the
 * row is returned to the caller as it is stored. `society_id` is deliberately absent:
 * the tenant is the query's (`where society_id = …`, plus the RLS policy), and echoing
 * it back on every row would invite a client to treat it as data it could send us.
 */
export const AUDIT_LOG_COLUMN_EXPRESSIONS: readonly string[] = [
  "id::text as id",
  "occurred_at",
  "category",
  "action",
  "entity_type",
  "entity_id",
  "actor_user_id",
  "actor_role",
  "before",
  "after",
  "metadata",
];

/** One row → the record the use cases read and the mapper projects. */
export function auditLogFromRow(row: AuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    category: row.category,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    before: row.before,
    after: row.after,
    metadata: row.metadata,
  };
}
