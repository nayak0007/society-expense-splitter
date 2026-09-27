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
  MemberError,
  MemberId,
  MemberOccupancy,
  Result,
  SocietyId,
  UpdateMemberInput,
  UserId,
} from "@ses/domain";

import { loadMemberTarget, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";
import type { MemberDetail } from "./get-member";

/**
 * Edit one membership: name, contact details, occupancy, flat, lease window and the
 * directory consent flag.
 *
 * ## Absent means unchanged, `null` means cleared
 *
 * The distinction `UpdateApartmentInput` established, and it matters more here than
 * anywhere: a shadow member's phone number is their only identifier
 * (`uq_members_shadow_phone`), so a society that recorded a wrong one has to be able to
 * *retract* it. A `coalesce($1, column)` write cannot express that at all, which is why the
 * repository assembles its column list from the fields that were actually sent.
 *
 * ## Validated against what will survive the patch, not against the patch
 *
 * Two of this module's rules are about a **pair** of fields, and neither can be checked on a
 * one-field patch:
 *
 *  - the primary claim needs a flat *and* an owning-or-tenancy occupancy
 *    (`createPrimaryClaim`), so a patch that sets `isPrimary: true` alone is judged against
 *    the flat already stored, and one that only changes the occupancy is judged against the
 *    flag already stored;
 *  - the lease window is ordered, so raising the start past a stored end is refused even
 *    though the patch itself mentions one date.
 *
 * `updateApartment` uses the same shape for the carpet/built-up pair, and the reason is
 * identical: the rule is a fact about the pair, so a patch that mentions half of it has to be
 * completed from storage before it can be judged.
 *
 * ## What this cannot do, by construction
 *
 * There is no `role` field and no `status` field in the command — role assignment is T046's
 * operation and the status transitions are their own use cases — so "edit" can never become
 * a privilege escalation or an approval by accident.
 */
export interface UpdateMemberCommand {
  readonly displayName?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly occupancy?: string | undefined;
  readonly apartmentId?: string | null | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly leaseStart?: string | null | undefined;
  readonly leaseEnd?: string | null | undefined;
  readonly shareContact?: boolean | undefined;
}

export async function updateMember(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
  command: UpdateMemberCommand,
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canEdit",
    "Only a society Admin or Treasurer can edit members.",
  );
  if (!guard.ok) return guard;

  const { target, viewer } = loaded.value;

  // ── the fields that were sent ───────────────────────────────────────────────
  let displayName: string | undefined;
  if (command.displayName !== undefined) {
    const validated = createDisplayName(command.displayName);
    if (!validated.ok) return validated;
    displayName = validated.value;
  }

  let phone: string | null | undefined;
  if (command.phone !== undefined) {
    const validated = createPhone(command.phone);
    if (!validated.ok) return validated;
    phone = validated.value;
  }

  let email: string | null | undefined;
  if (command.email !== undefined) {
    const validated = createEmail(command.email);
    if (!validated.ok) return validated;
    email = validated.value;
  }

  let occupancy: MemberOccupancy | undefined;
  if (command.occupancy !== undefined) {
    const validated = createMemberOccupancy(command.occupancy);
    if (!validated.ok) return validated;
    occupancy = validated.value;
  }

  // ── the pairs, completed from storage ───────────────────────────────────────
  const effectiveApartmentId =
    command.apartmentId === undefined
      ? target.apartmentId
      : command.apartmentId;
  const effectiveOccupancy = occupancy ?? target.occupancy;
  const effectiveIsPrimary = command.isPrimary ?? target.isPrimary;

  const claim = createPrimaryClaim(
    effectiveIsPrimary,
    effectiveOccupancy,
    effectiveApartmentId,
  );
  if (!claim.ok) return claim;

  const effectiveLeaseStart =
    command.leaseStart === undefined ? target.leaseStart : command.leaseStart;
  const effectiveLeaseEnd =
    command.leaseEnd === undefined ? target.leaseEnd : command.leaseEnd;

  const lease = createLeaseWindow(effectiveLeaseStart, effectiveLeaseEnd);
  if (!lease.ok) return lease;

  try {
    // Duplicate numbers only matter between *shadow* members — that is the predicate of
    // `uq_members_shadow_phone` — and the target has to be a shadow member for this row to
    // be the one the index constrains. A member with an account may share a number with
    // their spouse; two occupant records for one person may not.
    if (phone !== undefined && phone !== null && target.userId === null) {
      const duplicate = await deps.members.findLiveShadowByPhone(
        societyId,
        phone,
        actor,
        target.id,
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
    }

    // Assembled from validated locals with conditional spreads, so an absent field is
    // absent from the statement — the mechanism that makes "unchanged" and "cleared" two
    // different writes rather than one ambiguous one.
    const patch: UpdateMemberInput = {
      ...(displayName === undefined ? {} : { displayName }),
      ...(phone === undefined ? {} : { phone }),
      ...(email === undefined ? {} : { email }),
      ...(occupancy === undefined ? {} : { occupancy }),
      ...(command.apartmentId === undefined
        ? {}
        : {
            apartmentId:
              command.apartmentId === null
                ? null
                : asApartmentId(command.apartmentId),
          }),
      ...(command.isPrimary === undefined
        ? {}
        : { isPrimary: command.isPrimary }),
      ...(command.leaseStart === undefined
        ? {}
        : { leaseStart: command.leaseStart }),
      ...(command.leaseEnd === undefined ? {} : { leaseEnd: command.leaseEnd }),
      ...(command.shareContact === undefined
        ? {}
        : { shareContact: command.shareContact }),
    };

    if (Object.keys(patch).length === 0) {
      // The contract rejects an empty patch at the edge, and so does the repository. This is
      // the third door on the same room, and it is the one a direct caller (the mobile app)
      // meets: an `UPDATE` with an empty `SET` is not valid SQL, so the honest answer is the
      // caller mistake it is rather than a syntax error classified as `unknown`.
      return err(memberError("validation", "Nothing to update."));
    }

    const updated = await deps.members.update(
      target.id,
      societyId,
      patch,
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
