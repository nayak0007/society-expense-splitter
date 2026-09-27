import { asMemberError, err, memberError, ok } from "@ses/domain";
import type {
  MemberError,
  MemberId,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberTarget, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";

/**
 * Remove a member (PRD §3.3: "soft removal → `status = 'removed'`, `removed_at`,
 * `removed_by`… Financial history is never deleted").
 *
 * Soft, and that is the whole design: dues, payments and receipts reference
 * `members.id`, so a hard delete would either cascade a member's financial history away or
 * fail on a foreign key. The row stays, stops being readable, and keeps its owner.
 *
 * ## What this deliberately does not do yet
 *
 * PRD §3.3 requires removal to be **blocked while the member has unsettled dues**, unless an
 * Admin explicitly chooses "remove and write off" (logged, with a reason). Neither half is
 * implementable in this slice: dues belong to the expenses/payments modules, which are out of
 * scope here, and the write-off reason has nowhere to be recorded without the audit table
 * (T050). So removal proceeds, the dues check and the write-off path are recorded as
 * remaining work in the Roadmap, and this docstring says so out loud — a rule that is
 * missing is better documented than assumed.
 *
 * ## The two rules that *are* enforced
 *
 *  - **the sole admin.** `chk_admin_present()` refuses at commit if the row being removed is
 *    the society's last active admin; the adapter classifies its `P0001` as `sole_admin`,
 *    which is the code the society module's `leaveSociety` already uses for the same
 *    database refusal. The check is *not* repeated here as a read-then-write, because the
 *    database's version is the one that cannot lose a race.
 *  - **self-removal.** An Admin cannot remove their own membership through this path; leaving
 *    is `leaveSociety`, which carries its own capability rules and its own copy. As in
 *    `change-member-status`, this is a UX guard rather than a second lock — but here the
 *    distinction is sharper, because the *society* module's path is the one that surfaces the
 *    sole-admin refusal with the "promote someone first" copy.
 */
export async function removeMember(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<void, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canRemove",
    "Only a society Admin can remove a member.",
  );
  if (!guard.ok) return guard;

  const { target, viewer } = loaded.value;
  if (target.id === viewer.id) {
    return err(
      memberError(
        "forbidden",
        "You cannot remove your own membership. Leave the society instead.",
      ),
    );
  }

  try {
    await deps.members.remove(target.id, societyId, actor);
    return ok(undefined);
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
