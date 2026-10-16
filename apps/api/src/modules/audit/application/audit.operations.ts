import { Inject, Injectable } from "@nestjs/common";
import { listAuditLogs } from "@ses/application";
import { memberSnapshotOf } from "@ses/domain";
import type {
  AuditLogPage,
  AuditLogReader,
  SocietyMembership,
  UserId,
} from "@ses/domain";
import { DEFAULT_PAGE_LIMIT } from "@ses/contracts";
import type { AuditLogListQueryPayload } from "@ses/contracts";

import { decodeAuditCursor } from "./audit-cursor";
import { toAppError } from "./audit-error.mapper";
import { AUDIT_LOG_READER } from "./audit.tokens";

/**
 * The API's view of the audit read use case.
 *
 * **No rules live here.** Which categories a caller may read, whether a refusal is
 * `forbidden`, and what the reader-audit entry records are all `@ses/application`'s
 * (shared with any future consumer), and the ordering, the page size and the cursor are
 * the repository's. This class does the two things that are genuinely specific to HTTP:
 *
 *  1. it supplies the read port from the container rather than as a value;
 *  2. it unwraps `Result` into a value or a thrown `AppError`, because a controller
 *     branching on `ok` per route is the divergence the shared layer exists to prevent.
 *
 * It also turns the wire's opaque cursor into the domain's tuple — the one translation
 * that belongs at this boundary, since the contract deliberately types the cursor as a
 * string a client cannot construct.
 *
 * ## The membership comes from the guard, and only its snapshot reaches the use case
 *
 * `SocietyGuard` resolved the membership from `X-Society-Id` and the token; a request
 * body cannot supply a role here because nothing in this path reads one. The use case
 * receives `memberSnapshotOf(membership)` — the four facts the matrix reads — rather
 * than the aggregate, so no rule can start depending on a field the matrix never
 * mentions.
 */
@Injectable()
export class AuditLogOperations {
  constructor(
    @Inject(AUDIT_LOG_READER) private readonly logs: AuditLogReader,
  ) {}

  async list(
    actor: UserId,
    membership: SocietyMembership,
    query: AuditLogListQueryPayload,
  ): Promise<AuditLogPage> {
    // Decoded before the use case runs, so a malformed cursor is a 422 naming the field
    // rather than a page that silently starts somewhere else. The query is built
    // *outside* the use case's own error mapping for the same reason the expense list
    // does it: this throws an `AppError`, and routing it through the domain classifier
    // would turn a 422 into a 500.
    const cursor =
      query.cursor === undefined ? null : decodeAuditCursor(query.cursor);

    const result = await listAuditLogs(
      { logs: this.logs },
      {
        actor,
        member: memberSnapshotOf(membership),
        limit: query.limit ?? DEFAULT_PAGE_LIMIT,
        cursor,
      },
    );

    if (!result.ok) {
      throw toAppError(result.error);
    }
    return result.value.page;
  }
}
