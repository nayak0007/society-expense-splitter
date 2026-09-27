import { asMemberError, err, ok, toMemberView } from "@ses/domain";
import type {
  JoinRequest,
  MemberCapabilities,
  MemberError,
  MemberView,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberContext, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";

/**
 * The join queue: every `pending` membership of the society, newest first, each with the
 * other live members claiming its flat (T049; PRD §3.2's "route it to the Admin with both
 * claims visible").
 *
 * ## Why this is not `listMembers({ status: 'pending' })`
 *
 * The directory already filters by status, and a reviewer can reach the same rows from it.
 * The queue is a different read for two reasons that matter at the decision:
 *
 *  1. **the claims.** `JoinRequest` carries every live membership naming the same flat, so
 *     the collision the PRD is about is visible *before* the Admin opens a flat's page —
 *     the directory row has no such context, and "two claims visible" is the whole rule;
 *  2. **the grant.** The directory is `member.view` (everyone but a Guest); the queue is
 *     `member.approve` (Admin and Treasurer, PRD §2.1's "Approve join requests"). A
 *     Resident can browse the directory, and must not be handed a decision screen.
 *
 * ## 404 before 403, again
 *
 * The context load answers `not_found` for a caller with no live membership — including
 * one whose row was rejected or removed — and the capability check then answers `forbidden`
 * for a live member whose role lacks the grant. The order is the module's rule: a stranger
 * learns nothing about the society, and a Resident learns what their role cannot do.
 */
/**
 * One request as the API and the mobile client render it: contact-redacted rows.
 *
 * `Omit<JoinRequest, 'member' | 'claims'>` rather than a fresh interface, so a field added to
 * the queue's shape cannot silently stop travelling. The redaction happens here (the use case
 * has the viewer) rather than in the repository, which knows only the actor's id.
 */
export type JoinQueueRequest = Omit<JoinRequest, "member" | "claims"> & {
  readonly member: MemberView;
  readonly claims: readonly MemberView[];
};

export interface JoinQueue {
  readonly requests: readonly JoinQueueRequest[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly capabilities: MemberCapabilities;
}

/** The queue's page bounds — the directory's own two numbers, resolved the same way. */
function resolvePage(query: {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}): { readonly limit: number; readonly offset: number } {
  const requested = query.limit ?? 50;
  const limit = Math.min(
    200,
    Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : 50)),
  );
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  return { limit, offset: Number.isFinite(offset) ? offset : 0 };
}

export async function listJoinRequests(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  query: {
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  } = {},
): Promise<Result<JoinQueue, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canApprove",
    "Only an Admin or Treasurer can review join requests.",
  );
  if (!guard.ok) return guard;

  const { limit, offset } = resolvePage(query);

  try {
    const page = await deps.members.listJoinRequests(societyId, actor, {
      limit,
      offset,
    });
    const viewer = loaded.value.viewer;

    return ok({
      // Redacted per row for the same reason the directory is: consent is a property of
      // the member being read, so two requesters on one page can legitimately show
      // different contact detail. The *claims* go through the same treatment — they are
      // other members, and a queue must not become a way around the directory's rule.
      requests: page.requests.map((request) => ({
        member: toMemberView(viewer, request.member),
        claims: request.claims.map((claim) => toMemberView(viewer, claim)),
      })),
      total: page.total,
      limit,
      offset,
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
