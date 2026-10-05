import { asExpenseId, asMemberId } from "@ses/domain";
import type { ExpenseRevisionRecord } from "@ses/domain";
import { z } from "zod";

import { timestampSchema } from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for `expense_revisions` — Roadmap T068.
 *
 * The same position `split.rows.ts` holds for the publishing path: one file decides
 * every nullability, `jsonb` and timestamp crossing so the repository's single read
 * cannot drift from the shape the route serializes.
 *
 * ## The snapshot is validated as *structure*, never re-modelled
 *
 * `snapshot` is the BEFORE published state the revision replaced (ADR-0009 §17): an
 * `expense` object and a `splits` array, both of which carry the same field names the
 * live row does (`amount_paise` as a digit string, per the money convention). This
 * schema asserts exactly that envelope and leaves the members opaque — the history is
 * what the row says, and a revision written by an older build must still be readable
 * rather than refused by a second, narrower model of it. A snapshot that is **not**
 * that envelope is a shape bug on one side of the boundary, so it fails here.
 *
 * ## Timestamps are read as instants
 *
 * `created_at` is `timestamptz`, so it crosses through the module's own
 * `timestampSchema` (the same one the expense row uses) rather than being handed to a
 * client as a `Date`.
 */
export const expenseRevisionRowSchema = z.object({
  id: z.string(),
  expense_id: z.string(),
  version: z.coerce.number().int(),
  snapshot: z.object({
    expense: z.record(z.string(), z.unknown()),
    splits: z.array(z.record(z.string(), z.unknown())),
  }),
  changed_by: z.string(),
  change_note: z.string().nullable(),
  created_at: timestampSchema,
});

export type ExpenseRevisionRow = z.infer<typeof expenseRevisionRowSchema>;

/** One `expense_revisions` row → the flat record the history route returns. */
export function revisionFromRow(
  row: ExpenseRevisionRow,
): ExpenseRevisionRecord {
  return {
    id: row.id,
    expenseId: asExpenseId(row.expense_id),
    version: row.version,
    snapshot: {
      expense: row.snapshot.expense,
      splits: row.snapshot.splits,
    },
    changedBy: asMemberId(row.changed_by),
    changeNote: row.change_note,
    createdAt: row.created_at,
  };
}
