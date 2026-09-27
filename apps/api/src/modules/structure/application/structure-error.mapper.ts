import type { ErrorCode, ErrorDetail } from "@ses/contracts";
import type { StructureError, StructureErrorCode } from "@ses/domain";

import { AppError } from "../../../common/errors/app-error";

/**
 * The building module's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * This is the only place the two meet, and they are genuinely different
 * vocabularies: the domain's codes are about *rules* (`conflict`), the catalogue's
 * about *transport* (`CONFLICT` → 409).
 *
 * `Record<StructureErrorCode, ErrorCode>` rather than a `switch`: adding a domain
 * code fails the build here until someone decides what it means over HTTP. A
 * `switch` with `default: "INTERNAL"` would silently answer 500 for a rule that
 * deserved a 409 — which is exactly the bug the society module's classifier
 * carried until a live database found it.
 */
export const ERROR_CODE_BY_STRUCTURE_CODE: Readonly<
  Record<StructureErrorCode, ErrorCode>
> = {
  validation: "VALIDATION_ERROR",
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  // A duplicate building name in one society. 409 rather than 422 because the
  // payload is well-formed and the *state* is what refuses it: the same request
  // succeeds once the other building is renamed, which is what makes it a
  // conflict rather than a validation failure (SAD §7.2).
  conflict: "CONFLICT",
  // A building that still has flats. 409 rather than 422 for the same reason a
  // duplicate name is: the payload was fine and the *state* refused it — the same
  // request succeeds once the flats are removed, which is what makes it a conflict
  // (SAD §7.2). The code is preserved on the wire so a client can tell "rename it"
  // from "empty it first" without matching on message text.
  building_has_apartments: "CONFLICT",
  unknown: "INTERNAL",
};

/**
 * Codes worth preserving verbatim on the wire.
 *
 * `ErrorDetail.code` is a free-form string by design (the validation pipe puts
 * Zod's issue codes there), so a client can branch on `BUILDING_NAME_TAKEN`
 * without the shared catalogue growing a code only one endpoint emits.
 */
const DETAIL_CODES: Readonly<Partial<Record<StructureErrorCode, string>>> = {
  conflict: "BUILDING_NAME_TAKEN",
  building_has_apartments: "BUILDING_HAS_APARTMENTS",
};

/**
 * Translates a domain failure into the exception the filter renders.
 *
 * ## A conflict with no field falls back to `name`
 *
 * The only field-less conflict this module produces is a duplicate building name
 * (`create`/`update` on buildings), and a form has to attach that failure to the
 * input the user typed. Carrying `field: "name"` means the client highlights the
 * right box instead of parsing a message.
 *
 * The fallback is deliberately **not** applied to a code that carried its own
 * field: a duplicate flat number arrives as a `conflict` with
 * `field: 'apartmentNumber'` from the adapter's classifier, and a default applied
 * on top of it would move the error to the wrong input — the exact failure the
 * default exists to prevent, in the other direction.
 */
export function toAppError(error: StructureError): AppError {
  const code = ERROR_CODE_BY_STRUCTURE_CODE[error.code];
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
 * The domain attaches per-field context as `{ field: 'totalFloors' }` for
 * validation failures and `{ hint }`/SQLSTATE for adapter failures. Only a
 * non-empty string is used: `field` must be a path a form can act on, and
 * forwarding `undefined` would produce `"undefined"` in the payload.
 */
function fieldOf(error: StructureError): string | undefined {
  const candidate: unknown = error.details?.field;
  return typeof candidate === "string" && candidate !== ""
    ? candidate
    : undefined;
}
