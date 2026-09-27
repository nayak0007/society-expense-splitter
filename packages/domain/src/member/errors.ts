import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Member-module error codes (SAD §7: the API maps these onto HTTP — and to `404`
 * rather than `403` wherever a resource belongs to another tenant, so existence is
 * never leaked to a non-member, PRD §3.2 / T041).
 *
 * A code union per module rather than one global list, matching `StructureError` and
 * `SocietyError`: the API's `Record<MemberErrorCode, ErrorCode>` mapper then *fails
 * the build* when a code gains no HTTP meaning, which is the property that keeps a
 * rule from silently becoming a `500`.
 *
 * `sole_admin` is reused verbatim from the society module, and deliberately: the
 * refusal it names comes from the same database trigger
 * (`chk_admin_present()` → `P0001/SOCIETY_ADMIN_REQUIRED`), so a client that
 * already handles it for `leaveSociety` needs no second case.
 */
export const MEMBER_ERROR_CODES = [
  "validation",
  "not_found",
  "forbidden",
  "conflict",
  "sole_admin",
  /**
   * T046: a role change that would breach a PRD §2.2 cap — at most 2 treasurers, 3 admins.
   *
   * Its own code rather than `conflict`, because the two are different experiences: a conflict
   * means "that value is taken", while this means "that role is full", and the screen's copy (and
   * the alternative it offers) differ. It also has to be machine-distinguishable from the
   * *other* count-based refusal in this module — `sole_admin`, which is about leaving a society
   * with none — so a client can branch without matching a message.
   */
  "role_cap_exceeded",
  /**
   * T049: a decision on a request that is no longer pending.
   *
   * Its own code rather than `conflict`, because the two are different answers: `conflict`
   * says "that value is taken", while this says "that request was already approved, rejected
   * or withdrawn" — and a client that re-fetches after it is looking at the *decision*, which
   * the queue already has. It is also the code a second approval of the same request gets, so
   * a double-tap is a readable refusal rather than a duplicate membership.
   */
  "join_request_not_pending",
  /**
   * T049: the caller tried to decide their own request (`checkJoinRequestReview`).
   *
   * Unreachable through the guard chain today — a pending member holds no `member.approve` —
   * and asserted anyway, because "unreachable" is a property of the current schema rather
   * than of the rule, and the refusal names the thing the user must change: ask another
   * Admin. It is not `forbidden`: that word means "your role is insufficient" everywhere
   * else in this module, and this refusal is about *whose* request it is.
   */
  "self_review",
  /**
   * T049: a role above Resident at admission, requested by somebody who does not hold
   * `member.role_change` (an Admin-only grant).
   *
   * The same rule the invitation path enforces in `stamp_invitation_creator()`, so a
   * Treasurer cannot reach through the join queue what they cannot reach through an
   * invitation — the escalation PRD §13 names.
   */
  "role_not_assignable",
  "unknown",
] as const;

export type MemberErrorCode = (typeof MEMBER_ERROR_CODES)[number];

/**
 * Extends the shared `DomainError` so generic middleware (the API's exception
 * filter, a logging interceptor) recognises every domain failure by one
 * `instanceof`, while member code keeps its narrower `code` union.
 */
export class MemberError extends DomainError<MemberErrorCode> {
  constructor(
    code: MemberErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<MemberErrorCode> = { code, message, details };
    super(init);
    this.name = "MemberError";
  }
}

export function isMemberError(error: unknown): error is MemberError {
  return error instanceof MemberError;
}

/** Narrowing helper for `switch` exhaustiveness in services and screens. */
export function memberErrorCode(error: unknown): MemberErrorCode {
  return isMemberError(error) ? error.code : "unknown";
}

/** Adapter throws → the error type every member use case promises. */
export function asMemberError(error: unknown): MemberError {
  if (isMemberError(error)) return error;
  return new MemberError(
    "unknown",
    "The member operation failed unexpectedly.",
  );
}

/** Shorthand used by the value objects and use cases. */
export function memberError(
  code: MemberErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): MemberError {
  return new MemberError(code, message, details);
}
