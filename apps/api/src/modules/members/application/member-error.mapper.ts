import type { ErrorCode, ErrorDetail } from "@ses/contracts";
import type { MemberError, MemberErrorCode } from "@ses/domain";

import { AppError } from "../../../common/errors/app-error";

/**
 * The members module's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * This is the only place the two meet, and they are genuinely different vocabularies: the
 * domain's codes are about *rules* (`sole_admin`), the catalogue's about *transport*
 * (`SOCIETY_ADMIN_REQUIRED` → 403).
 *
 * `Record<MemberErrorCode, ErrorCode>` rather than a `switch`: adding a domain code fails the
 * build here until someone decides what it means over HTTP. A `switch` with `default:
 * "INTERNAL"` would silently answer 500 for a rule that deserved a 409 — which is exactly the
 * bug the society module's classifier carried until a live database found it.
 */
export const ERROR_CODE_BY_MEMBER_CODE: Readonly<
  Record<MemberErrorCode, ErrorCode>
> = {
  validation: "VALIDATION_ERROR",
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  conflict: "CONFLICT",
  // The same database trigger (`chk_admin_present()` → `P0001/SOCIETY_ADMIN_REQUIRED`) that
  // the society module reports when the last Admin tries to leave, so a client that already
  // handles it for `leaveSociety` needs no second case — and the same detail code below.
  sole_admin: "SOCIETY_ADMIN_REQUIRED",
  // PRD §2.2's caps (3 admins, 2 treasurers). A conflict rather than a validation error: the
  // request was well formed, the *population* is what refuses it — and the fix is to demote
  // somebody first, not to correct a field. The detail code below is what lets a role picker
  // say which cap and for which role.
  role_cap_exceeded: "CONFLICT",
  // T049: a decision on a request that is no longer pending. A conflict rather than a
  // validation error — the request was well formed, the *state* is what refuses it, and the
  // fix is to look at what the queue already decided.
  join_request_not_pending: "CONFLICT",
  // T049: the caller tried to decide their own request. Forbidden — a well-formed request
  // their role or their ownership of the row does not permit.
  self_review: "FORBIDDEN",
  // T049: a role above Resident from somebody who does not hold `member.role_change`.
  // Forbidden, like every other "your role cannot do this" in this module, and not
  // `VALIDATION_ERROR`: the value is a real role, it is the *caller* the matrix refuses.
  role_not_assignable: "FORBIDDEN",
  unknown: "INTERNAL",
};

/**
 * Codes worth preserving verbatim on the wire.
 *
 * `ErrorDetail.code` is a free-form string by design (the validation pipe puts Zod's issue
 * codes there), so a client can branch on `SOLE_ADMIN` without the shared catalogue growing a
 * code only one module emits.
 */
const DETAIL_CODES: Readonly<Partial<Record<MemberErrorCode, string>>> = {
  sole_admin: "SOLE_ADMIN",
  role_cap_exceeded: "ROLE_CAP_EXCEEDED",
  // T049. The three refusals a decision screen has to tell apart from a generic 403/409: the
  // request is gone, it is the caller's own, or the role is above what their grant reaches.
  join_request_not_pending: "JOIN_REQUEST_NOT_PENDING",
  self_review: "SELF_REVIEW",
  role_not_assignable: "ROLE_NOT_ASSIGNABLE",
};

/**
 * Translates a domain failure into the exception the filter renders.
 *
 * ## Why there is no field fallback here, unlike the structure module
 *
 * `toAppError` for buildings defaults a field-less conflict to `name`, because that module has
 * exactly one field-less conflict (a duplicate building name) and a form has to attach it to
 * an input. This module has several — a duplicate shadow phone, a second primary occupant, a
 * person who is already a member — and they belong to *different* inputs. A default here would
 * move a duplicate-phone error onto the name box, which is the failure the default exists to
 * prevent, in the other direction.
 *
 * So the field travels only when the domain attached one (`memberErrorFromPostgres` and the
 * value objects both do, deliberately), and a failure with no field renders as a banner.
 */
export function toAppError(error: MemberError): AppError {
  const code = ERROR_CODE_BY_MEMBER_CODE[error.code];
  const field = fieldOf(error);
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
 * The domain attaches per-field context as `{ field: 'phone' }` for validation failures and
 * `{ hint }`/SQLSTATE for adapter failures. Only a non-empty string is used: `field` must be a
 * path a form can act on, and forwarding `undefined` would produce `"undefined"` in the
 * payload.
 */
function fieldOf(error: MemberError): string | undefined {
  const candidate: unknown = error.details?.field;
  return typeof candidate === "string" && candidate !== ""
    ? candidate
    : undefined;
}
