import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The error responses the audit-log read route can return — Roadmap T050 Stage E1.
 *
 * ## Why this file exists for a route with one handler
 *
 * Every other feature module declares its refusals once, at controller level, so a new
 * handler cannot ship with an undocumented failure mode (`expense-categories`,
 * `members`, `attachments`). The read route is one handler today, and it is still worth
 * the file: the generated document is the committed contract
 * (`docs/api/OPENAPI.yaml`, gated by `pnpm contract:drift`), and a route whose only
 * documented answer is `200` describes a service that cannot refuse anything.
 *
 * ## The 404 is one answer covering two cases, deliberately
 *
 * A society that does not exist and one the caller holds no live membership in are
 * answered identically (`SocietyGuard` resolves `X-Society-Id` before the handler runs
 * and throws the same `NOT_FOUND` for both), so a caller cannot enumerate societies
 * they cannot see (PRD T041). There is no third case here: the audit log has no
 * row-addressing path, no soft-deleted subject and no per-expense scoping, which is
 * why the module's error vocabulary has a `not_found`-free set at all
 * (`packages/domain/src/audit/errors.ts` records that omission).
 *
 * ## The 403 names the narrowed cell, and the narrowing is not the guard's
 *
 * `audit.view` is Admin ✅ and Treasurer 🟡 **financial only** (PRD §2.1). The guard
 * evaluates the first half — a Resident, Tenant, Guest or Committee Member is refused
 * here, and a membership that is not active is refused as `MEMBER_INACTIVE` — while the
 * second half is applied by the use case, which asks the same matrix per category and
 * pushes the answer into the query. So a Treasurer's request *succeeds* with a narrowed
 * page rather than failing: this description says what a client can render, and a
 * client that showed a disabled log view to a Treasurer would be wrong.
 *
 * ## The 409 is documented as absent, and that is worth the line
 *
 * The log is append-only and this route writes no addressable row — the `audit.viewed`
 * entry is flushed by the adapter inside the read's own transaction. A client should not
 * build a reload-and-retry path for a version lock that does not exist on a read.
 *
 * ## The 422 class is the cursor and the page size
 *
 * Both are contract-level refusals (`auditLogListQuerySchema`): a `limit` outside the
 * contract's range, and a cursor that is present and unusable — a base64 payload that is
 * not the sort tuple, answered on `field: "cursor"` so a client can clear the one input
 * that is wrong instead of silently starting from the top of the log. An *absent* header
 * is a 400 rather than a 422 (SAD §7.8's syntactic split) and arrives before this route
 * is reached.
 *
 * ## What no status here can describe: a read whose own record failed
 *
 * The reader-audit row commits with the read or the whole transaction rolls back, so a
 * failed flush answers `500 INTERNAL` with the module's fixed sentence — never the
 * driver's message, which would disclose that `write_audit_logs` exists and refused
 * (ADR-0014 D13). It is deliberately not declared on this route: `500` is the shape every
 * route in this API shares for an unclassifiable fault, and documenting it here would
 * imply the read has a failure mode no other route has.
 */
export function ApiAuditLogErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, or one the caller holds no live membership in. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `audit.view` — Admin or Treasurer. A Treasurer's grant is the `financial` half only, so their request succeeds with a narrowed page rather than failing; every other role, and any membership that is not active (`MEMBER_INACTIVE`), is refused here.",
    conflict:
      "Not produced by this route: the log is append-only, and the read addresses no row that could move under it.",
  });
}
