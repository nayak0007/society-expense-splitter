import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Audit-module error codes — Roadmap T050 Stage E1.
 *
 * Two codes, and the shortness is the design: reading the log is one query with no
 * state machine and no row to address, so there is almost nothing left for this module
 * to refuse. The shared codes this module deliberately does **not** have are as
 * deliberate as the ones it does:
 *
 *  - no `not_found` — the tenant question ("may you know this society exists") is
 *    `SocietyGuard`'s, answered before the handler runs with a 404 that is identical
 *    for a stranger, a soft-deleted society and a nonexistent id. A second answer here
 *    could only disagree with it;
 *  - no `validation` — the only input is `limit` + an opaque cursor. `limit` is the
 *    contract's (clamped, SAD §7.4) and a malformed cursor is refused at the wire edge
 *    by the same opaque-token rule the expense list uses, because a cursor is a client
 *    token rather than a domain value;
 *  - no `conflict`/`invalid_transition` — the log has no writable state to conflict
 *    with. Its rows are append-only and this module never writes one directly; the
 *    reader-audit row goes through the privileged writer inside the read's own
 *    transaction.
 *
 *  - `forbidden` — the caller's membership grants no view of any category
 *    (`auditVisibleCategories` returned nothing). Over HTTP this is unreachable: the
 *    matrix gives Admin full and Treasurer the financial half, and `PermissionGuard`
 *    403s every other role first. It is kept as the fail-closed answer for a direct
 *    caller (a use case invoked from a test or a future job), because the alternative
 *    for an empty category set is a query that reads *everything*;
 *  - `unknown` — an adapter or writer failure the classifier could not place. The API
 *    renders it as 500 `INTERNAL` with a fixed message, which is what keeps a
 *    `42501 permission denied for function write_audit_logs` from reaching a caller as
 *    a privilege disclosure (ADR-0014 D13's failure semantics).
 */
export const AUDIT_ERROR_CODES = ["forbidden", "unknown"] as const;

export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

/** Extends the shared base so generic middleware recognises it by one `instanceof`. */
export class AuditError extends DomainError<AuditErrorCode> {
  constructor(
    code: AuditErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<AuditErrorCode> = { code, message, details };
    super(init);
    this.name = "AuditError";
  }
}

export function isAuditError(error: unknown): error is AuditError {
  return error instanceof AuditError;
}

/** Narrowing helper for `switch` exhaustiveness. */
export function auditErrorCode(error: unknown): AuditErrorCode {
  return isAuditError(error) ? error.code : "unknown";
}

/**
 * Adapter throws → the error type every audit use case promises.
 *
 * A thrown `AuditError` is returned untouched (the reader-audit refusal is one), and
 * anything else — a driver failure, a rolled-back transaction, a `42501` from the
 * privileged writer — becomes `unknown` with a fixed sentence. The original error is
 * deliberately **not** carried on the details: its message is a Postgres message, and
 * the one place it may appear is the server's own log line.
 */
export function asAuditError(error: unknown): AuditError {
  if (isAuditError(error)) return error;
  return new AuditError("unknown", "The audit log could not be read.");
}

/** Shorthand used by the rules. */
export function auditError(
  code: AuditErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): AuditError {
  return new AuditError(code, message, details);
}
