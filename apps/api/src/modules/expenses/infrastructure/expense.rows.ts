import {
  APARTMENT_BASES,
  PAYMENT_SOURCES,
  SPLIT_STRATEGIES,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  ExpenseError,
  expenseError,
  isExpenseError,
  isExpenseStatus,
  paise,
} from "@ses/domain";
import { Money } from "@ses/domain";
import type { ExpenseRecord, MemberId } from "@ses/domain";
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
 * The workflow columns T070 added — selected only where they exist.
 *
 * They are a schema of their own rather than five more keys on
 * `expenseRowSchema` because the three definer functions
 * (`expense_publish`/`expense_recalculate`/`expense_void`) return the *base* row:
 * their signatures predate T070 and T070 deliberately does not change them (the
 * publication precondition is the only edit, ADR-0011 D4). A plain `expenses`
 * select carries the stamps, an RPC row does not, and the two are told apart by
 * which schema the caller parsed with — never by a silent default.
 */
export const expenseWorkflowRowSchema = z.object({
  approved_by: z.string().nullable(),
  approved_at: nullableTimestampSchema,
  rejected_by: z.string().nullable(),
  rejected_at: nullableTimestampSchema,
  rejection_reason: z.string().nullable(),
});
export type ExpenseWorkflowRow = z.infer<typeof expenseWorkflowRowSchema>;

/** The base row plus its workflow stamps — what a plain `expenses` select returns. */
export const expenseDetailRowSchema = expenseRowSchema.extend(
  expenseWorkflowRowSchema.shape,
);
export type ExpenseDetailRow = z.infer<typeof expenseDetailRowSchema>;

export const expenseDetailRowListSchema = z.array(expenseDetailRowSchema);

/** The five stamps in the module's own vocabulary. */
export interface ExpenseWorkflowStamps {
  readonly approvedBy: MemberId | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: MemberId | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
}

/**
 * "This row carries no workflow stamps" — the honest reading of an RPC row that
 * does not return them, never a claim that the row is unapproved.
 *
 * The three RPC paths do not use it for their response: they read the five columns
 * back in the same transaction (`readExpenseWorkflowStamps`) so a publish/void/
 * recalculation response describes the approval state instead of dropping it. It
 * exists for the parse of a row that genuinely has no such columns.
 */
export const NO_WORKFLOW_STAMPS: ExpenseWorkflowStamps = Object.freeze({
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
});

/** A row that carries the stamps → the module's own shape. */
export function expenseWorkflowStampsOf(
  row: ExpenseWorkflowRow,
): ExpenseWorkflowStamps {
  return {
    approvedBy: row.approved_by === null ? null : asMemberId(row.approved_by),
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by === null ? null : asMemberId(row.rejected_by),
    rejectedAt: row.rejected_at,
    rejectionReason: row.rejection_reason,
  };
}

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

/**
 * Adds the version the caller stated to a lock refusal, so the SAD §7.11 details
 * carry both numbers (`received` and `current`).
 *
 * The definer functions know the *current* version (they read the row under the
 * lock) and not what the caller expected; the repository knows the input. Enriching
 * here is where the two facts meet, and it is deliberately not folded into the
 * classifier — that function reads a database error, which has no `expectedVersion`
 * in it. Shared by all five RPC-backed write paths (`publish`, `recalculate`,
 * `voidExpense`, `approve`, `reject`) so the shape cannot differ between them.
 */
export function enrichVersionMismatch(
  error: unknown,
  expectedVersion: number,
): unknown {
  if (!isExpenseError(error) || error.code !== "version_mismatch") {
    return error;
  }
  if (typeof error.details?.["expectedVersion"] === "number") {
    return error;
  }
  return new ExpenseError(error.code, error.message, {
    ...error.details,
    field: "expectedVersion",
    expectedVersion,
  });
}

/**
 * One row → the flat record the T065 use cases read and return.
 *
 * `workflow` is the second argument rather than a fifth `readonly` on the row
 * because the row shape is the database's and the stamps are T070's concern: an
 * RPC row is parsed by `expenseRowSchema` and its stamps are read beside it, and a
 * plain select is parsed by `expenseDetailRowSchema` and passes them in. With the
 * default the function answers "no stamps", which is exactly what a row without
 * the columns carries.
 */
export function expenseFromRow(
  row: ExpenseRow,
  workflow: ExpenseWorkflowStamps = NO_WORKFLOW_STAMPS,
): ExpenseRecord {
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
    approvedBy: workflow.approvedBy,
    approvedAt: workflow.approvedAt,
    rejectedBy: workflow.rejectedBy,
    rejectedAt: workflow.rejectedAt,
    rejectionReason: workflow.rejectionReason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A row that carries the stamps → the flat record, in one call. */
export function expenseFromDetailRow(row: ExpenseDetailRow): ExpenseRecord {
  return expenseFromRow(row, expenseWorkflowStampsOf(row));
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
  // T070's approval workflow (ADR-0011) — the guard, the publication precondition
  // and the two decision RPCs.
  approvalRequired: "APPROVAL_REQUIRED",
  expenseApproveForbidden: "EXPENSE_APPROVE_FORBIDDEN",
  expenseNotApprovable: "EXPENSE_NOT_APPROVABLE",
  expenseAlreadyApproved: "EXPENSE_ALREADY_APPROVED",
  expenseRejectForbidden: "EXPENSE_REJECT_FORBIDDEN",
  expenseNotRejectable: "EXPENSE_NOT_REJECTABLE",
  expenseRejectionReasonTooShort: "EXPENSE_REJECTION_REASON_TOO_SHORT",
  expenseRejectionReasonInvalid: "EXPENSE_REJECTION_REASON_INVALID",
  expenseNotOwnDraft: "EXPENSE_NOT_OWN_DRAFT",
  expenseNotDraft: "EXPENSE_NOT_DRAFT",
  expenseHasSplits: "EXPENSE_HAS_SPLITS",
  expenseNotPublishable: "EXPENSE_NOT_PUBLISHABLE",
  expenseVersionMismatch: "EXPENSE_VERSION_MISMATCH",
  splitMismatch: "SPLIT_MISMATCH",
  // T068's recalculation refusals (ADR-0009).
  expenseNotRecalculable: "EXPENSE_NOT_RECALCULABLE",
  expenseRecalcFieldNotEditable: "EXPENSE_RECALC_FIELD_NOT_EDITABLE",
  expenseRecalcInvalidField: "EXPENSE_RECALC_INVALID_FIELD",
  duePaidExceedsNewAmount: "DUE_PAID_EXCEEDS_NEW_AMOUNT",
  // T069's void refusals (ADR-0010).
  expenseNotVoidable: "EXPENSE_NOT_VOIDABLE",
  expenseVoidReasonTooShort: "EXPENSE_VOID_REASON_TOO_SHORT",
  expenseVoidReasonInvalid: "EXPENSE_VOID_REASON_INVALID",
  expenseVoidDueStateUnsupported: "EXPENSE_VOID_DUE_STATE_UNSUPPORTED",
  expenseVoidDueKindUnsupported: "EXPENSE_VOID_DUE_KIND_UNSUPPORTED",
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
      // T070 / ADR-0011. Placed first among the `P0001` branches because it is the
      // one every at-or-above-threshold publication can raise, from two different
      // writers (the definer function's precondition and the BEFORE UPDATE guard),
      // and both must answer identically: 409 with the stable `APPROVAL_REQUIRED`
      // detail, never a 500 and never "something went wrong".
      if (message.includes(RAISED_EXCEPTION.approvalRequired)) {
        return expenseError(
          "approval_required",
          "This expense needs an Admin's approval before it can be published.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseApproveForbidden)) {
        return expenseError(
          "forbidden",
          "Only a society Admin can approve an expense.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseRejectForbidden)) {
        return expenseError(
          "forbidden",
          "Only a society Admin can reject an expense.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseAlreadyApproved)) {
        return expenseError(
          "invalid_transition",
          "This expense has already been approved.",
          { ...withHint(), to: "approved" },
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseNotApprovable)) {
        // The refused *state* travels in `DETAIL` (the function read it under the
        // row lock), the same shape `EXPENSE_NOT_PUBLISHABLE` uses.
        const from = candidate.detail;
        return expenseError(
          "invalid_transition",
          "Only an expense awaiting approval can be approved.",
          {
            ...withHint(),
            to: "approved",
            ...(typeof from === "string" && from !== "" ? { from } : {}),
          },
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseNotRejectable)) {
        const from = candidate.detail;
        return expenseError(
          "invalid_transition",
          "Only an expense awaiting approval can be rejected.",
          {
            ...withHint(),
            to: "draft",
            ...(typeof from === "string" && from !== "" ? { from } : {}),
          },
        );
      }
      if (
        message.includes(RAISED_EXCEPTION.expenseRejectionReasonTooShort) ||
        message.includes(RAISED_EXCEPTION.expenseRejectionReasonInvalid)
      ) {
        // The definer function's own re-check of the domain's rule. The message is
        // the domain's wording so the two paths cannot be told apart, and
        // `field: "reason"` is the wire name the form highlights.
        const tooShort = message.includes(
          RAISED_EXCEPTION.expenseRejectionReasonTooShort,
        );
        return expenseError(
          tooShort ? "void_reason_too_short" : "validation",
          tooShort
            ? "Give a reason of at least 10 characters — the creator sees it."
            : "The rejection reason contains characters that are not allowed.",
          { ...withHint(), field: "reason" },
        );
      }
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
      if (message.includes(RAISED_EXCEPTION.expenseNotRecalculable)) {
        // The refused state travels in `DETAIL` (the function read it under the
        // row lock), the same shape `EXPENSE_NOT_PUBLISHABLE` uses.
        const from = candidate.detail;
        return expenseError(
          "invalid_transition",
          "Only a published expense can be recalculated. Drafts are edited and void expenses are final.",
          {
            ...withHint(),
            ...(typeof from === "string" && from !== "" ? { from } : {}),
          },
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseRecalcFieldNotEditable)) {
        return expenseError(
          "validation",
          "A published expense may change only its title, description, vendor, amount, split strategy/basis/configuration, participants or change note.",
          { ...withHint(), field: "body" },
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseRecalcInvalidField)) {
        const field = candidate.detail;
        return expenseError(
          "validation",
          "Please check the details and try again.",
          {
            ...withHint(),
            ...(typeof field === "string" && field !== "" ? { field } : {}),
          },
        );
      }
      if (message.includes(RAISED_EXCEPTION.expenseNotVoidable)) {
        // The refused *state* travels in `DETAIL` (the function read it under the
        // row lock), so a second void can name "void" without a second query.
        const from = candidate.detail;
        return expenseError(
          "invalid_transition",
          "Only a published expense can be voided. A draft is edited or deleted, and a void expense is final.",
          {
            ...withHint(),
            ...(typeof from === "string" && from !== "" ? { from } : {}),
          },
        );
      }
      if (
        message.includes(RAISED_EXCEPTION.expenseVoidReasonTooShort) ||
        message.includes(RAISED_EXCEPTION.expenseVoidReasonInvalid)
      ) {
        // The definer function's own re-check of the domain's rule. The message is
        // the domain's wording (`createVoidReason`) so the two paths cannot be told
        // apart, and `field: "reason"` is the wire name the form highlights.
        return expenseError(
          message.includes(RAISED_EXCEPTION.expenseVoidReasonTooShort)
            ? "void_reason_too_short"
            : "validation",
          message.includes(RAISED_EXCEPTION.expenseVoidReasonTooShort)
            ? "Give a reason of at least 10 characters — residents see it."
            : "The void reason contains characters that are not allowed.",
          { ...withHint(), field: "reason" },
        );
      }
      if (
        message.includes(RAISED_EXCEPTION.expenseVoidDueStateUnsupported) ||
        message.includes(RAISED_EXCEPTION.expenseVoidDueKindUnsupported)
      ) {
        // ADR-0010's fail-closed rule: a current obligation voiding has no
        // accounting rule for refuses the whole operation. The database's own
        // sentence (naming the state or kind) stays in `hint` for an operator; the
        // client gets the stable `DUE_STATE_UNSUPPORTED` detail code.
        return expenseError(
          "void_due_state_unsupported",
          "This expense has an obligation this app cannot reverse yet. Nothing was changed — resolve the obligation first.",
          withHint(),
        );
      }
      if (message.includes(RAISED_EXCEPTION.duePaidExceedsNewAmount)) {
        // ADR-0009 §13: the whole revision was refused atomically. The message is
        // stable and actionable; the database's sentence (with the due id) stays in
        // `hint` for an operator, never as the client's copy.
        return expenseError(
          "paid_obligation",
          "The recalculated obligation would be below a verified payment. Issue a credit adjustment instead.",
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
