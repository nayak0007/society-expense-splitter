import { actionsFor, asMemberError, err, ok } from "@ses/domain";
import type {
  MemberError,
  MemberId,
  MemberRole,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { applyRoleChange } from "./role-change";
import type { MemberPermissionsView } from "./permissions";
import type { MemberDeps } from "./support";

/**
 * Assign or change a member's role (T046; PRD §2.1 "Assign / change roles", §2.2's caps, §2.3's
 * transitions).
 *
 * ## One operation, three names
 *
 * "Assign" and "change" are the same write — the endpoint takes the role the membership should
 * hold, and whether that is a promotion, a rotation or a first appointment is not something the
 * operation needs to know. The rules that *do* depend on the direction are checked inside
 * `applyRoleChange`: a demotion from `admin` is the only one that can empty a society of its
 * Admins, and the cap count only applies to the role being moved *into*.
 *
 * ## What this deliberately does not do
 *
 *  - **No self-promotion.** Refused in the use case (a sentence the user can act on) and again by
 *    `chk_member_self_change()` in the database (the enforcement a bypassed client meets). PRD §13
 *    names privilege escalation as the module's threat; this is the shortest path to it.
 *  - **No acceptance step.** PRD §2.2's handover ("transfer requires the new admin to accept")
 *    needs a pending-transfer record to accept *against*, which is its own task. An Admin promoted
 *    here is promoted immediately. That is recorded as remaining work rather than silently
 *    dropped — the difference matters, because the alternative reading (that T046 shipped the
 *    transfer flow) would leave a society believing a consent step exists that does not.
 *  - **No audit entry and no notification.** Both are T050 and the notifications module; this
 *    task's scope excludes them. The role *change* is still fully reconstructible, because
 *    `stamp_member_approval`/`removed_at` and the database's own triggers stamp what they must —
 *    but the before/after row the Roadmap's acceptance asks for is not written yet.
 *
 * ## The answer is the permissions view, not the row
 *
 * The caller asked what a member may now do, so the response is that question's answer: the new
 * role, the action list it holds, and the caller's own capabilities (which the screen needs to
 * re-render its affordances). `actionsFor(updated.role)` is computed from the **stored** row the
 * database returned, not from the requested value — so a trigger that changed or refused something
 * cannot leave the response describing a state nobody is in.
 */
export async function assignMemberRole(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
  role: MemberRole,
): Promise<Result<MemberPermissionsView, MemberError>> {
  const changed = await applyRoleChange(
    deps,
    actor,
    societyId,
    memberId,
    role,
    {
      capability: "canChangeRoles",
      capabilityReason: "Only a society Admin can change member roles.",
      isRevocation: false,
    },
  );
  if (!changed.ok) return changed;

  try {
    return ok({
      memberId: changed.value.member.id,
      role: changed.value.member.role,
      permissions: actionsFor(changed.value.member.role),
      capabilities: changed.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
