import {
  asMemberError,
  checkAdminPresence,
  checkRoleChangeIsMeaningful,
  checkRoleLimit,
  checkRoleTarget,
  err,
  isMemberRole,
  memberError,
  ok,
  roleLimit,
} from "@ses/domain";
import type {
  MemberError,
  MemberId,
  MemberRole,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberTarget, requireMemberCapability } from "./support";
import type { MemberDeps, MemberTargetContext } from "./support";

/**
 * The one write path for a role change (T046), shared by `assignMemberRole` and
 * `revokeMemberRole`.
 *
 * ## Why one core and two entry points
 *
 * Assigning, changing and revoking are the same operation with three names: revoking is an
 * assignment to `resident` (PRD §2.3's "Admin revokes" row), and changing is an assignment to a
 * different role. Giving each its own copy of the caps, the self-change refusal and the
 * last-admin check would be three implementations of one security rule, and the copies would
 * agree until the day one of them was edited.
 *
 * What the two exports differ in is **who may do it** and **what the copy says**, so those are the
 * only things they pass in: `assignMemberRole` needs `member.role_change`, and `revokeMemberRole`
 * needs the same grant (there is no separate "revoke" action in the PRD's matrix — the row is one
 * capability).
 *
 * ## The order the checks run in, and why it matters
 *
 *  1. **the caller's context** — a non-member learns nothing, not even whether the id exists;
 *  2. **the capability** — an Admin-only operation, refused before the target is even read by a
 *     caller who could never perform it;
 *  3. **the target's existence** — `not_found`, indistinguishable from another society's member;
 *  4. **the self-change refusal** — ADR: *your own* role, which the database also refuses
 *     (`chk_member_self_change()` → `MEMBER_ROLE_CHANGE_FORBIDDEN`);
 *  5. **the target's status** — a pending, rejected or removed membership has no role to change;
 *  6. **the change itself** — no-ops are refused rather than reported as success;
 *  7. **the caps** — counts of *active* holders, excluding the row being written;
 *  8. **admin presence** — the last Admin cannot be demoted.
 *
 * The order is not arbitrary polish: each step is cheap relative to the next, and steps 4–8 are
 * the ones whose *messages* the user needs to be specific. A cap breach reported before the
 * self-change refusal would tell a user "at most 3 admins" when the real problem was that they
 * were promoting themselves.
 */

/**
 * The self-change refusal.
 *
 * Stated in the use case as well as in the trigger, and the two are not redundant: the trigger
 * refuses the *write*, while this refusal is what lets the operation say "you cannot change your
 * own role — ask another Admin", which is the only sentence that helps. It is also the rule the
 * prompt for this task names as the escalation to prevent ("Admins cannot promote themselves"),
 * and a rule whose only enforcement is a SQLSTATE is a rule a bypassed client will read as a
 * server error.
 */
function refuseSelfChange(
  context: MemberTargetContext,
  isRevocation: boolean,
): Result<true, MemberError> {
  if (context.target.id !== context.viewer.id) return ok(true);

  return err(
    memberError(
      "forbidden",
      isRevocation
        ? "You cannot change your own role. Ask another Admin to do it."
        : "You cannot change your own role. Ask another Admin to promote or demote you.",
      { field: "role" },
    ),
  );
}

export interface RoleChangeOptions {
  /** The permission the entry point requires — the same action for both, kept explicit. */
  readonly capability: "canChangeRoles";
  /** Copy for the capability refusal, which knows what the caller was attempting. */
  readonly capabilityReason: string;
  /** Whether the operation is a demotion to the default role, for the self-change copy. */
  readonly isRevocation: boolean;
}

export async function applyRoleChange(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
  role: MemberRole,
  options: RoleChangeOptions,
): Promise<Result<RoleChangeResult, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    options.capability,
    options.capabilityReason,
  );
  if (!guard.ok) return guard;

  // The parameter is typed, but this module is also called from the mobile app with a value that
  // arrived from a form: `isMemberRole` is the runtime half of the same rule, and it is the check
  // that keeps an unknown string from reaching a SQL enum cast.
  if (!isMemberRole(role)) {
    return err(
      memberError("validation", "Choose a valid role.", { field: "role" }),
    );
  }

  const self = refuseSelfChange(loaded.value, options.isRevocation);
  if (!self.ok) return self;

  const status = checkRoleTarget(loaded.value.target.status);
  if (!status.ok) return status;

  const meaningful = checkRoleChangeIsMeaningful(
    loaded.value.target.role,
    role,
  );
  if (!meaningful.ok) return meaningful;

  try {
    // Counts, not existence checks: PRD §2.2's caps are about populations, and the target is
    // excluded so that a member re-assigned the role they already hold counts once. Read before
    // the write, and re-checked by the role-cap trigger, because two Admins promoting at the same
    // moment would each pass their own read.
    //
    // Only a **capped** role needs the count. `checkRoleLimit` is still the rule, but four of the
    // six roles have no limit at all, and asking the repository for a number no rule will read is
    // a query for nothing — on this module's mobile caller, a whole HTTP request per role change.
    if (roleLimit(role) !== undefined) {
      const holdersExcludingTarget = await deps.members.countActiveByRole(
        societyId,
        role,
        actor,
        memberId,
      );
      const limit = checkRoleLimit(role, holdersExcludingTarget);
      if (!limit.ok) return limit;
    }

    // Only a demotion from `admin` can empty a society of its Admins, so the second count is only
    // owed in that case — which is why it is inside the branch rather than unconditional.
    //
    // Worth knowing when reading this: through *this* path the count is always ≥ 1, because the
    // caller passed `canChangeRoles` and is therefore an active Admin of the same society, so the
    // target cannot be the only one. The check is kept anyway — the Roadmap's acceptance asks for
    // the rule at both levels, it costs one query on a rare operation, and a future path (an
    // accepted admin transfer, a repair script, the service role) that reaches here without an
    // Admin as its caller must not be the reason a society loses its last one. The paths that can
    // genuinely empty a society today — suspension and removal — are stopped by
    // `chk_admin_present()` in the database, which is why the domain rule and the trigger are both
    // tested directly.
    if (loaded.value.target.role === "admin" && role !== "admin") {
      const remainingAdmins = await deps.members.countActiveByRole(
        societyId,
        "admin",
        actor,
        memberId,
      );
      const presence = checkAdminPresence(
        loaded.value.target.role,
        role,
        remainingAdmins,
      );
      if (!presence.ok) return presence;
    }

    const updated = await deps.members.setRole(
      memberId,
      societyId,
      role,
      actor,
    );

    return ok({ member: updated, capabilities: loaded.value.capabilities });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}

/** What a role change gives back: the updated membership, and the caller's own capabilities. */
export interface RoleChangeResult {
  readonly member: MemberTargetContext["target"];
  readonly capabilities: MemberTargetContext["capabilities"];
}
