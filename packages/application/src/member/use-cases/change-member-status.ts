import { asMemberError, err, memberError, ok, toMemberView } from "@ses/domain";
import type {
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
 * Suspend a member, and reactivate one (PRD §3.3's member lifecycle).
 *
 * ## Two use cases in one file, on one rule
 *
 * "Suspend" and "reactivate" are the same operation from two directions — write the
 * membership's access state, having first checked that the state being left is the one the
 * caller thinks it is — and the prompt that asked for this module listed them separately
 * because the *screen* offers them separately. They share a file because they share the
 * guard, the audit question and the failure modes: a member who is already suspended cannot
 * be suspended again, a member who is active cannot be reactivated, and in both cases the
 * answer is a `conflict` that names the state rather than a silent no-op write.
 *
 * ## Why suspension is not a removal
 *
 * A suspended member keeps their row, their flat, their role and their history — PRD §3.3
 * keeps financial history and `removed_at` is what marks leaving. That is the point of the
 * state: a disputed charge, a tenant between leases, a member who asked for a pause. Removal
 * is `removeMember`, and the two are different decisions with different consequences, which
 * is why the capability for both is the same Admin-only grant (`member.remove`: access
 * revocation) while the directory edits are Admin-and-Treasurer.
 *
 * ## Self-service is refused, and this is a courtesy rather than a security rule
 *
 * An Admin cannot suspend their own membership here: the honest path for "I am stepping
 * back" is leaving the society, which the society module already implements and which
 * carries the sole-admin check with its own copy. The database would *allow* a
 * self-suspension (except for the last active admin, where `chk_admin_present()` refuses
 * it), so this is a UX guard, not a second lock — and it is stated as one so a later reader
 * does not mistake it for enforcement.
 */
function requireSelfTargetFree(
  viewerId: MemberId,
  targetId: MemberId,
  action: string,
): Result<true, MemberError> {
  if (viewerId === targetId) {
    return err(
      memberError(
        "forbidden",
        `You cannot ${action} your own membership. Leave the society instead.`,
      ),
    );
  }
  return ok(true);
}

/** Suspend: `active → inactive`. The member stays attached, and cannot act. */
export async function suspendMember(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<MemberDetail, MemberError>> {
  return changeStatus(deps, actor, societyId, memberId, "suspend");
}

/** Reactivate: `inactive → active`. */
export async function reactivateMember(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<MemberDetail, MemberError>> {
  return changeStatus(deps, actor, societyId, memberId, "reactivate");
}

/**
 * The shared rule.
 *
 * The expected *from* state is checked against the row that was read, which is what makes
 * this a transition rather than an assignment: an Admin pressing "Suspend" on a member who
 * is already suspended, or on one who has left, is told so. Both failures are `conflict`
 * rather than `validation` — the payload is empty and the state is what refuses it, and the
 * same request succeeds once the state changes (SAD §7.2).
 */
async function changeStatus(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
  direction: "suspend" | "reactivate",
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canSuspend",
    "Only a society Admin can suspend or reactivate a member.",
  );
  if (!guard.ok) return guard;

  const { target, viewer } = loaded.value;

  const notSelf = requireSelfTargetFree(
    viewer.id,
    target.id,
    direction === "suspend" ? "suspend" : "reactivate",
  );
  if (!notSelf.ok) return notSelf;

  const expected: string = direction === "suspend" ? "active" : "inactive";
  if (target.status !== expected) {
    return err(
      memberError(
        "conflict",
        direction === "suspend"
          ? "This member is not active, so there is nothing to suspend."
          : "This member is not suspended, so there is nothing to reactivate.",
      ),
    );
  }

  try {
    // The status the *repository* writes is the target's new one; the transition rule above
    // is what makes the two directions different, and it is checked against the row that was
    // read. A concurrent change between the read and the write is answered by the database:
    // reactivating a member whose flat has since gained another primary owner is refused by
    // `uq_primary_occupant`, which the adapter classifies as a `conflict`.
    const updated = await deps.members.setStatus(
      target.id,
      societyId,
      direction === "suspend" ? "inactive" : "active",
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
