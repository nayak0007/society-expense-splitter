import { actionsFor, asMemberError, err, memberError, ok } from "@ses/domain";
import type {
  Action,
  MemberCapabilities,
  MemberError,
  MemberId,
  MemberRole,
  MemberStatus,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  loadMemberContext,
  loadMemberTarget,
  requireMemberCapability,
} from "./support";
import type { MemberDeps } from "./support";

/**
 * Permission introspection (T046) — who may do what, for the caller and for one member.
 *
 * ## Read from the matrix, never from a stored grant
 *
 * Every function here answers with `actionsFor(role)`, the evaluator's own list. Nothing is
 * persisted, because nothing needs to be: a permission is a **property of a role**, and a table of
 * per-member grants would be a second source that could disagree with the matrix the guard and the
 * RLS policies read. A `member_permissions` table was considered and rejected — the moment it
 * could hold a row the matrix does not imply, the two answers diverge and the *guard* is the one
 * that wins, so the table would be a lie the UI believed.
 *
 * ## Why the operations cost no extra query
 *
 * Each one loads a membership it already had to load (the caller's own, or one target row) and
 * computes the rest in memory. There is no per-action existence check, no N+1 over the action
 * list, and no cache: SAD §9.4's five-minute membership cache is deliberately not implemented
 * (see `docs/guides/AUTHORIZATION.md` §6), and a permissions endpoint is exactly where a
 * long-lived cache would be most wrong — a revoked Treasurer would keep seeing their old list.
 */

/** One membership's effective permissions — the shape both endpoints answer with. */
export interface MemberPermissionsView {
  /** The **membership** id, as every other member route uses. */
  readonly memberId: MemberId;
  readonly role: MemberRole;
  readonly permissions: readonly Action[];
  readonly capabilities: MemberCapabilities;
}

/**
 * The caller's own effective permissions, whatever their status.
 *
 * **No capability gate, on purpose.** This is the one permission read that must work for a member
 * who may do nothing at all: a suspended treasurer has to be able to see that their permissions
 * are empty, and a guard that refused them would leave the app showing a permissions screen that
 * says "not allowed" instead of one that says "none" — the difference between a locked door and an
 * unexplained one. The row is the caller's own, so nothing is disclosed, and a caller with no live
 * membership at all is `not_found` exactly as everywhere else.
 *
 * `capabilities` is evaluated from the same membership, so a non-active caller gets an all-false
 * object rather than a refusal.
 */
export async function listMyPermissions(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<MemberPermissionsView, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  try {
    return ok(view(loaded.value.viewer, loaded.value.capabilities));
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}

/**
 * One member's effective permissions.
 *
 * Two callers are allowed, and the second is the reason this exists rather than being folded into
 * the details screen: **the member themselves** (nobody is hidden from their own record, which is
 * the same rule `contactVisible` follows) and **an Admin** — `canChangeRoles`, because seeing what
 * everybody can do is the half of role management that makes the other half reviewable. A
 * Treasurer who may edit the directory cannot use it: their grant is `member.invite`, and being
 * able to enumerate the society's Admins is a different kind of information.
 *
 * A member of another society, or a removed one, is `not_found` — never `forbidden` — so this read
 * cannot be used to probe whether an id exists.
 */
export async function getMemberPermissions(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<MemberPermissionsView, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const isSelf = loaded.value.target.id === loaded.value.viewer.id;
  if (!isSelf) {
    const guard = requireMemberCapability(
      loaded.value.capabilities,
      "canView",
      "Your role in this society cannot view its members.",
    );
    if (!guard.ok) return guard;

    if (!loaded.value.capabilities.canChangeRoles) {
      return err(
        memberError(
          "forbidden",
          "Only a society Admin can view another member's permissions.",
          { field: "memberId" },
        ),
      );
    }
  }

  try {
    return ok(view(loaded.value.target, loaded.value.capabilities));
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}

/**
 * One membership → the wire shape, from the evaluator's own list.
 *
 * ## A non-active membership has *no* effective permissions, and the list says so
 *
 * `actionsFor(role)` is the role's grant, and it is not the whole answer: the matrix says a role
 * may *ever* do something, while `PermissionGuard` refuses every action to a membership whose
 * status is not `active`. Returning the role's list to a suspended treasurer would tell them they
 * may record payments — and the next request would be refused, which reads as the app being
 * broken rather than as the suspension working. So the status is applied here, once, in the same
 * place the capabilities are evaluated, and a suspended or pending member gets an empty list with
 * the reason visible in `role` and `capabilities`.
 *
 * This is the one place the module deliberately reports less than the matrix grants, and it is the
 * same fold `evaluateMemberCapabilities` performs — not a second rule, the same one.
 */
function view(
  member: {
    readonly id: MemberId;
    readonly role: MemberRole;
    readonly status: MemberStatus;
  },
  capabilities: MemberCapabilities,
): MemberPermissionsView {
  return {
    memberId: member.id,
    role: member.role,
    permissions: member.status === "active" ? actionsFor(member.role) : [],
    capabilities,
  };
}
