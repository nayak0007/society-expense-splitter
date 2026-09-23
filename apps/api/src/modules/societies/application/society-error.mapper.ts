import { AppError } from "../../../common/errors/app-error";
import type { ErrorCode, ErrorDetail } from "@ses/contracts";
import type { SocietyError, SocietyErrorCode } from "@ses/domain";

/**
 * The domain's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * This is the only place the two meet, and they are genuinely different
 * vocabularies: the domain's codes are about *rules* (`sole_admin`), while the
 * catalogue's are about *transport* (`SOCIETY_ADMIN_REQUIRED` → 403). A second
 * mapping would let one endpoint answer differently from another for the same
 * rule, which is exactly what a client branching on `code` cannot tolerate.
 *
 * `Record<SocietyErrorCode, ErrorCode>` rather than a `switch`: adding a domain
 * code fails the build here until someone decides what it means over HTTP. A
 * `switch` with a `default: "INTERNAL"` would silently answer 500 for a rule
 * that deserved a 409.
 */
export const ERROR_CODE_BY_SOCIETY_CODE: Readonly<
  Record<SocietyErrorCode, ErrorCode>
> = {
  validation: "VALIDATION_ERROR",
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  // Both join-code failures are `VALIDATION_ERROR` with `field: "code"`, because
  // the catalogue has no code of its own for them — and adding one is a change
  // to a shared vocabulary (the mobile client branches on it too), not a local
  // convenience. The distinction the client actually needs is preserved in
  // `details[].code`, which is what `ErrorDetail.code` is for.
  join_code_invalid: "VALIDATION_ERROR",
  join_code_expired: "VALIDATION_ERROR",
  already_member: "DUPLICATE_RESOURCE",
  // 403 with an actionable message: the caller is a member, they just are not an
  // Admin — or are the last one and cannot leave yet.
  sole_admin: "SOCIETY_ADMIN_REQUIRED",
  conflict: "CONFLICT",
  unknown: "INTERNAL",
};

/**
 * The domain codes worth preserving verbatim on the wire.
 *
 * `ErrorDetail.code` is a free-form string by design (the validation pipe puts
 * Zod's issue codes there), so a client can branch on `JOIN_CODE_EXPIRED`
 * without the top-level catalogue growing a code that only one endpoint emits.
 */
const DETAIL_CODES: Readonly<Partial<Record<SocietyErrorCode, string>>> = {
  join_code_invalid: "JOIN_CODE_INVALID",
  join_code_expired: "JOIN_CODE_EXPIRED",
  already_member: "ALREADY_MEMBER",
  sole_admin: "SOLE_ADMIN",
};

/**
 * Translates a domain failure into the exception the filter renders.
 *
 * Two things are carried across rather than flattened:
 *  - **`field`**, when the domain attached one (the value objects do this for
 *    per-field validation), so a form can highlight the offending input without
 *    parsing a message;
 *  - **`details[].code`**, for the codes above.
 *
 * The domain `message` is a developer-facing string (the domain documents this)
 * and the app is meant to own user-facing copy — but it is far better than
 * anything this layer could invent, and it is what the mobile client already
 * shows today. It travels as the message.
 */
export function toAppError(error: SocietyError): AppError {
  const code = ERROR_CODE_BY_SOCIETY_CODE[error.code];
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
 * The domain attaches per-field context as `{ field: 'pincode' }` for
 * validation failures and as `{ hint }`/SQLSTATE for adapter failures. Only a
 * non-empty string is used: `field` must be a path a form can act on, and
 * forwarding `undefined` would produce `"undefined"` in the payload.
 */
function fieldOf(error: SocietyError): string | undefined {
  const candidate: unknown = error.details?.field;
  return typeof candidate === "string" && candidate !== ""
    ? candidate
    : undefined;
}
