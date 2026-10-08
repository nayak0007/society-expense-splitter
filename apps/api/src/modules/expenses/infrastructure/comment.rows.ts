import {
  asExpenseCommentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
} from "@ses/domain";
import type { ExpenseCommentRecord } from "@ses/domain";
import { z } from "zod";

import {
  nullableTimestampSchema,
  timestampSchema,
} from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for `expense_comments` — Roadmap T072.
 *
 * The same position `revision.rows.ts` holds: one file decides every nullability
 * and timestamp crossing so the repository and the mapper cannot drift.
 *
 * ## `sequence` crosses as text and becomes an integer
 *
 * `sequence` is a `bigint` identity column and an *ordinal*, not money: it is read
 * as text (the driver's own `bigint` handling never enters) and coerced to a
 * plain integer, which is exact for any stream a society will ever have and keeps
 * the value out of the `paiseToWire` range guard that exists for money alone.
 *
 * ## The timestamps are instants
 *
 * `created_at`/`updated_at`/`deleted_at` are `timestamptz` and cross through the
 * module's own schemas rather than being handed to a client as a `Date`.
 */

export const expenseCommentRowSchema = z.object({
  id: z.string(),
  expense_id: z.string(),
  society_id: z.string(),
  author_id: z.string(),
  body: z.string(),
  sequence: z.coerce.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: nullableTimestampSchema,
  deleted_by: z.string().nullable(),
});
export type ExpenseCommentRow = z.infer<typeof expenseCommentRowSchema>;

/** The columns every read and the two writes return, in one place. */
export const EXPENSE_COMMENT_COLUMN_EXPRESSIONS: readonly string[] = [
  "id",
  "expense_id",
  "society_id",
  "author_id",
  "body",
  "sequence::text as sequence",
  "created_at",
  "updated_at",
  "deleted_at",
  "deleted_by",
];

/** One `expense_comments` row → the flat record the use cases return. */
export function commentFromRow(row: ExpenseCommentRow): ExpenseCommentRecord {
  return {
    id: asExpenseCommentId(row.id),
    expenseId: asExpenseId(row.expense_id),
    societyId: asSocietyId(row.society_id),
    authorId: asMemberId(row.author_id),
    body: row.body,
    sequence: row.sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by === null ? null : asMemberId(row.deleted_by),
  };
}
