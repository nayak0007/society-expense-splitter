import { Controller, Get, Query } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { auditLogListQuerySchema, auditLogPageSchema } from "@ses/contracts";
import type { AuditLogListQueryPayload } from "@ses/contracts";
import { asUserId } from "@ses/domain";

import { ApiSocietyContext } from "../../../common/authorization/api-society-context.decorator";
import {
  Ctx,
  requireActor,
  requireSociety,
  type RequestCtx,
} from "../../../common/decorators/ctx.decorator";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { ZodPipe } from "../../../common/pipes/zod.pipe";
import { envelopeSchemaOf } from "../../../common/swagger/zod-openapi";
import { Audited } from "../audited.decorator";
import { AuditLogOperations } from "../application/audit.operations";
import { auditLogPageToDto } from "./audit-log.mapper";
import { ApiAuditLogErrors } from "./openapi";

/**
 * The audit-log read endpoint — Roadmap T050 Stage E1, PRD §11.7.
 *
 * ## Header-scoped, unlike the PRD's sketch
 *
 * PRD §1857 lists this as `GET /societies/:id/audit-logs`. It ships as
 * `/v1/audit-logs` behind `X-Society-Id`, which is how every module since the society
 * module addresses itself, and the reason is the one `categories.controller.ts` records
 * in full: `SocietyGuard` and `PermissionGuard` are **inert unless a route declares
 * `@RequirePermission(…)`**, and a permission is a *per-membership* grant — so a route
 * that names one is by definition society-scoped, and the header is how it says which
 * society. A `:societyId` path parameter with no declared permission would run with no
 * membership resolution at all. The path is a bare noun (`/audit-logs`) rather than
 * `/societies/audit-logs` for the same reason `/buildings` and `/expense-categories`
 * are: the scope travels in the header, and the PRD's path shape is the document's
 * sketch rather than the shipped convention. The divergence is recorded in ADR-0014
 * D13 and in the T050 status block.
 *
 * ## The permission is the matrix's existing cell, and it narrows
 *
 * `audit.view` is Admin full and Treasurer **financial only** (PRD §2.1). The guard
 * chain evaluates the first half (`can(role, "audit.view")` — a Guest or a Resident is
 * 403 here, and a membership that is not active is 403 `MEMBER_INACTIVE`), and the
 * second half is narrowed by the use case, which asks the same matrix per category
 * (`auditVisibleCategories`) and pushes the answer into the query. Nothing in this file
 * branches on a role: a role check written here would be a second copy of a rule that
 * lives in `@ses/domain` and is mirrored by the table's `SELECT` policy.
 *
 * ## `@Audited("audit.viewed")` describes a write this route really performs
 *
 * Reading the log records an `audit.viewed` row (PRD §11.7's "the log itself records who
 * viewed it"), written through `UnitOfWork`'s audit seam inside the read's own
 * transaction, so the declaration is accurate rather than aspirational. What it buys
 * here is the route inventory's guarantee: the endpoint cannot lose its reader-audit
 * requirement silently, because the manifest asserts this route declares exactly this
 * action.
 *
 * ## Nothing here decides anything
 *
 * The controller parses the query through the contract's own schema, calls one use case
 * through `AuditLogOperations`, and maps the page to a DTO. The visibility decision, the
 * ordering, the page size and the reader-audit entry all live below it — and the tenant
 * comes from the guard's resolved membership, never from the request.
 */
@ApiTags("audit-logs")
@ApiAuditLogErrors()
@ApiSocietyContext()
@Controller("audit-logs")
export class AuditLogsController {
  constructor(private readonly operations: AuditLogOperations) {}

  /**
   * One page of the society's audit history, newest first.
   *
   * Ordered by `(occurred_at DESC, id DESC)` — a total order, so a page boundary cannot
   * skip or repeat a row that shares a millisecond with another. An empty `entries` is a
   * successful answer, not a 404: a young society has a short log, and a Treasurer's
   * `entries` are the financial half of it.
   *
   * The response does **not** include the reader's own `audit.viewed` row: it is written
   * by this request, after the page has been read. It appears on the next request — the
   * next page, or the next visit — which is the semantics ADR-0014 D13 records.
   */
  @Audited("audit.viewed")
  @Get()
  @RequirePermission("audit.view")
  @ApiOperation({
    summary: "Read a society's audit log",
    description:
      "One page of the society named in X-Society-Id, newest first (occurred_at, then id descending), with a base64 cursor for the next page. An Admin reads the whole log; a Treasurer reads only `financial` entries, because PRD §2.1 grants them that half. Every read records an `audit.viewed` entry in the same transaction, so a read whose audit write fails is an error rather than a successful response. The client's own view entry appears on a later request, never in the response it produced.",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    description: "Opaque cursor from the previous page's `nextCursor`.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Page size; default 20, clamped to 100 (SAD §7.4).",
  })
  @ApiOkResponse({
    description:
      "One page of audit entries, with `nextCursor` and `hasMore`. IP addresses and user agents are never returned.",
    schema: envelopeSchemaOf(auditLogPageSchema),
  })
  async list(
    @Ctx() context: RequestCtx,
    @Query(new ZodPipe(auditLogListQuerySchema))
    query: AuditLogListQueryPayload,
  ) {
    const { userId } = requireActor(context);
    const { membership } = requireSociety(context);
    const page = await this.operations.list(
      asUserId(userId),
      membership,
      query,
    );
    return auditLogPageToDto(page);
  }
}
