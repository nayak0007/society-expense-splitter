import {
  APARTMENT_BASES,
  PAYMENT_SOURCES,
  SPLIT_STRATEGIES,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  expenseError,
  isExpenseError,
  isExpenseStatus,
  paise,
} from "@ses/domain";
import { Money } from "@ses/domain";
import type { ExpenseError, ExpenseRecord } from "@ses/domain";
import { z } from "zod";

import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";
import {
  nullableTimestampSchema,
  timestampSchema,
} from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for the expense rows T065 reads and writes.
 *
 * The same position `category.rows.ts` holds for categories: every nullability
 * difference, `bigint` crossing and SQLSTATE the API can receive is decided here,
 * once, rather than across five repository methods. Rows are **validated, not
 * trusted** — a renamed column or a new `NOT NULL` must fail loudly here rather
 * than reach a use case as `undefined`.
 *
 * ## `amount_paise` is read as text and crossed deliberately
 *
 * `postgres.js` surfaces a `bigint` column under its own rules, and the one thing
 * this module cannot tolerate is a money value passing through a float. So the
 * repository selects `amount_paise::text`, this schema keeps it a digit string,
 * and `expenseFromRow` converts with `BigInt` → `paise()` exactly as every other
 * money path does (ADR-0005's single crossing point). `expense_date::text` gets the
 * same treatment for a different reason: the column is `date`, not an instant, and
 * a `Date` object would reintroduce the timezone the product never wants on it.
 */
export const expenseRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  category_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  amount_paise: z.string().regex(/^\d+$/),
  expense_date: z.string(),
  vendor_name: z.string().nullable(),
  payment_source: z.enum(PAYMENT_SOURCES),
  paid_by_member_id: z.string().nullable(),
  split_strategy: z.enum(SPLIT_STRATEGIES),
  apartment_basis: z.enum(APARTMENT_BASES).nullable(),
  split_config: z.unknown(),
  participant_selector: z.unknown(),
  status: z.string().refine(isExpenseStatus, {
    message: "Unknown expense status returned by the database.",
  }),
  created_by: z.string(),
  published_at: nullableTimestampSchema,
  voided_at: nullableTimestampSchema,
  voided_by: z.string().nullable(),
  void_reason: z.string().nullable(),
  version: z.coerce.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type ExpenseRow = z.infer<typeof expenseRowSchema>;

export const expenseRowListSchema = z.array(expenseRowSchema);

/**
 * A row that did not match its schema. Always a bug on one side of the boundary (a
 * renamed column, a new nullable field), never something the user did — so the
 * copy stays generic and the actionable part is a hint for the operator.
 */
export function unexpectedShapeError(what: string): ExpenseError {
  return expenseError("unknown", "Something went wrong. Please try again.", {
    hint: `Unexpected ${what} shape returned by the database.`,
  });
}

/** One row → the flat record the T065 use cases read and return. */
export function expenseFromRow(row: ExpenseRow): ExpenseRecord {
  return {
    id: asExpenseId(row.id),
    societyId: asSocietyId(row.society_id),
    categoryId: asExpenseCategoryId(row.category_id),
    title: row.title,
    description: row.description,
    amount: Money.fromPaise(paise(BigInt(row.amount_paise))),
    expenseDate: row.expense_date,
    vendorName: row.vendor_name,
    paymentSource: row.payment_source,
    paidByMemberId:
      row.paid_by_member_id === null ? null : asMemberId(row.paid_by_member_id),
    splitStrategy: row.split_strategy,
    apartmentBasis: row.apartment_basis,
    splitConfig: row.split_config,
    participantSelector: row.participant_selector,
    status: row.status,
    createdBy: asMemberId(row.created_by),
    publishedAt: row.published_at,
    voidedAt: row.voided_at,
    voidedBy: row.voided_by === null ? null : asMemberId(row.voided_by),
    voidReason: row.void_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The named exceptions `expense_draft_delete()` and T060's own checks raise.
 *
 * A table for the reason the category one is: every `P0001` refusal arrives on one
 * SQLSTATE and they mean different things, so the stable discriminator is the
 * exception's name — never the interpolated sentence.
 */
export const RAISED_EXCEPTION = {
  expenseNotFound: "EXPENSE_NOT_FOUND",
  expenseNotOwnDraft: "EXPENSE_NOT_OWN_DRAFT",
  expenseNotDraft: "EXPENSE_NOT_DRAFT",
  expenseHasSplits: "EXPENSE_HAS_SPLITS",
  expenseNotPublishable: "EXPENSE_NOT_PUBLISHABLE",
  expenseVersionMismatch: "EXPENSE_VERSION_MISMATCH",
  splitMismatch: "SPLIT_MISMATCH",
} as const;

/**
 * Postgres failure → the expense module's error vocabulary.
 *
 * `context` decides how a `42501` reads, exactly as in the category classifier: on
 * a **read** it is `not_found` (PRD T041 — a non-member cannot tell a foreign
 * society from an absent row), on a **write** the caller passed `SocietyGuard`
 * already, so the only thing RLS can be refusing is their role.
 *
 * The foreign-key branch is the one expenses add over categories: the row
 * references a category and up to four members, and a violated composite FK says
 * *which* reference was wrong through the constraint's name. A member id that is
 * not in the society is a field error (the form can point at `paidByMemberId`); a
 * category that raced away between the use case's read and the insert is the same
 * `not_found` the read would have produced.
 */
export function expenseErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): ExpenseError {
  if (isExpenseError(error)) return error;

  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const hint = candidate.hint;
  const haystack = [
    message,
    candidate.detail,
    candidate.constraint,
    candidate.constraint_name,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");

  const withHint = (): Record<string, unknown> => ({
    code: candidate.code,
    ...(hint === undefined ? {} : { hint }),
  });

  switch (code) {
    case SQLSTATE.notFound:
      // `assert_society_membership`'s P0002 and the function's own are one answer.
      return expenseError(
        "not_found",
        "That expense is not available to you.",
        withHint(),
      );

    case SQLSTATE.forbidden:
      return expenseError(
        "forbidden",
        hint ?? "Only the member who created a draft can delete it.",
        withHint(),
      );

    case SQLSTATE.raised:
      if (message.includes(RAISED_EXCEPTION.expenseNotOwnDraft)) {
        return expenseError(
          "forbidden",
          "Only the member who created a draft can delete it.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseNotDraft)) {
        return expenseError(
          "invalid_transition",
          "Only a draft can be deleted. A published expense is voided instead.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseHasSplits)) {
        return expenseError(
          "conflict",
          "This expense has been split. Void it instead of deleting it.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseNotPublishable)) {
        // The refused *state* travels in the database's `DETAIL` (it read the row
        // under the lock), so the refusal can name it without a second query.
        const from = candidate.detail;
        return expenseError(
          "invalid_transition",
          "Only a draft or an expense awaiting approval can be published.",
          {
            ...withHint(),
            ...(typeof from === "string" && from !== "" ? { from } : {}),
          },
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseVersionMismatch)) {
        // T066's publish lock. `DETAIL` carries the row's current version, which the
        // SAD §7.11 details need; the *expected* one is added by the repository,
        // which is the only place that knows it.
        const current = Number(candidate.detail);
        return expenseError(
          "version_mismatch",
          "This expense was changed by someone else. Reload it and try again.",
          {
            ...withHint(),
            field: "expectedVersion",
            ...(Number.isFinite(current) ? { currentVersion: current } : {}),
          },
        );
      }
      if (message.includes(RAISED_EXCEPTION.splitMismatch)) {
        return expenseError(
          "split_mismatch",
          "The splits do not sum to the expense amount.",
          withHint(),
        );
      }
      return message.includes(RAISED_EXCEPTION.expenseNotFound)
        ? expenseError(
            "not_found",
            "That expense is not available to you.",
            withHint(),
          )
        : expenseError(
            "unknown",
            "Something went wrong. Please try again.",
            withHint(),
          );

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        return expenseError(
          "forbidden",
          "Your session expired. Please sign in again.",
          withHint(),
        );
      }
      return context === "read"
        ? expenseError(
            "not_found",
            "That expense is not available to you.",
            withHint(),
          )
        : expenseError(
            "forbidden",
            "Your role in this society cannot change expenses.",
            withHint(),
          );

    case SQLSTATE.foreignKeyViolation:
      if (/fk_expenses_paid_by|paid_by_member_id/i.test(haystack)) {
        return expenseError(
          "validation",
          "The member who paid is not part of this society.",
          { ...withHint(), field: "paidByMemberId" },
        );
      }
      if (/fk_expenses_category|category_id/i.test(haystack)) {
        return expenseError(
          "not_found",
          "That category is not available to you.",
          withHint(),
        );
      }
      // `created_by`/`voided_by` name a membership of this society; if one of them
      // fails, the society or the member was removed between the guard and this
      // write — the same answer as a foreign society.
      return expenseError(
        "not_found",
        "That society is not available to you.",
        withHint(),
      );

    case SQLSTATE.checkViolation:
      return expenseError("validation", checkViolationMessage(haystack), {
        ...withHint(),
        ...(fieldForCheck(haystack) === undefined
          ? {}
          : { field: fieldForCheck(haystack) }),
      });

    case SQLSTATE.uniqueViolation:
      return expenseError(
        "conflict",
        "That change conflicts with an existing record.",
        withHint(),
      );

    case SQLSTATE.undefinedTable:
      return expenseError(
        "unknown",
        "This part of the app is not available yet. Please try again later.",
        {
          ...withHint(),
          hint: "The expenses table is missing. Apply supabase/migrations/20261001120000_expense_schema.sql.",
        },
      );

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === "read"
      ? expenseError(
          "not_found",
          "That expense is not available to you.",
          withHint(),
        )
      : expenseError(
          "forbidden",
          "Your role in this society cannot change expenses.",
          withHint(),
        );
  }

  return expenseError("unknown", "Something went wrong. Please try again.", {
    code,
    ...(hint === undefined ? {} : { hint }),
  });
}

/** Names the offending field, so a form can highlight it rather than guess. */
function checkViolationMessage(haystack: string): string {
  if (/amount_paise/i.test(haystack)) {
    return "An expense must be greater than ₹0.00.";
  }
  return "Please check the details and try again.";
}

function fieldForCheck(haystack: string): string | undefined {
  return /amount_paise/i.test(haystack) ? "amountPaise" : undefined;
}
