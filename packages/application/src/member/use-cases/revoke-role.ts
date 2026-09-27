import {
  actionsFor,
  asMemberError,
  err,
  ok,
  REVOKE_TARGET_ROLE,
} from "@ses/domain";
import type {
  MemberError,
  MemberId,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { applyRoleChange } from "./role-change";
import type { MemberPermissionsView } from "./permissions";
import type { MemberDeps } from "./support";

/**
 * Revoke a member's role — PRD §2.3's "Admin revokes" row: the membership returns to `resident`.
 *
 * ## Why this is not "assign resident"
 *
 * It is, underneath — and that is the argument for having it as its own entry point rather than
 * making a caller spell it: the two differ in **copy** and in **intent**. "Revoke the Treasurer
 * role" is a governance act with a reason a society signs off on; "assign resident" is a field
 * value. A screen that presented revocation as a dropdown value would invite the reading that a
 * demoted member has *lost* something (they have — their permissions) and the reading that they
 * have been removed (they have not: the row, the flat and the history all stay).
 *
 * ## Why it is not a deletion
 *
 * Nothing is deleted anywhere in this module: `role` moves to its column default, and
 * `chk_admin_present()` refuses if the member is the last active Admin — because `admin` is a role
 * like any other here, so revoking it is the same operation as revoking any other, with the same
 * cap and presence checks. That is also why revocation cannot be used as a back door to empty a
 * society of its Admins: `checkAdminPresence` runs on the demotion path whichever entry point
 * reached it.
 *
 * The permission view comes back computed from the **stored** row, as in `assignMemberRole`.
 */
export async function revokeMemberRole(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<MemberPermissionsView, MemberError>> {
  const changed = await applyRoleChange(
    deps,
    actor,
    societyId,
    memberId,
    REVOKE_TARGET_ROLE,
    {
      capability: "canChangeRoles",
      capabilityReason: "Only a society Admin can revoke a role.",
      isRevocation: true,
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
