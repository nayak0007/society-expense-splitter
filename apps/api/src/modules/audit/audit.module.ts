import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module";
import { AuditService } from "./audit.service";
import { AuditLogOperations } from "./application/audit.operations";
import { AUDIT_LOG_READER } from "./application/audit.tokens";
import { AuditLogRepositoryPostgres } from "./infrastructure/audit-log.repository";
import { AuditLogsController } from "./presentation/audit-logs.controller";

/**
 * The audit feature module — Roadmap T050, ADR-0014.
 *
 * ```text
 * @Audited() ──▶ AuditInterceptor ──▶ AuditService.declare  (declaration)
 *                                        │
 * repositories ──▶ AuditService.entry ───┘
 *                       │
 *                       ▼
 *                  UnitOfWork.transaction(actor, work, audit)   ──▶ write_audit_logs(jsonb)
 *
 * controller ──▶ AuditLogOperations ──▶ AuditLogReader (port, @ses/domain)
 *                                            ▲
 *                                            │
 *                              AuditLogRepositoryPostgres ──▶ `audit_logs` (SELECT)
 *                                            └── the reader-audit entry goes back through the seam above
 * ```
 *
 * ## The read route lives here (T050 Stage E1)
 *
 * This module shipped through Stage D with **no controller**, and the reason it
 * recorded was that `GET /societies/:id/audit-logs` "reads through the table's `SELECT`
 * policy and belongs to the task that builds the screen, not to the appender". Stage E1
 * is that task's first half — the read API and the reader-audit row — so the route
 * arrives here, where the table, the writer and the vocabulary already are. The UI
 * itself remains Phase 4's.
 *
 * The write path and the read path stay distinguishable in the graph: the *appender*
 * (every other module's repositories) reaches `AuditService` and never touches
 * `AuditLogRepositoryPostgres`, while the *reader* is this module's own adapter,
 * exported through `AUDIT_LOG_READER` for the e2e suite to substitute.
 *
 * ## Why `DatabaseModule` is imported, and no feature module is
 *
 * `AuditLogRepositoryPostgres` runs inside `UnitOfWork`, so this module needs the
 * database module — the same explicit import every feature module declares rather than
 * reaching for it globally. It imports **no** feature module, and that is load-bearing:
 * `SocietiesModule`, `MembersModule`, `ExpensesModule` and `AttachmentsModule` all
 * import *this* module for `AuditService`, so importing any of them here would be a
 * module cycle. The one cross-module read this route needs — the caller's membership —
 * is resolved by the global guard chain from `X-Society-Id`, before any handler runs,
 * and arrives through `@Ctx()`: no provider, no import, no cycle.
 *
 * ## Why it exports a service rather than being `@Global()`
 *
 * A module that is global hides its edges: a reader of `MembersModule` could not tell
 * that the member repository records audits. The member, expense, structure, invitation,
 * society and attachment modules import this one explicitly instead, which is the same
 * convention the rest of the graph uses (`ExpensesModule` importing `SocietiesModule`
 * for one provider).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AuditLogsController],
  providers: [
    AuditService,
    AuditLogRepositoryPostgres,
    // `useExisting`, not `useClass`: a suite that substitutes the port must not leave a
    // second, real adapter in the graph — the convention every module's tokens follow.
    { provide: AUDIT_LOG_READER, useExisting: AuditLogRepositoryPostgres },
    AuditLogOperations,
  ],
  exports: [AuditService],
})
export class AuditModule {}
