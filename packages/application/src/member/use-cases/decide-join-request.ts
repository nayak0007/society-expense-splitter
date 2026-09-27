import {
  asMemberError,
  checkJoinRequestReview,
  checkJoinRoleAssignment,
  createRejectionReason,
  err,
  memberError,
  ok,
  toMemberView,
} from "@ses/domain";
import type {
  JoinApprovalInput,
  MemberError,
  MemberId,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberTarget, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";
import type { MemberDetail } from "./get-member";

/**
 * The two decisions on a join request (T049) — PRD §3.2: "status `pending` →
 * Admin/Treasurer approves → role assigned", and a rejection that carries a reason.
 *
 * ## The order the checks run in, and why it is part of the answer
 *
 * ```
 * the caller's context      404   (a non-member learns nothing — not even that the id exists)
 * the capability            403   (member.approve: Admin and Treasurer)
 * the target                404   (another society's request is indistinguishable from a missing one)
 * the request's state       409   (already decided, withdrawn or removed)
 * the self-review refusal    403   (nobody decides their own request)
 * the role being granted     403   (above Resident needs member.role_change — Admin only)
 * ```
 *
 * Each refusal names the thing the user must change, which is why the state is reported
 * before the role: "already approved" is the answer to a second tap, and a role problem on
 * a request that is no longer pending is not an answer at all.
 *
 * ## What is *not* here
 *
 * The write. Everything above is a read of the world as it was a moment ago, and the one
 * fact that must not be stale is the request's status — two reviewers approving at the same
 * moment must produce exactly one active membership. That promise is kept where it can be:
 * inside `member_approve_join()`, which locks the row `FOR UPDATE`, re-checks
 * `status = 'pending'`, re-resolves the reviewer's membership and re-checks the role rule
 * before writing. The checks here exist so the common cases answer *well*; the function's
 * exist so the answer is *true*.
 *
 * A duplicated rule is therefore deliberate, in the same way the role-change path duplicates
 * its own: the use case explains, the database decides.
 */
export async function approveJoinRequest(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
  input: JoinApprovalInput = {},
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canApprove",
    "Only an Admin or Treasurer can approve a join request.",
  );
  if (!guard.ok) return guard;

  const { viewer, target } = loaded.value;

  const reviewable = checkJoinRequestReview(viewer, target);
  if (!reviewable.ok) return reviewable;

  // The role is the one field whose *value* is a security decision, so it is validated
  // against the matrix rather than a list: a Treasurer may admit a Resident and may not
  // create a second Admin through the queue (the same asymmetry the invitation path
  // enforces — `stamp_invitation_creator()`).
  const role = input.role ?? target.role;
  const roleAllowed = checkJoinRoleAssignment(viewer, role);
  if (!roleAllowed.ok) return roleAllowed;

  if (
    input.isPrimary === true &&
    target.apartmentId === null &&
    (input.apartmentId === null || input.apartmentId === undefined)
  ) {
    // Without this the request reaches the database and comes back as
    // `chk_members_primary_requires_apartment` — a shape error where a field error belongs.
    return err(
      memberError(
        "validation",
        "Choose the flat this member is the primary occupant of.",
        { field: "apartmentId" },
      ),
    );
  }

  try {
    const updated = await deps.members.approveJoinRequest(
      target.id,
      societyId,
      input,
      actor,
    );
    return ok({
      member: toMemberView(viewer, updated),
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}

/**
 * Refuse a request, with the reason the requester is owed.
 *
 * The reason is validated here — length, blankness — so a form gets a field error rather
 * than a database exception, and validated again by `chk_members_rejection_reason` and the
 * function's own argument check so a writer that skips this layer cannot leave a
 * reasonless refusal behind.
 */
export async function rejectJoinRequest(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
  reason: string,
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canApprove",
    "Only an Admin or Treasurer can reject a join request.",
  );
  if (!guard.ok) return guard;

  const { viewer, target } = loaded.value;

  const reviewable = checkJoinRequestReview(viewer, target);
  if (!reviewable.ok) return reviewable;

  const validated = createRejectionReason(reason);
  if (!validated.ok) return validated;

  try {
    const updated = await deps.members.rejectJoinRequest(
      target.id,
      societyId,
      validated.value,
      actor,
    );
    return ok({
      member: toMemberView(viewer, updated),
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
