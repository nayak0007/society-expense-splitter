import { Money, paise } from "@ses/domain";
import type { ExpensePublication, ExpenseSplitSummary } from "@ses/domain";
import { z } from "zod";

import { expenseFromRow, expenseRowSchema } from "./expense.rows";
import type { ExpenseRow } from "./expense.rows";

/**
 * The database ⇄ domain boundary for the publishing path — Roadmap T066.
 *
 * `expense.rows.ts` holds the boundary for the `expenses` table; this file holds the
 * two shapes T066 adds to it: the row `expense_publish()` returns (the expense's own
 * columns plus the persisted split summary) and the payload a *stored* idempotency
 * record is replayed through.
 *
 * ## The summary's money arrives as text, like every other amount
 *
 * `expense_publish()` builds `split_summary` with `::text` casts on `sum`/`min`/`max`
 * for the reason `EXPENSE_COLUMNS` casts `amount_paise`: a `bigint` must not pass
 * through a JSON number on its way to a response. The schema therefore pins digits,
 * and `summaryFromRow` performs the single `BigInt` → `paise()` → `Money` crossing
 * every money path in this repository uses (ADR-0005).
 *
 * ## Replay parses the same row shape as the live path
 *
 * A stored record's body is `{ expense, summary }` where `expense` is exactly the row
 * the definer function returned at publication time. Replay re-reads it through the
 * *same* schemas the live path used, so a replayed response cannot be a different
 * shape from the original one — the property the acceptance criterion "replay the
 * same idempotency key and confirm one publish" actually rests on.
 */

/** The PRD §8.3 `splitSummary`, as the definer function returns it. */
export const splitSummaryRowSchema = z.object({
  participantCount: z.coerce.number().int().nonnegative(),
  totalPaise: z.string().regex(/^\d+$/),
  minPaise: z.string().regex(/^\d+$/),
  maxPaise: z.string().regex(/^\d+$/),
});

export type SplitSummaryRow = z.infer<typeof splitSummaryRowSchema>;

/**
 * The row `select … from public.expense_publish(…)` produces.
 *
 * `expenseRowSchema` is a `z.object`, so it strips the extra key rather than
 * refusing it; the `extend` is what keeps the summary from being silently dropped —
 * a publish whose summary did not arrive would otherwise answer `participantCount:
 * undefined` and fail a contract parse at the mapper instead of here.
 */
export const publishedExpenseRowSchema = expenseRowSchema.extend({
  split_summary: splitSummaryRowSchema,
});

export type PublishedExpenseRow = z.infer<typeof publishedExpenseRowSchema>;

/** One stored idempotency record's body, in the shape the API wrote it. */
export const storedPublicationSchema = z.object({
  expense: expenseRowSchema,
  summary: splitSummaryRowSchema,
});

export type StoredPublication = z.infer<typeof storedPublicationSchema>;

/** One row of `idempotency_records`, as the pre-check reads it. */
export const idempotencyRecordRowSchema = z.object({
  request_hash: z.string(),
  response_body: z.unknown(),
});

export type IdempotencyRecordRow = z.infer<typeof idempotencyRecordRowSchema>;

/** The persisted row → the domain's publication facts. */
export function summaryFromRow(row: SplitSummaryRow): ExpenseSplitSummary {
  return {
    participantCount: row.participantCount,
    total: Money.fromPaise(paise(BigInt(row.totalPaise))),
    min: Money.fromPaise(paise(BigInt(row.minPaise))),
    max: Money.fromPaise(paise(BigInt(row.maxPaise))),
  };
}

/**
 * The persisted row → an `ExpensePublication`.
 *
 * `replayed` is the caller's fact, not the row's: the same persisted state is
 * described whether it was just written or read back out of a stored record, and
 * only the caller knows which happened.
 */
export function publicationFromRow(
  row: PublishedExpenseRow,
  replayed: boolean,
): ExpensePublication {
  return {
    expense: expenseFromRow(row),
    summary: summaryFromRow(row.split_summary),
    replayed,
  };
}

/** A stored body, already parsed, as the live path would have produced it. */
export function publicationFromStored(
  stored: StoredPublication,
): ExpensePublication {
  return publicationFromRow(
    { ...stored.expense, split_summary: stored.summary },
    true,
  );
}

/**
 * The body written into `idempotency_records`, built from the row that was just
 * returned.
 *
 * The `split_summary` key is lifted out of the row and stored beside it rather than
 * inside it, so the stored shape and the live shape are the same two facts — and the
 * stored `expense` is the definer function's own row, money as text, dates as
 * strings. Nothing is recomputed: a replay answers what committed.
 */
export function storedPublicationOf(
  row: PublishedExpenseRow,
): StoredPublication {
  const { split_summary: summary, ...expense } = row;
  return { expense: expense as ExpenseRow, summary };
}
