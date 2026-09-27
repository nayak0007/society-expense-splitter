import { MEMBER_OCCUPANCIES, MEMBER_SORTS, MEMBER_STATUSES } from "./member";
import type {
  Member,
  MemberOccupancy,
  MemberSort,
  MemberStatus,
  MemberView,
} from "./member";
import { can } from "./permission-evaluator";

/**
 * Pure member rules — what a viewer may do, and what a viewer may see.
 *
 * Total functions of their arguments (no I/O, no clock), for the reason
 * `structure/rules.ts` records: the API's guard, the use cases and the mobile screens
 * all read one evaluation, so a hidden button and a rejected request cannot disagree
 * (SAD §9.3).
 *
 * ## The grants come from the matrix, never from a role string
 *
 * `can()` is the same function the API's `PermissionGuard` calls and the same matrix
 * the RLS policies mirror, so nothing here re-spells "admin or treasurer". What this
 * file adds is the *status* half: a role grant says a role may ever do something, and
 * a membership that is `pending`, `inactive` or `removed` may not act regardless — the
 * one thing a role alone cannot express.
 */

/** What the caller may do with the society's roster, derived in one place. */
export interface MemberCapabilities {
  /** Read the directory (PRD §3.3 — the roster's own rows, not the society's). */
  readonly canView: boolean;
  /** Add a member directly — a shadow member with no account (PRD §3.3). */
  readonly canAdd: boolean;
  /** Edit a member's details, flat, lease or consent flag. */
  readonly canEdit: boolean;
  /** Suspend or reactivate a membership. */
  readonly canSuspend: boolean;
  /** Remove a member (soft; the row and its history survive). */
  readonly canRemove: boolean;
  /**
   * Assign, change or revoke a member's role (T046) — `member.role_change`, Admin only.
   *
   * Separate from `canEdit` even though both are "change somebody's record": editing a name and
   * handing out a Treasurer's financial powers are different grants in PRD §2.1 ("Invite
   * members" against "Assign / change roles"), and the matrix grants them to different roles.
   * Folding them together is how a Treasurer's directory screen grows a role picker.
   */
  readonly canChangeRoles: boolean;
  /**
   * Decide the join queue: approve or reject somebody who asked to join (T049) —
   * `member.approve`, Admin and Treasurer.
   *
   * The same two roles as `canAdd`, and still its own flag: PRD §2.1 grants "Invite members"
   * and "Approve join requests" as two capabilities that happen to share a holder set, and a
   * society that later narrows one of them must be able to do so without teaching the other
   * a new fact. It is also the flag the queue route's guard reads.
   */
  readonly canApprove: boolean;
}

const NO_MEMBER_CAPABILITIES: MemberCapabilities = {
  canView: false,
  canAdd: false,
  canEdit: false,
  canSuspend: false,
  canRemove: false,
  canChangeRoles: false,
  canApprove: false,
};

/**
 * Who may do what, from the caller's own membership.
 *
 * Three of the five capabilities are the matrix's own grants, mapped deliberately:
 *
 *  - **add and edit → `member.invite`.** PRD §2.1's "Invite members" row (Admin and
 *    Treasurer) is the capability that puts a person in the directory and keeps their
 *    entry correct. The PRD's prose narrows the *direct add* to Admin ("direct add by
 *    Admin", §3.3) while the matrix grants the row to both roles; where the two
 *    disagree the matrix wins, because the guard, the RLS policies and the UI all read
 *    it, and a second, prose-only rule would exist in exactly one place.
 *  - **suspend, reactivate and remove → `member.remove`** (Admin only). Suspension is
 *    access revocation, and the matrix's Admin-only row for it is "Remove members".
 *    Deliberately *not* `member.invite`: a Treasurer may keep the directory accurate
 *    and may not cut anybody off.
 *
 * `canView` is `member.view`'s grant *and* an active membership, and both halves are
 * load bearing. The grant half is what refuses a Guest, whose row-level policies would
 * let them read the roster — the same deliberate asymmetry `structure.view` documents
 * (RLS decides which rows exist for a database caller; the matrix decides which
 * operations this API offers). The status half is what refuses a *pending* member, whose
 * roster branch in `members_select_self_or_roster` would otherwise return exactly one
 * row and look like an empty society rather than a refusal.
 */
export function evaluateMemberCapabilities(
  viewer: Member | null,
): MemberCapabilities {
  if (viewer === null || viewer.status !== "active")
    return NO_MEMBER_CAPABILITIES;

  const role = viewer.role;
  return {
    canView: can(role, "member.view"),
    canAdd: can(role, "member.invite"),
    canEdit: can(role, "member.invite"),
    canSuspend: can(role, "member.remove"),
    canRemove: can(role, "member.remove"),
    canChangeRoles: can(role, "member.role_change"),
    canApprove: can(role, "member.approve"),
  };
}

/**
 * PRD §3.3: "Contact details hidden behind a per-member `share_contact` consent flag,
 * default off."
 *
 * Three readers may see a phone number or an email address, and the reasoning for the
 * third is the part worth reading twice:
 *
 *  1. **the member themselves** — nobody is hidden from their own record;
 *  2. **anyone, once the member has consented** (`shareContact`) — this is what the
 *     flag is for, and it is the consent of the *member*, not of the viewer;
 *  3. **a member-manager** (`member.invite`: Admin or Treasurer) — because they are
 *     the people who must be able to reach a resident, and because the value they
 *     would be shown is, in the direct-add case, the value they typed in a moment ago.
 *
 * The alternative reading — consent gates even the Admin — was rejected because it
 * makes the society's own officers unable to contact the people it bills, which the
 * PRD cannot have intended: §3.3 gives the same Admin the "Add Members" path whose
 * entire input is a name and a phone number. What the flag protects is *peer*
 * visibility: a resident must not be able to harvest their neighbours' numbers.
 */
export function canViewMemberContact(viewer: Member, target: Member): boolean {
  if (viewer.id === target.id) return true;
  if (target.shareContact) return true;
  return viewer.status === "active" && can(viewer.role, "member.invite");
}

/**
 * One member as one viewer may see them.
 *
 * Withholding is done here rather than in the API's mapper so the mobile client — which
 * calls the same use cases — cannot accidentally render a contact the API would have
 * redacted, and so there is exactly one implementation of the rule for both callers.
 * The `phone`/`email` columns are read either way; what changes is whether the value
 * leaves this function.
 */
export function toMemberView(viewer: Member, target: Member): MemberView {
  const contactVisible = canViewMemberContact(viewer, target);
  return {
    ...target,
    phone: contactVisible ? target.phone : null,
    email: contactVisible ? target.email : null,
    contactVisible,
  };
}

/** Runtime guard for a status that arrived over the wire. */
export function isMemberStatus(value: unknown): value is MemberStatus {
  return (
    typeof value === "string" &&
    (MEMBER_STATUSES as readonly string[]).includes(value)
  );
}

/** Runtime guard for an occupancy that arrived over the wire. */
export function isMemberOccupancy(value: unknown): value is MemberOccupancy {
  return (
    typeof value === "string" &&
    (MEMBER_OCCUPANCIES as readonly string[]).includes(value)
  );
}

/** Runtime guard for a directory ordering that arrived over the wire. */
export function isMemberSort(value: unknown): value is MemberSort {
  return (
    typeof value === "string" &&
    (MEMBER_SORTS as readonly string[]).includes(value)
  );
}
