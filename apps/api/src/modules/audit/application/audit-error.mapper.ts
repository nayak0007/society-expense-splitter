import type { ErrorCode } from "@ses/contracts";
import type { AuditError, AuditErrorCode } from "@ses/domain";

import { AppError } from "../../../common/errors/app-error";

/**
 * The audit module's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * Two codes, mapped exhaustively, so adding one to `AUDIT_ERROR_CODES` fails the build
 * here until somebody decides what it means over HTTP — the same reason
 * `ERROR_CODE_BY_EXPENSE_CODE` is a `Record` rather than a `switch`.
 *
 *  - `forbidden` → **403**. The caller's membership grants no view of any category.
 *    Unreachable through the route (the guard chain refuses first), kept because the
 *    use case's fail-closed answer has to mean something if a direct caller meets it.
 *  - `unknown` → **500**. Everything else: a failed reader-audit write (the transaction
 *    rolled back, so the read is not reported as a success), a driver fault, a malformed
 *    row. The message is the module's own fixed sentence — never the Postgres message —
 *    so a `42501 permission denied for function write_audit_logs` cannot tell a caller
 *    that the writer exists, let alone that it refused (ADR-0014 D13).
 */
export const ERROR_CODE_BY_AUDIT_CODE: Readonly<
  Record<AuditErrorCode, ErrorCode>
> = {
  forbidden: "FORBIDDEN",
  unknown: "INTERNAL",
};

/** Translates a domain failure into the exception the filter renders. */
export function toAppError(error: AuditError): AppError {
  return new AppError(ERROR_CODE_BY_AUDIT_CODE[error.code], error.message);
}
