/**
 * `attachments` — one verified reference to one object in the object store
 * (T071, ADR-0012).
 *
 * The **constraints, indexes, policies, helper functions and grants live in
 * `supabase/migrations/20261011120000_attachments.sql`**, which is the schema's
 * source of truth (ADR-0008). This module describes the same columns for the two
 * consumers that need them in TypeScript — the API's typed queries and, later, the
 * mobile replica — so a column has one definition rather than two that drift.
 *
 * Four things are therefore deliberately *not* here, and each is a decision rather
 * than an omission:
 *
 * 1. **A foreign key to `expenses`.** `(entity_type, entity_id)` is polymorphic, so
 *    there is no single table to point at. `supabase/migrations/20261001120000_expense_schema.sql`
 *    is where that tension is recorded, and ADR-0012's Consequences is where the
 *    consequence is owned: the reference is application-enforced, the insert policy
 *    re-asserts the parent's existence, and the draft-deletion path removes the rows
 *    in the same transaction that removes the draft. A `.references()` here would
 *    be a promise the database does not keep.
 * 2. **The uploader's foreign key.** `fk_attachments_uploaded_by
 *    (uploaded_by) → members (id)` is a real constraint, and it is deliberately
 *    *single-column* rather than the `(uploaded_by, society_id)` composite key
 *    `expenses.created_by` uses — `20261013120000_attachments_uploader_fk.sql`
 *    records why: the composite form depends on `uq_members_id_society` and blocks
 *    `20261001120000_expense_schema.sql`'s documented Down block (`2BP01`), the same
 *    trap `20261006120000_member_balances.sql` avoided. The same-society guarantee
 *    is the insert policy's instead, where it is stronger — the uploader must be the
 *    caller's own active membership of the row's own society. It is not described
 *    here because a `.references()` would be a *second*, weaker statement of a rule
 *    the policy already makes exactly, and `./expenses.ts` documents the same trap
 *    for the composite form.
 * 3. **Indexes and CHECK constraints.** `idx_attachments_entity`,
 *    `idx_attachments_society`, `idx_attachments_society_outstanding`,
 *    `uq_attachments_storage_key` and the `chk_attachments_*` checks are all in the
 *    migration, stated once where they are created.
 * 4. **`scan_status` as a Postgres enum.** SAD §10.7's four values are a `varchar`
 *    with a `CHECK` in the migration, not a new enum type. A fourth enum in this
 *    schema would be a fourth thing to alter for a vocabulary PRD §7.4 does not
 *    have at all, and the migration makes the same choice for `dues.kind` —
 *    "a vocabulary of three values that will not grow independently of this table".
 *
 * An attachment row is not versioned content (ADR-0012: "No `expectedVersion`"), so
 * there is no `version` column here and no `auditColumns` spread — only
 * `created_at`/`updated_at`, which the migration's `trg_attachments_touch` keeps.
 */

import { integer, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const attachments = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),

  /** `expense` in T071. `CHECK (entity_type IN ('expense'))` in the migration. */
  entityType: varchar("entity_type", { length: 32 }).notNull(),
  /** The parent expense id. No FK — see the header. */
  entityId: uuid("entity_id").notNull(),

  /** SAD §10.3's key, minted by the server and constrained to the row's own prefix. */
  storageKey: varchar("storage_key", { length: 512 }).notNull(),

  /** Display metadata. Never a storage path, never an authority on the type. */
  originalFilename: varchar("original_filename", { length: 200 }).notNull(),
  mimeType: varchar("mime_type", { length: 80 }).notNull(),
  /** `CHECK (size_bytes > 0)` and the 10 MB global ceiling are in the migration. */
  sizeBytes: integer("size_bytes").notNull(),
  /** Nullable and unpopulated in T071; PRD §7.4 carries them for T073/T132. */
  width: integer("width"),
  height: integer("height"),

  /** SHA-256 of the stored bytes, lowercase hex — `CHECK`ed for shape. */
  checksum: varchar("checksum", { length: 64 }).notNull(),

  uploadedBy: uuid("uploaded_by").notNull(),

  /**
   * SAD §10.7's `pending | clean | infected | failed`. The serving gate reads it
   * and is inert until a scanner is configured (ADR-0012 D3), so in T071 every row
   * this API writes holds `pending` and nothing writes `clean`.
   */
  scanStatus: varchar("scan_status", { length: 16 })
    .notNull()
    .default("pending"),

  /**
   * Null while the upload is an outstanding presign reservation; stamped once
   * completion verified the object. The column the quota read turns on, and the only
   * column an authenticated caller may update (the migration grants
   * `UPDATE (completed_at, updated_at)` and nothing else).
   */
  completedAt: timestamp("completed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
} as const;
