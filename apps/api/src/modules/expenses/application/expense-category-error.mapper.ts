import type { ErrorCode, ErrorDetail } from "@ses/contracts";
import type { ExpenseError, ExpenseErrorCode } from "@ses/domain";

import { AppError } from "../../../common/errors/app-error";

/**
 * The expense module's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * This is the only place the two meet, and they are genuinely different vocabularies:
 * the domain's codes are about *rules* (`conflict`), the catalogue's about *transport*
 * (`CONFLICT` → 409).
 *
 * `Record<ExpenseErrorCode, ErrorCode>` rather than a `switch`: adding a domain code
 * fails the build here until someone decides what it means over HTTP. A `switch` with
 * `default: "INTERNAL"` would silently answer 500 for a rule that deserved a 409 —
 * which is exactly the bug the society module's classifier carried until a live
 * database found it.
 *
 * ## The whole expense union is mapped, including the codes no category route can emit
 *
 * `invalid_transition`, `split_mismatch`, `void_reason_too_short` and `invariant`
 * belong to the Expense aggregate's lifecycle (T061) and are unreachable from every
 * route in this module. They are listed anyway because the record is keyed by the
 * module's union rather than by this file's route surface, and a `Partial` with a
 * runtime fallback would be the exact arrangement the record type exists to prevent.
 * The expense lifecycle's own routes (T063+) will reuse them unchanged.
 */
export const ERROR_CODE_BY_EXPENSE_CODE: Readonly<
  Record<ExpenseErrorCode, ErrorCode>
> = {
  validation: "VALIDATION_ERROR",
  // Not input and not a state: the allocations did not sum to the total, which is a
  // bug rather than a caller's mistake. 500 is the honest answer (SAD §7.10).
  invariant: "INTERNAL",
  // The lifecycle machine's own code, already in the catalogue verbatim.
  invalid_transition: "INVALID_TRANSITION",
  split_mismatch: "SPLIT_MISMATCH",
  void_reason_too_short: "VALIDATION_ERROR",
  // "The caller may not know this exists" — the API renders it as 404 rather than 403
  // because a distinguishable answer lets a caller enumerate another tenant's
  // vocabulary (SAD §7.2, PRD T041).
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  // A duplicate category name. 409 rather than 422 because the payload is well-formed
  // and the *state* refuses it: the same request succeeds once the other category is
  // renamed or removed, which is what makes it a conflict rather than a validation
  // failure (SAD §7.2).
  conflict: "CONFLICT",
  // A category an expense still references. 409 for the same reason a duplicate name
  // is — the state refused it — and the code is preserved on the wire so a client can
  // tell "rename it" from "deactivate it instead" without matching on message text.
  category_has_expenses: "CONFLICT",
  unknown: "INTERNAL",
};

/**
 * Codes worth preserving verbatim on the wire.
 *
 * `ErrorDetail.code` is a free-form string by design (the validation pipe puts Zod's
 * issue codes there), so a client can branch on `CATEGORY_NAME_TAKEN` without the
 * shared catalogue growing a code only one endpoint emits — the same arrangement
 * `BUILDING_NAME_TAKEN` and `BUILDING_HAS_APARTMENTS` have.
 */
const DETAIL_CODES: Readonly<Partial<Record<ExpenseErrorCode, string>>> = {
  conflict: "CATEGORY_NAME_TAKEN",
  category_has_expenses: "CATEGORY_HAS_EXPENSES",
};

/**
 * Translates a domain failure into the exception the filter renders.
 *
 * ## A conflict with no field falls back to `name`
 *
 * The only field-less conflict this module produces is a duplicate category name, and
 * a form has to attach that failure to the input the user typed. Carrying
 * `field: "name"` means the client highlights the right box instead of parsing a
 * message.
 *
 * The fallback is deliberately **not** applied to a code that carried its own field:
 * `createCategoryColor` attaches `field: "color"` to a malformed hex, and a default
 * applied on top of it would move the error to the wrong input — the exact failure the
 * default exists to prevent, in the other direction. (`category_has_expenses` carries
 * no field and gets none: there is nothing for a form to highlight.)
 */
export function toAppError(error: ExpenseError): AppError {
  const code = ERROR_CODE_BY_EXPENSE_CODE[error.code];
  const field =
    fieldOf(error) ?? (error.code === "conflict" ? "name" : undefined);
  const detailCode = DETAIL_CODES[error.code];

  const details: readonly ErrorDetail[] | undefined =
    detailCode === undefined
      ? undefined
      : [
          {
            field: field ?? "code",
            code: detailCode,
            message: error.message,
          },
        ];

  return new AppError(code, error.message, {
    ...(field === undefined ? {} : { field }),
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * The domain attaches per-field context as `{ field: 'displayOrder' }` for validation
 * failures and `{ count }`/SQLSTATE for adapter failures. Only a non-empty string is
 * used: `field` must be a path a form can act on, and forwarding `undefined` would
 * produce `"undefined"` in the payload.
 */
function fieldOf(error: ExpenseError): string | undefined {
  const candidate: unknown = error.details?.field;
  return typeof candidate === "string" && candidate !== ""
    ? candidate
    : undefined;
}
