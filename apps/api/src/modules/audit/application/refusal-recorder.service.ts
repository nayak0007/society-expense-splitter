import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { AuditEntry } from "@ses/domain";

import type {
  PermissionRefusal,
  PermissionRefusalReason,
  SecurityEventRecorder,
} from "../../../common/authorization/security-event-recorder";
import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";
import { UnitOfWork } from "../../../infrastructure/database/unit-of-work";

/**
 * The refusal record, written through the audit writer — T050 Stage E2, ADR-0014 D14.
 *
 * ## Its own transaction, and that is the whole difference from every other entry
 *
 * A mutation's entry is handed to `UnitOfWork.transaction(actor, work, audit)` so it
 * commits **with** the change it describes (D1). A refusal has no such change: the guard
 * refuses *before* any handler runs, so there is no business transaction to share and
 * nothing to roll back. This service therefore opens the one transaction it needs, writes
 * the one row, and returns — which keeps D1 intact for every mutation and reader entry
 * while giving refusals the separate, narrowly-scoped boundary the decision records.
 *
 * ## Bounded by construction: one row per member, action, reason and hour
 *
 * The `operation_id` is **derived**, not random: a hash of
 * `(society, actor, action, reason, hour)` formatted as a UUID. `uq_audit_logs_operation_id`
 * is `UNIQUE` and the writer has no `ON CONFLICT DO NOTHING`, so a repeat within the same
 * hour raises `23505` and rolls this transaction back — the second refusal is *not*
 * recorded, because it is already represented. That is the intended outcome here (and the
 * only place in this codebase where a duplicate operation id is not a bug), and it is what
 * bounds the write: without a throttler, an unloved route could otherwise be hammered into
 * an unbounded number of rows in a seven-year immutable table.
 *
 * The cost is stated rather than hidden: the row says *that* a refusal happened in that
 * hour, not how many times. A count would need an `UPDATE`, which the table does not allow
 * and must not.
 *
 * ## Fail-open, loudly
 *
 * The guard is about to answer `403`, which is the correct answer whether or not this write
 * succeeds. Making the audit write able to turn that into a `500` would trade a correct
 * refusal for a misleading status and still not restore the missing row, so a failure is
 * logged with everything an operator needs and then swallowed. D14 records the trade-off;
 * nothing here claims the record is guaranteed.
 */
@Injectable()
export class RefusalRecorderService implements SecurityEventRecorder {
  private readonly logger = new Logger(RefusalRecorderService.name);

  constructor(private readonly unitOfWork: UnitOfWork) {}

  async recordRefusal(refusal: PermissionRefusal): Promise<void> {
    const occurredAt = new Date();

    try {
      await this.unitOfWork.transaction(
        { kind: "user", userId: refusal.actorUserId },
        async () => undefined,
        () => [refusalEntry(refusal, occurredAt)],
      );
    } catch (error: unknown) {
      if (asErrorLike(error).code === SQLSTATE.uniqueViolation) {
        // The dedup window did its job: this member was already refused this action in
        // this hour, and the row that is on the table is the record of it.
        return;
      }

      this.logger.error(
        `Could not record the refusal of "${refusal.action}" for user ` +
          `${refusal.actorUserId} in society ${refusal.societyId} ` +
          `(reason ${refusal.reason}, request ${refusal.requestId ?? "unrecorded"}). ` +
          `The caller was still refused. Cause: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }
}

/**
 * The row, assembled here rather than through `buildAuditEntry`.
 *
 * That builder reads the actor, the role and the request facts from the
 * `AsyncLocalStorage` store — which `RequestContextInterceptor` establishes **after**
 * guards run, so at the moment a refusal is decided it does not exist yet and the builder
 * would record a null role and no request id. The guard chain's own resolution is the
 * trusted source at this layer (the actor is the verified token's subject, the society and
 * role come from the membership the database returned), so the facts are passed in
 * explicitly and `flushAudit` re-stamps the actor from the transaction identity on the way
 * out, exactly as it does for every other entry (D5).
 */
function refusalEntry(
  refusal: PermissionRefusal,
  occurredAt: Date,
): AuditEntry {
  return {
    operationId: dedupOperationId(refusal, occurredAt),
    societyId: refusal.societyId,
    actorUserId: refusal.actorUserId,
    actorRole: refusal.actorRole,
    // `other`: a refusal is an access event, not financial state. The same choice
    // `audit.viewed` makes, for the same reason — a Treasurer's narrowed view must not
    // contain the security record of their colleagues' or their own refusals (D13/D14).
    category: "other",
    action: "security.permission_denied",
    entityType: "permission",
    entityId: null,
    before: null,
    after: null,
    metadata: {
      reason: refusal.reason,
      // The matrix action, not the URL: a fixed vocabulary value that says what was
      // refused without carrying a path, a parameter or a record id.
      permission: refusal.action,
      controller: refusal.controller,
      handler: refusal.handler,
      dedupWindow: new Date(hourBucket(occurredAt)).toISOString(),
      requestId: refusal.requestId ?? null,
      ip: refusal.ip ?? null,
      userAgent: refusal.userAgent ?? null,
    },
  };
}

/**
 * The deterministic idempotency key: `(society, actor, action, reason, hour)`.
 *
 * A UUID v5-shaped value derived from a SHA-256 of those five facts. Formatted rather
 * than generated so the column's own type accepts it and so two runs of the same refusal
 * agree without any shared state — the database's unique constraint is the dedup
 * mechanism, and no cache, no Redis key and no counter is involved.
 */
function dedupOperationId(refusal: PermissionRefusal, at: Date): string {
  const seed = [
    "security.permission_denied",
    refusal.societyId,
    refusal.actorUserId,
    refusal.action,
    refusal.reason,
    String(hourBucket(at)),
  ].join("|");

  const bytes = Buffer.from(
    createHash("sha256").update(seed, "utf8").digest().subarray(0, 16),
  );
  // Version 5 and the RFC 4122 variant, so the value is a well-formed UUID rather than
  // 16 arbitrary bytes that happen to parse.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** The start of the hour `at` falls in — the dedup window's own label. */
function hourBucket(at: Date): number {
  return Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    at.getUTCHours(),
  );
}

/** Re-exported so a unit test can name the two reasons without importing the port. */
export type { PermissionRefusalReason };
