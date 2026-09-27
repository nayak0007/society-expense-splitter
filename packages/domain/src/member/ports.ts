import type { MemberId, SocietyId, UserId } from "../shared/ids";
import type { MemberRole } from "../society/society";

import type {
  CreateMemberInput,
  Member,
  MemberActivation,
  MemberPage,
  MemberQuery,
  UpdateMemberInput,
} from "./member";
import type {
  JoinApprovalInput,
  JoinRequestPage,
  JoinRequestQuery,
} from "./join-requests";

/**
 * Member repository port (Clean Architecture: the domain declares what it needs,
 * infrastructure implements it).
 *
 * Same two deliberate properties as `BuildingRepository` and `SocietyRepository`, and
 * for the same reasons:
 *
 *  - **every method takes `actor` explicitly**, so tenant scope can never be inferred
 *    from ambient state (SAD §1.1: scope comes from the token and the membership, never
 *    from the request body) — and so the adapter can run each statement inside a
 *    transaction whose *identity* is that actor, which is what makes `auth.uid()`
 *    inside the RLS policies resolve to the caller;
 *  - **`societyId` is separate from the row id**, in every method including the ones
 *    already keyed by `id`, so a member of another society is unaddressable rather than
 *    merely unauthorised.
 *
 * Implementations MUST return `null` (or throw `MemberError('not_found')`) for a member
 * the actor may not see, and never `forbidden` — PRD T041: a distinguishable answer lets
 * a caller enumerate another society's people.
 */
export interface MemberRepository {
  /**
   * One page of the directory, with the total the filters produced.
   *
   * The total arrives in the same statement as the page, so "showing 50 of 340" costs
   * no second round trip — which is the whole performance story of this port: one
   * query, with the flat and building labels joined in, rather than a member list
   * followed by a lookup per row (the N+1 the Roadmap's own criteria name).
   */
  list(
    societyId: SocietyId,
    actor: UserId,
    query: MemberQuery,
  ): Promise<MemberPage>;

  /** One live membership of one society, `null` when the actor may not see it. */
  findById(
    id: MemberId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Member | null>;

  /**
   * The **caller's own** membership row, whatever its status.
   *
   * This is the port's answer to "what may this caller do here", and it is a members
   * read rather than the society module's `StructureMembershipReader` on purpose: that
   * reader collapses `inactive` and `rejected` onto `removed` (it must — its own union
   * is three-valued), which would make a *suspended* member indistinguishable from one
   * who left. The member module has to tell them apart: a suspended member should be
   * told their membership is suspended, not that the society does not exist.
   *
   * One indexed lookup on `members_society_user_key`. It returns the row for every
   * status except `removed` — a removed member is not a member, and one answer for
   * "never joined" and "no longer a member" is what keeps the two indistinguishable to
   * the caller as well.
   */
  findViewer(societyId: SocietyId, actor: UserId): Promise<Member | null>;

  /**
   * A live **shadow** member of this society with this phone number, or `null`.
   *
   * Shadow rows specifically, because that is the question the index asks:
   * `uq_members_shadow_phone` covers `user_id IS NULL AND status <> 'removed'`, so two
   * members who both have accounts may share a number — a couple with one phone is a real
   * thing — while one person recorded twice as an occupant is not. Asking a broader
   * question here would refuse a legitimate record the database would have accepted.
   *
   * This exists so the *use case* answers with a typed `conflict` naming the `phone` field,
   * rather than letting the violation arrive as a constraint name the classifier has to
   * recognise. Both paths exist and they must agree: a check-only rule is a rule a bypassed
   * client does not have.
   *
   * `exceptId` lets the update path ask the same question about a phone it is keeping.
   */
  findLiveShadowByPhone(
    societyId: SocietyId,
    phone: string,
    actor: UserId,
    exceptId?: MemberId,
  ): Promise<Member | null>;

  /**
   * Record a member directly — the shadow-member path (PRD §3.3).
   *
   * No `userId`: the row has none until the person signs up, which is the point.
   * The role is not a parameter either; the INSERT policy pins it to `resident` and
   * the status to `active`, so an adapter cannot mint an admin through this door.
   */
  create(
    societyId: SocietyId,
    input: CreateMemberInput,
    actor: UserId,
  ): Promise<Member>;

  /** Patch one membership. Absent fields are left alone; explicit `null`s clear. */
  update(
    id: MemberId,
    societyId: SocietyId,
    input: UpdateMemberInput,
    actor: UserId,
  ): Promise<Member>;

  /**
   * Move a membership between active and suspended.
   *
   * `MemberActivation` rather than `MemberStatus` so approval and rejection cannot be
   * expressed here at all — they belong to the join queue (T049), and a port method that
   * accepted them would invite a second implementation of the approval rule.
   */
  setStatus(
    id: MemberId,
    societyId: SocietyId,
    status: MemberActivation,
    actor: UserId,
  ): Promise<Member>;

  /**
   * Set a membership's role (T046).
   *
   * The *storage* half of a role change, and nothing else: the caps, the self-change refusal, the
   * target's status and the last-admin rule are decided before this is called (the use case) and
   * enforced again underneath (the column grant, `chk_member_self_change()`, the role-cap and
   * admin-presence triggers). An adapter that decided any of them would be a second copy of a
   * rule that already has an owner.
   *
   * `role` is `MemberRole`, not a string: assigning a role is the one write in this module whose
   * *value* is security-relevant, so it travels typed rather than validated at the boundary.
   *
   * Returns the updated membership, so the caller can render the new role without a second read. A
   * member with no live row (removed, another society, or gone) is `not_found` — never `forbidden`,
   * for the reason the port's header gives.
   */
  setRole(
    id: MemberId,
    societyId: SocietyId,
    role: MemberRole,
    actor: UserId,
  ): Promise<Member>;

  /**
   * How many **active** members of this society hold `role`, excluding one row.
   *
   * The count behind PRD §2.2's caps, and it is a count rather than a predicate because the rule
   * is about a population: no single row can see whether a fourth admin is being created. Only
   * `active` memberships count — a suspended treasurer does not hold a slot, or a society that
   * suspended one could never appoint a replacement.
   *
   * `exceptId` is what makes re-assigning a member the role they already hold count once rather
   * than twice; the update path always passes the row being written.
   */
  countActiveByRole(
    societyId: SocietyId,
    role: MemberRole,
    actor: UserId,
    exceptId?: MemberId,
  ): Promise<number>;

  // ── the join queue (T049) ───────────────────────────────────────────────────

  /**
   * One page of the society's pending requests, newest first, each with the other members
   * claiming its flat.
   *
   * A read of `members` — the queue *is* the pending memberships (see `join-requests.ts`) —
   * with the claims resolved in the same statement rather than a lookup per row, for the
   * reason `list` gives: a queue of thirty requests must not be thirty-one round trips.
   *
   * The actor is required even though every row is visible to any active member under RLS:
   * the port's own rule is that scope is explicit, and the adapter runs the statement as the
   * caller so the policies decide the same thing again underneath.
   */
  listJoinRequests(
    societyId: SocietyId,
    actor: UserId,
    query: JoinRequestQuery,
  ): Promise<JoinRequestPage>;

  /**
   * Admit a pending member: `pending → active`, with the role, occupancy and flat the
   * approver confirmed.
   *
   * The write is deliberately a **decision**, not a field update: the storage path behind it
   * locks the row, re-checks that it is still pending, verifies the reviewer's own membership
   * and stamps `joined_at`/`approved_by` — all in one transaction, so two simultaneous
   * approvals produce exactly one active membership and exactly one decision. `setStatus()`
   * cannot express it (its union has no `active`) and that is the point: approval is not a
   * status write any caller may reach.
   *
   * A request that is no longer pending is `join_request_not_pending` — never a silent no-op,
   * because a second approval must not look like a success.
   */
  approveJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    input: JoinApprovalInput,
    actor: UserId,
  ): Promise<Member>;

  /**
   * Refuse a request: `pending → rejected`, with the reason the requester is owed.
   *
   * The reason travels with the write rather than being stored beside it, so a rejection and
   * its explanation cannot disagree — the same property `remove()` gets from being one
   * statement. The stamps (`rejected_at`, `rejected_by`) are the database's, not the
   * caller's.
   */
  rejectJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    reason: string,
    actor: UserId,
  ): Promise<Member>;

  /**
   * Soft removal (PRD §3.3): `status = 'removed'`, `removed_at`, `removed_by`, with the
   * row and its financial history left in place.
   *
   * The update is the storage fact; the *decision* — who may be removed, and the
   * database's refusal to orphan a society of its last admin — is the use case's and the
   * trigger's, not the adapter's.
   */
  remove(id: MemberId, societyId: SocietyId, actor: UserId): Promise<void>;
}
