import { AUDIT_CATEGORIES, MEMBER_ROLES } from "@ses/domain";
import { z } from "zod";

import { MAX_PAGE_LIMIT } from "./common/pagination";

/**
 * The audit-log read contract — Roadmap T050 Stage E1, PRD §11.7.
 *
 * ## One page of the log, in the envelope the rest of the API already uses
 *
 * SAD §7.4 sketches a page as `{ data: [...], meta: { nextCursor, hasMore, total } }`
 * and the global `ResponseEnvelopeInterceptor` already produces `{ data, meta }` for
 * every successful response. Returning the SAD's shape *inside* that would make every
 * client unwrap two `data`/`meta` pairs, so the body is the flat object the shipped
 * list route uses instead (`GET /expenses`: `{ expenses, nextCursor, hasMore }`) and
 * the envelope supplies the outer pair. `total` is deliberately absent: it is a
 * `COUNT(*)` over the whole log on every page, which is exactly the unbounded scan the
 * cursor exists to avoid (SAD §7.4: "returned only when cheap").
 *
 * ## The cursor is base64 of `{ occurredAt, id }`
 *
 * The sort tuple is `(occurred_at DESC, id DESC)` — the order the table's own index
 * provides, and a **total** order, so two rows in the same millisecond cannot be
 * skipped or repeated at a page boundary. Clients treat the cursor as a token: it is
 * typed here as an unconstrained string so that changing the tuple stays a
 * server-only change rather than a breaking contract edit.
 *
 * ## Which columns are on the wire, and which are deliberately not
 *
 * The row carries more than a client needs, and the difference is a disclosure
 * decision rather than a mapping detail:
 *
 *  - `ip_address` and `user_agent` — stored in `metadata`, and **never returned**, to
 *    anybody: they are the one pair of fields whose only consumer is an investigator
 *    reading the database, and shipping every society Admin the browsing metadata of
 *    their members would widen the disclosure surface for no product benefit. The ADR
 *    records the decision (D13) and the integration suite asserts the fields are
 *    absent from a real response.
 *  - **display names are not resolved.** `actorUserId` is the stable correlation key;
 *    turning it into a name would join `members`/`auth.users` on every row of every
 *    page, and would turn this endpoint into a PII surface a Guest-scoped future role
 *    could read. A client that wants a name already has the member list.
 *  - `operationId` is **not** returned. It is the writer's idempotency key rather than
 *    a fact about the change, so exposing it would invite a client to key on something
 *    that is explicitly allowed to be meaningless (ADR-0014 D4).
 *
 * ## `action` is a string, not the domain union
 *
 * The union is the *write* vocabulary and it is closed at the call site by the
 * compiler; the column is regex-shaped rather than an enum, so a later deploy may
 * record an action this build has not heard of. Typing the response as the union would
 * make the contract lie about data the server is allowed to return, and would break
 * every client on the day a new action shipped. `isAuditAction` in `@ses/domain` is how
 * a consumer narrows when it wants to switch.
 */

/** `GET /audit-logs` — the cursor and the page size, and nothing else. */
export const auditLogListQuerySchema = z.strictObject({
  /** Base64 of `{ occurredAt, id }` — the sort tuple, opaque to clients. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MAX_PAGE_LIMIT))
    .optional(),
});
export type AuditLogListQueryPayload = z.infer<typeof auditLogListQuerySchema>;

/**
 * One audit row as a reader sees it.
 *
 * Every field below is a persisted, already-redacted column value, except
 * `requestId`, which is lifted out of `metadata` because SAD §7.10 makes it the one
 * identifier support asks a user for.
 */
export const auditLogEntrySchema = z.object({
  /** The row's position in the log, decimal. Gaps are expected (ADR-0014). */
  id: z.string(),
  /** ISO-8601 instant. */
  occurredAt: z.string(),
  /** `financial | other` — which half of the log the row belongs to. */
  category: z.enum(AUDIT_CATEGORIES),
  /** Dotted action name; see the note above on why it is not an enum here. */
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  /** The actor's role at the time of the action, or `null` for a system write. */
  actorRole: z.enum(MEMBER_ROLES).nullable(),
  /** The row before the change, redacted. `null` means the entity did not exist. */
  before: z.json(),
  /** The row after the change, redacted. `null` means the entity was removed. */
  after: z.json(),
  /** The trusted request id, when the write recorded one. */
  requestId: z.string().nullable(),
  /**
   * The stored metadata **minus the internal request facts** (IP, user agent).
   *
   * Kept as an open object rather than spelled field by field because each writer
   * adds its own correlation extras (`expenseId`, `attachmentId`), and a closed schema
   * would make every new writer's metadata a breaking contract change. What it may not
   * contain is enforced at the write boundary, where redaction runs.
   */
  metadata: z.record(z.string(), z.json()),
});
export type AuditLogEntryDto = z.infer<typeof auditLogEntrySchema>;

/** One page, plus the cursor for the next one. */
export const auditLogPageSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  /** `null` on the last page. */
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type AuditLogPageDto = z.infer<typeof auditLogPageSchema>;
