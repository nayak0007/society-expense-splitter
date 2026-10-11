import { Module } from "@nestjs/common";

import { AuditService } from "./audit.service";

/**
 * The audit feature module — Roadmap T050, ADR-0014.
 *
 * ```text
 * @Audited() ──▶ AuditInterceptor ──▶ AuditService.declare  (declaration only)
 *                                        │
 * repositories ──▶ AuditService.entry ───┘
 *                       │
 *                       ▼
 *                  UnitOfWork.transaction(actor, work, audit)   ──▶ write_audit_logs(jsonb)
 * ```
 *
 * ## No controller, and no route
 *
 * T050 is infrastructure: it owns no endpoint. `GET /societies/:id/audit-logs`
 * (PRD §1857) reads through the table's `SELECT` policy and belongs to the task
 * that builds the screen, not to the appender. Adding a route here before that
 * screen exists would be an unauthenticated-shaped decision made in the wrong
 * place.
 *
 * ## Why it exports a service rather than being `@Global()`
 *
 * A module that is global hides its edges: a reader of `MembersModule` could not
 * tell that the member repository records audits. The member and expense modules
 * import this one explicitly instead, which is the same convention the rest of the
 * graph uses (`ExpensesModule` importing `SocietiesModule` for one provider).
 */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
