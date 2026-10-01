import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Expense-module error codes — Roadmap T061.
 *
 * The shared codes come first because the module answers the same questions every
 * module does (a malformed field, an impossible state). The rest are this module's
 * own refusals, named in the vocabulary the rest of the system already uses:
 *
 *  - `invalid_transition` — the lifecycle machine. The Roadmap names the class
 *    (`InvalidTransitionError`) rather than the code, and the code keeps that name
 *    so a client that already speaks in transitions needs no translation layer.
 *  - `split_mismatch` — the conservation invariant. The database raises the same
 *    refusal as `P0001` + `SPLIT_MISMATCH` (`supabase/migrations/20261001120000_expense_schema.sql`),
 *    so the domain object and the row agree about *what* went wrong even though
 *    this layer knows nothing about SQLSTATE.
 *  - `void_reason_too_short` — PRD §3.5's "required, min 10 chars", its own code
 *    because the screen that collects it needs a specific message, not a generic
 *    "invalid".
 *
 * T062 adds four, and they are the same four every writable module has plus one of
 * its own:
 *
 *  - `not_found` — "the caller may not know this exists", which the API renders as
 *    `404` rather than `403` because a distinguishable answer lets a caller
 *    enumerate another tenant's vocabulary (SAD §7.2, PRD T041);
 *  - `forbidden` — the caller is an active member whose role is not enough;
 *  - `conflict` — a duplicate category name, well-formed payload but a state that
 *    refuses it;
 *  - `category_has_expenses` — a deletion refused because an expense references the
 *    category. Its own code rather than a `conflict`, for the reason
 *    `building_has_apartments` is: the two need different copy, and collapsing them
 *    would force the UI to match on message text to tell "rename it" from
 *    "deactivate it instead".
 *
 * A union per module rather than one global list, exactly as `InvitationError` and
 * `MemberError` record: the API's `Record<ExpenseErrorCode, ErrorCode>` mapper then
 * *fails the build* when a code gains no HTTP meaning, which is the property that
 * keeps a refusal from silently becoming a `500`.
 */
export const EXPENSE_ERROR_CODES = [
  "validation",
  "invariant",
  "invalid_transition",
  "split_mismatch",
  "void_reason_too_short",
  "not_found",
  "forbidden",
  "conflict",
  "category_has_expenses",
  "unknown",
] as const;

export type ExpenseErrorCode = (typeof EXPENSE_ERROR_CODES)[number];

/**
 * Extends the shared `DomainError` so generic middleware (the API's exception
 * filter, a logging interceptor) recognises every domain failure by one
 * `instanceof`, while expense code keeps its narrower `code` union.
 */
export class ExpenseError extends DomainError<ExpenseErrorCode> {
  constructor(
    code: ExpenseErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<ExpenseErrorCode> = { code, message, details };
    super(init);
    this.name = "ExpenseError";
  }
}

/**
 * A lifecycle move the machine does not have — SAD §3.2's sketch names this class,
 * so it exists as a class rather than a code alone.
 *
 * It carries the two states in `details` (`from`/`to`) because every caller that
 * handles it needs them: an API maps it onto `409`, a screen renders "this expense
 * has already been published", and a test asserts the *pair* rather than a message
 * string. It is a subclass rather than the only error class because the rest of the
 * module's refusals are field and invariant failures with no shape of their own —
 * one class per rule would be five exports where the code union already names the
 * rule.
 */
export class InvalidTransitionError extends ExpenseError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(
      "invalid_transition",
      `An expense cannot move from "${from}" to "${to}".`,
      { from, to },
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isExpenseError(error: unknown): error is ExpenseError {
  return error instanceof ExpenseError;
}

/** Narrowing helper for `switch` exhaustiveness in services and screens. */
export function expenseErrorCode(error: unknown): ExpenseErrorCode {
  return isExpenseError(error) ? error.code : "unknown";
}

/** Adapter throws → the error type every expense use case promises. */
export function asExpenseError(error: unknown): ExpenseError {
  if (isExpenseError(error)) return error;
  return new ExpenseError(
    "unknown",
    "The expense operation failed unexpectedly.",
  );
}

/** Shorthand used by the rules and the entity. */
export function expenseError(
  code: ExpenseErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): ExpenseError {
  return new ExpenseError(code, message, details);
}
