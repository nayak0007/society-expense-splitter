import {
  asApartmentId,
  asMemberError,
  createDisplayName,
  createEmail,
  createLeaseWindow,
  createMemberOccupancy,
  createPhone,
  createPrimaryClaim,
  err,
  memberError,
  ok,
  toMemberView,
} from "@ses/domain";
import type {
  CreateMemberInput,
  MemberError,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberContext, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";
import type { MemberDetail } from "./get-member";

/**
 * Add a member directly (PRD §3.3: "direct add by Admin (name + phone, creates a *shadow
 * member* with no login until they sign up — essential, since many owners never install the
 * app but must still be billed)").
 *
 * ## What a shadow member *is*, in storage terms
 *
 * A `members` row with `user_id IS NULL`, `role = 'resident'` and `status = 'active'`. The
 * last of those is the interesting one and it is not a default anybody chose casually: a
 * member who is not active is not billable, and being billable without an account is the
 * entire reason the path exists. The INSERT policy pins both values, so this use case cannot
 * mint an admin or a pending applicant even by accident.
 *
 * ## Why the phone is required and validated here, twice over
 *
 * It is the member's *only* identifier: `uq_members_shadow_phone` keys on it, it is what the
 * person will be matched by when they eventually sign up, and it is what the Admin reads out
 * to call them. So it is normalised to E.164 (`createPhone`) and checked for a duplicate
 * before the insert — the index is the enforcement, this is how the caller gets a typed
 * `conflict` attached to the phone input rather than a constraint name.
 *
 * ## Validation order
 *
 * Field by field in the order a form presents them, stopping at the first failure — the same
 * shape `createApartment` uses, and for the same reason: the caller sees the first thing
 * that is wrong with the field they are looking at, rather than an arbitrary member of the
 * set of things that are wrong.
 */
export interface AddMemberCommand {
  readonly displayName: string;
  readonly phone: string;
  readonly email?: string | null | undefined;
  readonly occupancy?: string | null | undefined;
  readonly apartmentId?: string | null | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly leaseStart?: string | null | undefined;
  readonly leaseEnd?: string | null | undefined;
  readonly shareContact?: boolean | undefined;
}

export async function addMember(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  command: AddMemberCommand,
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canAdd",
    "Only a society Admin or Treasurer can add members.",
  );
  if (!guard.ok) return guard;

  const displayName = createDisplayName(command.displayName);
  if (!displayName.ok) return displayName;

  const phone = createPhone(command.phone);
  if (!phone.ok) return phone;
  if (phone.value === null) {
    // The contract requires the field, so reaching here means a caller that skipped it —
    // the mobile app calls this use case directly, which is why the rule lives here too.
    return err(
      memberError("validation", "Enter a phone number.", { field: "phone" }),
    );
  }

  const email = createEmail(command.email);
  if (!email.ok) return email;

  const occupancy = createMemberOccupancy(command.occupancy);
  if (!occupancy.ok) return occupancy;

  const apartmentId = command.apartmentId ?? null;
  const isPrimary = command.isPrimary ?? false;
  const claim = createPrimaryClaim(isPrimary, occupancy.value, apartmentId);
  if (!claim.ok) return claim;

  const lease = createLeaseWindow(command.leaseStart, command.leaseEnd);
  if (!lease.ok) return lease;

  try {
    const duplicate = await deps.members.findLiveShadowByPhone(
      societyId,
      phone.value,
      actor,
    );
    if (duplicate !== null) {
      return err(
        memberError(
          "conflict",
          `${duplicate.displayName} is already recorded with that number.`,
          { field: "phone" },
        ),
      );
    }

    const input: CreateMemberInput = {
      displayName: displayName.value,
      phone: phone.value,
      email: email.value,
      occupancy: occupancy.value,
      apartmentId: apartmentId === null ? null : asApartmentId(apartmentId),
      isPrimary,
      leaseStart: command.leaseStart ?? null,
      leaseEnd: command.leaseEnd ?? null,
      shareContact: command.shareContact ?? false,
    };

    const created = await deps.members.create(societyId, input, actor);
    // Seen through the caller's own eyes: the person adding a member may always see the
    // contact details they just typed (`canViewMemberContact`), so a manager is never told
    // "not visible" about their own input.
    return ok({
      member: toMemberView(loaded.value.viewer, created),
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
