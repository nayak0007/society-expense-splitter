import { randomUUID } from "node:crypto";

import {
  redactAuditPayload,
  type AuditDescriptor,
  type AuditEntry,
  type AuditJson,
} from "@ses/domain";

import { RequestContext } from "../context/request-context";

/**
 * Assembles a persisted `AuditEntry` from a call site's descriptor and the
 * **server-side** request context — T050, ADR-0014 D5.
 *
 * ## Why this is a function and not a request argument
 *
 * The facts an audit row must not be talked out of — who acted, from where, under
 * which request — are precisely the facts a request body must never be able to
 * supply. So they are not parameters: the actor and the membership role come from
 * the `AsyncLocalStorage` store the guard chain populated, and the request id, IP
 * and user agent from the layer that read the raw request once. A call site
 * supplies only what it uniquely knows: which society, which entity, what changed.
 *
 * ## Why it lives in `common/` and not in the audit module
 *
 * `common/` is the shared foundation both the pipeline and the feature modules may
 * depend on (`.dependency-cruiser.js`), and it is where the request context already
 * lives. The audit *module* owns the Nest wiring, the `@Audited()` decorator and
 * the interceptor; the *rule* for turning a descriptor into a row belongs beside
 * the context it reads.
 *
 * ## Redaction is not optional here
 *
 * `before`, `after` and `metadata` all pass through `redactAuditPayload`, so no
 * call site can hand the writer an unredacted object — the returned type is the
 * proof. That also normalises the payload (no `undefined`, no `Date`) into
 * something `jsonb` round-trips identically to what was inspected.
 */
export function buildAuditEntry(descriptor: AuditDescriptor): AuditEntry {
  const metadata: Record<string, unknown> = {
    requestId: RequestContext.requestId(),
    ip: RequestContext.ip(),
    userAgent: RequestContext.userAgent(),
    ...descriptor.metadata,
  };

  return {
    // Generated here rather than at the call site so two call sites cannot disagree
    // about the shape, and so an idempotent replay is an explicit, typed choice
    // (`operationId` in the descriptor) rather than a string the caller built by
    // hand.
    operationId: descriptor.operationId ?? randomUUID(),
    societyId: descriptor.societyId,
    actorUserId: RequestContext.userId() ?? null,
    actorRole: RequestContext.member()?.role ?? null,
    category: descriptor.category,
    action: descriptor.action,
    entityType: descriptor.entityType,
    entityId: descriptor.entityId ?? null,
    before: redactAuditPayload(descriptor.before ?? null),
    after: redactAuditPayload(descriptor.after ?? null),
    // The invariant: `metadata` is a plain object literal, so `redactAuditPayload`
    // returns an object (never a scalar or array). The cast states that rather
    // than re-deriving it with a branch that could never take the other side.
    metadata: redactAuditPayload(metadata) as {
      readonly [key: string]: AuditJson;
    },
  };
}
