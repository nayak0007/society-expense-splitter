import type { MemberRole } from "@ses/domain";

/**
 * Recording an authorization refusal — T050 Stage E2, ADR-0014 D14.
 *
 * ## Why this port exists beside the guard
 *
 * `PermissionGuard` is the one place in the chain that knows all four facts a refusal
 * entry needs — the resolved society, the verified actor, the role the matrix refused
 * and the action the route declared — and it is also where the refusal is *decided*.
 * Anything downstream (the exception filter, an interceptor) sees the decision only
 * after it has been turned into a status code, and would have to re-read the request to
 * reconstruct the facts.
 *
 * The write itself cannot live here: `apps/api/src/common` is the shared foundation and
 * `.dependency-cruiser.js` forbids it from importing `infrastructure/` or `modules/`, so
 * the transaction seam (`UnitOfWork`) and the audit vocabulary are out of reach by
 * design. So the interface lives here — where the guard is — and the adapter lives in
 * the audit module, exactly as `SocietyAuthorizationReader` does for the society guard.
 *
 * ## Scope: same-society 403-class refusals only
 *
 * Three refusals are deliberately **not** recorded, and each for its own reason
 * (ADR-0014 D14):
 *
 *  - **401, no verified actor.** Unauthenticated traffic must never be able to write to
 *    an immutable, seven-year table; there is also no actor to name, and the row's actor
 *    column would be a claim the caller made about themselves.
 *  - **404, no live membership** (`SocietyGuard`). The whole point of that answer is that
 *    a caller cannot tell a society they are not in from one that does not exist. A row
 *    naming the target society would have to be filed under *that* society — the only
 *    one that exists — so a stranger could write into another tenant's log at request
 *    rate, and that society's Admins would read it. That is a write-amplification vector
 *    on an append-only table, and SAD §7.6's throttler (not yet built) is the prerequisite
 *    for closing it.
 *  - **Validation and business refusals** (422, and the use cases' own 403/404-class
 *    answers inside a transaction). Those are per-request input or state judgements, not
 *    permission decisions, and recording them would mean a second transaction written
 *    after a rolled-back business one — the exception D14 grants to exactly one class.
 *
 * What remains is the class this port is for: an **authenticated member of this society**
 * whose role (or membership status) does not allow the action the route declared.
 */
export type PermissionRefusalReason = "role_denied" | "member_inactive";

/**
 * One authorization refusal, as the guard observed it.
 *
 * Every identity here comes from the guard chain's own resolution — the actor from the
 * verified token, the society and role from the membership the database returned. Nothing
 * in it is caller-supplied, and there is deliberately no resource id: the guard runs
 * before a handler and therefore before any record is addressed, which is also what keeps
 * refusal metadata free of the identifiers a 404 is meant to hide.
 */
export interface PermissionRefusal {
  /** The membership's own society — resolved by `SocietyGuard`, never a header echo. */
  readonly societyId: string;
  /** The verified caller. Re-stamped from the transaction identity by the writer. */
  readonly actorUserId: string;
  /** The role that was refused, at the time of the refusal. */
  readonly actorRole: MemberRole;
  readonly reason: PermissionRefusalReason;
  /** The matrix action the route declared (`expense.publish`) — never a record id. */
  readonly action: string;
  /** The route, as controller and handler names — no path, no parameter, no query. */
  readonly controller: string;
  readonly handler: string;
  /** Trusted request facts, read from the raw request because guards precede the context. */
  readonly requestId: string | undefined;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

/**
 * DI token. An `InjectionToken` string rather than a class, so this interface stays the
 * contract and the audit module decides what satisfies it.
 *
 * Deliberately **not** `@Optional()` at the injection site, for the reason
 * `SOCIETY_AUTHORIZATION_READER` records: an optional recorder would turn a missing
 * provider into "refusals are silently no longer recorded".
 */
export const SECURITY_EVENT_RECORDER = "SECURITY_EVENT_RECORDER";

export interface SecurityEventRecorder {
  /**
   * Persists one refusal, in a transaction of its own, and never throws.
   *
   * "Never throws" is the contract rather than an accident: the caller is about to
   * answer `403` because that is the correct answer, and an audit write that fails must
   * not replace the authorization answer with a `500`. A failure is reported on the
   * logger instead, which is the one place an operator would look for it (D14 records why
   * fail-open is right here and what it costs).
   */
  recordRefusal(refusal: PermissionRefusal): Promise<void>;
}
