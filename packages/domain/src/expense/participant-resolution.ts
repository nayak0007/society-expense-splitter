import type { ApartmentId, MemberId } from "../shared/ids";
import { err, ok, type Result } from "../shared/result";
import { PRIMARY_OCCUPANCIES, type MemberOccupancy } from "../member/member";
import type { OccupancyStatus } from "../structure/apartment";

import { expenseError, type ExpenseError } from "./errors";
import type { ParticipantSelector } from "./participant-selector";
import type {
  ParticipantApartment,
  ParticipantMember,
  SocietyParticipantDirectory,
} from "./ports";

/**
 * Participant resolution — the pure core (PRD §3.5.4, Roadmap T063).
 *
 * ## What it answers
 *
 * "Given this society's flats and memberships, which flats does this selector bill,
 * and who is each charge addressed to?" It is a **total function of its arguments**:
 * no database, no clock, no framework, and — the property that matters most — **no
 * arithmetic on money**. Resolution decides *who participates*; the split engine
 * decides *how much each owes* (T056–T059), and keeping those two questions in two
 * places is why `occupied_only` is not one of the six apartment bases: it is a
 * statement about participation, which is here.
 *
 * ## One participant per flat, always
 *
 * The billing model is the flat's: `expense_splits` rows are keyed
 * `(expense_id, member_id, apartment_id)` and `per_flat` weights a flat once, so a
 * flat with an owner *and* a tenant must not produce two shares — that is the "one
 * flat billed twice" bug the PRD's routing sentence exists to prevent. So each
 * eligible flat yields **exactly one** outcome: an assigned participant, or a flagged
 * unassigned entry. Duplicates are therefore not de-duplicated after the fact; they
 * are unrepresentable. (The split engine's own `conflict` guard covers the case where
 * a caller assembles a participant list by hand.)
 *
 * ## Owner-only routing is a *selection*, recorded when it *moved* a charge
 *
 * PRD §3.5.4: *"If `category.is_owner_only` and the resolved participant is a tenant,
 * the due is assigned to the apartment's **owner** membership instead, with
 * `assigned_reason = 'owner_only_category'`."* Two things follow, and both are
 * implemented literally:
 *
 *  - the flat's participant becomes its **owner** (so the outcome for every flat is
 *    the same whether the selector or the category asked for owners);
 *  - `assigned_reason` is recorded **only when the charge actually moved** — that is,
 *    when the flat's occupant path would have picked a *tenant*. An owner-occupied
 *    flat under an owner-only category never had a tenant to move the share from, so
 *    its row carries no reason; a flat whose selector asked for owners directly never
 *    had a tenant charge to move either.
 *
 * The member the charge moved *from* is carried on the participant
 * (`routedFromMemberId`) because the PRD requires the routing to be "shown on both
 * parties' screens" and because the publish path snapshots the row: the ids are what
 * that snapshot is built from.
 *
 * ## Unassignable flats are flagged, never dropped
 *
 * PRD §3.5.4: *"If no owner membership exists, the due attaches to the apartment and
 * shows as 'unassigned' in the Treasurer's queue."* `expense_splits` agrees —
 * `chk_expense_splits_participant` requires a member **or** a flat, and its own
 * comment names this case ("a flat-only row is the documented 'unassigned' case") —
 * so resolution returns the flat with its facts and a reason instead of quietly
 * removing it. Dropping it would under-bill the society and hide the gap; the reason
 * distinguishes the two next actions ("record an owner" versus "link a member at
 * all").
 *
 * ## Determinism
 *
 * Both lists come back in the flat order the structure module already uses —
 * `compareApartments`' floor-then-label order, extended with the apartment id so the
 * order is **total** rather than merely stable-but-arbitrary. The split engine sorts
 * its own participants by apartment number for the residual rule, but resolution's
 * order is what a diff ("what changed between the draft and the preview?"), the
 * treasurer's unassigned queue and a test's expectations are all read against, so it
 * cannot be left to the database's row order.
 *
 * `compareApartments` is not imported here because it takes `Apartment` entities and
 * this function's input is a read projection; the rule is the same two keys plus the
 * id, and the test suite pins the labels that make the byte-wise comparison visible
 * (`"10"` before `"2"`, as `COLLATE "C"` sorts it on the server).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a participant was charged when it was not the flat's own occupant.
 *
 * `owner_only_category` is the PRD's own value (§3.5.4) and it is what
 * `expense_splits.assigned_reason varchar(40)` was added for — T060's column comment
 * says so in as many words ("T063 writes the value"). It is a closed union rather than
 * a `string` so a second value cannot appear from a typo.
 */
export const ASSIGNED_REASONS = ["owner_only_category"] as const;
export type AssignedReason = (typeof ASSIGNED_REASONS)[number];

/**
 * Why a flat could not be addressed to anybody.
 *
 * Two values, because the two are different jobs for the treasurer: `unassigned_no_owner`
 * is the PRD's owner-only case (the society records a tenant but no owner), and
 * `unassigned_no_member` is the flat with no accountable membership at all — a
 * `bill_vacant_flats` society billing a flat nobody has been linked to yet. The
 * database needs no new vocabulary for them: both are the member-less split row the
 * `chk_expense_splits_participant` constraint already allows, and both fit the same
 * `assigned_reason` column.
 */
export const UNASSIGNED_REASONS = [
  "unassigned_no_owner",
  "unassigned_no_member",
] as const;
export type UnassignedReason = (typeof UNASSIGNED_REASONS)[number];

/**
 * The occupancies that mean "this membership is the flat's **owner**".
 *
 * `PRIMARY_OCCUPANCIES` is the database's set — the predicate of `uq_primary_occupant`
 * — and it includes `tenant`, because a tenant holds the flat's primary *claim* too.
 * The owner is that set without the tenant, and it deliberately keeps
 * `vacant_owner`: PRD §3.3's "owner living elsewhere" is exactly the owner a
 * rented-out flat must be billed through.
 */
const OWNER_OCCUPANCIES: readonly MemberOccupancy[] = [
  "owner_occupied",
  "vacant_owner",
];

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The flat facts every outcome carries.
 *
 * These are the apartment columns the six bases read (SPLIT_ENGINE.md §7), plus
 * `shareUnits` — the manual weight `apartments.share_units numeric(8, 3)` exists for
 * (PRD §3.5.3: "a manual weight for share-based splits"), which is the one place a
 * `shares` split's default comes from. **Percentages and custom amounts are absent on
 * purpose**: those are the treasurer's per-expense figures, not facts about a flat, so
 * they arrive with the expense (T065/T066) and never from resolution.
 *
 * The names are the engine's own field names, and they are flat rather than nested, so
 * a resolved participant is *structurally* an `ApartmentParticipant`: T064's preview
 * and T066's publish hand one straight to `computeSplit` with no mapping layer that
 * could misalign a fact from its flat.
 */
export interface ParticipantApartmentFacts {
  /** `null` = not recorded. Negative floors are basements, `0` is ground. */
  readonly floor: number | null;
  readonly carpetAreaSqft: number | null;
  readonly builtupAreaSqft: number | null;
  /** e.g. `2`, `1.5`. `null` = not recorded. */
  readonly bhk: number | null;
  readonly parkingSlots: number;
  readonly shareUnits: number;
}

/** One flat's charge, addressed to a member. */
export interface ExpenseParticipant extends ParticipantApartmentFacts {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  /** Set only when the charge moved off the flat's occupant — see the file header. */
  readonly assignedReason: AssignedReason | null;
  /** The member the charge moved *from*, or `null` when it did not move. */
  readonly routedFromMemberId: MemberId | null;
}

/** One billable flat with nobody to address the charge to. */
export interface UnassignedParticipant extends ParticipantApartmentFacts {
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  readonly reason: UnassignedReason;
}

/** What resolution answers. Both lists are non-empty only together. */
export interface ExpenseParticipantResolution {
  /** Engine-ready participants, in flat order. */
  readonly participants: readonly ExpenseParticipant[];
  /** Billable flats with no accountable member, in flat order, each with its reason. */
  readonly unassigned: readonly UnassignedParticipant[];
}

/**
 * The policy inputs that are *not* dimensions of the selector.
 *
 * `billVacantFlats` is `society_settings.bill_vacant_flats` — the society's own switch
 * (PRD §3.3: "vacant flats are billable by default for maintenance … but this is a
 * toggle"), and it is read from the society rather than accepted from the request,
 * which is why it is a parameter here rather than a field of the selector.
 *
 * `ownerOnly` is the *effective* answer — the selector's flag **or** the category's
 * `is_owner_only` — and `ownerOnlyAssignedReason` is the reason to record when that
 * answer came from the category. Collapsing them in the caller is deliberate: the
 * coincidence of two flags with the same meaning is exactly the sort of thing that
 * drifts when each side implements its own `||`.
 */
export interface ParticipantResolutionPolicy {
  readonly selector: ParticipantSelector;
  readonly billVacantFlats: boolean;
  readonly ownerOnly: boolean;
  readonly ownerOnlyAssignedReason: AssignedReason | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

function occupancyOf(member: ParticipantMember): MemberOccupancy {
  return member.occupancy;
}

function isOwner(member: ParticipantMember): boolean {
  return OWNER_OCCUPANCIES.includes(occupancyOf(member));
}

function isTenant(member: ParticipantMember): boolean {
  return occupancyOf(member) === "tenant";
}

function isPrimaryClaim(member: ParticipantMember): boolean {
  return member.isPrimary && PRIMARY_OCCUPANCIES.includes(occupancyOf(member));
}

/**
 * The best member of one group: the primary claim first, then the lowest id.
 *
 * The primary preference is the database's own documented meaning — the members
 * migration's comment on `chk_members_primary_requires_apartment` says the primary
 * occupant "is the person the flat's dues are addressed to" — and the id tiebreak is
 * the honest admission that nothing else is specified: a flat with two non-primary
 * owners has no documented addressee, so the rule is a *total order* rather than a
 * preference, and it is stable across runs and servers because a uuid does not change.
 */
function bestOf(
  members: readonly ParticipantMember[],
): ParticipantMember | null {
  let best: ParticipantMember | null = null;
  for (const member of members) {
    if (best === null) {
      best = member;
      continue;
    }
    if (isPrimaryClaim(member) !== isPrimaryClaim(best)) {
      if (isPrimaryClaim(member)) best = member;
      continue;
    }
    if (member.id < best.id) best = member;
  }
  return best;
}

/**
 * The flat's **owner** membership, or `null` when it has none.
 *
 * `null` is the PRD's unassignable case, not an error: the caller turns it into an
 * `unassigned_no_owner` entry.
 */
export function selectFlatOwner(
  members: readonly ParticipantMember[],
): ParticipantMember | null {
  return bestOf(members.filter(isOwner));
}

/**
 * The member the flat's charge is addressed to when nobody asked for the owner.
 *
 * `occupancy_status` decides the *direction* — it is the column PRD §7.1 exists in
 * order to distinguish ("`owner_occupied` and `rented` are the two cases PRD §6 treats
 * differently") — and the other relationship is the fallback, because a stale status
 * must not leave a billable flat with no addressee:
 *
 *  - `rented` → the tenant (they live there), else the owner;
 *  - every other status → the owner, else the tenant.
 *
 * A `family_member` is never selected: PRD §3.3 says family members are "attached to
 * an apartment, not billed separately". A flat whose only membership is a family
 * member therefore resolves as unassigned, which is the honest answer — `expense_splits`
 * requires a member or a flat, and the flat is what is left.
 */
export function selectFlatOccupant(
  members: readonly ParticipantMember[],
  occupancyStatus: OccupancyStatus,
): ParticipantMember | null {
  const owners = members.filter(isOwner);
  const tenants = members.filter(isTenant);
  return occupancyStatus === "rented"
    ? (bestOf(tenants) ?? bestOf(owners))
    : (bestOf(owners) ?? bestOf(tenants));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

function flatOrder(
  left: {
    floor: number | null;
    apartmentNumber: string;
    apartmentId: ApartmentId;
  },
  right: {
    floor: number | null;
    apartmentNumber: string;
    apartmentId: ApartmentId;
  },
): number {
  const leftFloor = left.floor ?? Number.MAX_SAFE_INTEGER;
  const rightFloor = right.floor ?? Number.MAX_SAFE_INTEGER;
  if (leftFloor !== rightFloor) return leftFloor - rightFloor;
  if (left.apartmentNumber !== right.apartmentNumber) {
    return left.apartmentNumber < right.apartmentNumber ? -1 : 1;
  }
  if (left.apartmentId === right.apartmentId) return 0;
  return left.apartmentId < right.apartmentId ? -1 : 1;
}

/**
 * Resolves a selector into the flats it bills and the member each charge is addressed
 * to. Side-effect free: it reads the directory it is handed and nothing else.
 *
 * ## The order of the three refusals
 *
 *  1. **The selector named something this society does not have** — a building, a wing
 *     label, an excluded apartment. `not_found`, and deliberately *strict*: every one
 *     of these silently ignored would bill the wrong people (a building filter that
 *     matched nothing would resolve to the whole society, and an exclusion that matched
 *     nothing would bill the flat it named). Absent and another-tenant are the same
 *     answer — the port returns only this society's rows, so a cross-society id is
 *     simply not in the set, which is the PRD T041 rule the whole API follows.
 *  2. **Nothing is billable.** `validation` with `field: "selector"`. An empty
 *     resolution is never legitimate: every path that could produce one is a mistake
 *     the treasurer can see and fix, and letting it through would surface later as the
 *     split engine's "no participants" refusal, which can only name an anonymous array.
 *  3. Otherwise the two lists, both possibly non-empty together.
 *
 * ## Vacancy, in one line
 *
 * A flat is billable when the society's `bill_vacant_flats` allows it and the selector
 * does not opt out: `billVacantFlats && (includeVacant ?? true)`. The setting is the
 * floor (a society that does not bill vacant flats never does, whatever a selector
 * says), and the selector's flag is the per-expense override in both directions — which
 * is why an unstated `includeVacant` defers to the setting rather than to `false`.
 *
 * `under_construction` is deliberately *not* treated as vacant: the PRD's switch is
 * named for vacant flats, its enum lists the two separately, and inventing a second
 * exemption here would be a rule no document states. A society that does not bill a
 * flat still has `is_billable` — the column PRD §3.3 describes as the per-flat switch —
 * and a selector that names the statuses it wants.
 */
export function resolveExpenseParticipants(
  directory: SocietyParticipantDirectory,
  policy: ParticipantResolutionPolicy,
): Result<ExpenseParticipantResolution, ExpenseError> {
  const { selector } = policy;

  // ── 1. the selector must name things this society has ──────────────────────

  if (selector.buildings.length > 0) {
    const known = new Set<string>(directory.buildings);
    const unknown = selector.buildings.find((id) => !known.has(id));
    if (unknown !== undefined) {
      return err(
        expenseError(
          "not_found",
          "One of the selected buildings is not available to you.",
          { field: "selector.buildings", buildingId: unknown },
        ),
      );
    }
  }

  for (const name of selector.wings) {
    if (!directory.wings.some((wing) => wing.name === name)) {
      return err(
        expenseError("not_found", `Wing ${name} is not available to you.`, {
          field: "selector.wings",
        }),
      );
    }
  }

  if (selector.excludeApartments.length > 0) {
    const known = new Set<string>(
      directory.apartments.map((apartment) => apartment.id),
    );
    const unknown = selector.excludeApartments.find((id) => !known.has(id));
    if (unknown !== undefined) {
      return err(
        expenseError(
          "not_found",
          "One of the excluded apartments is not available to you.",
          { field: "selector.excludeApartments", apartmentId: unknown },
        ),
      );
    }
  }

  // ── 2. the filters ────────────────────────────────────────────────────────

  const buildingFilter = new Set<string>(selector.buildings);
  const floorFilter = new Set<number>(selector.floors);
  const statusFilter = new Set<string>(selector.occupancy);
  const excluded = new Set<string>(selector.excludeApartments);
  const wingFilter = new Set<string>(
    directory.wings
      .filter((wing) => selector.wings.includes(wing.name))
      .map((wing) => wing.id),
  );
  const vacantBillable =
    policy.billVacantFlats && (selector.includeVacant ?? true);

  const membersByApartment = new Map<string, ParticipantMember[]>();
  for (const member of directory.members) {
    const members = membersByApartment.get(member.apartmentId);
    if (members === undefined) {
      membersByApartment.set(member.apartmentId, [member]);
    } else {
      members.push(member);
    }
  }

  const participants: ExpenseParticipant[] = [];
  const unassigned: UnassignedParticipant[] = [];

  for (const apartment of directory.apartments) {
    if (!isEligible(apartment)) continue;

    const members = membersByApartment.get(apartment.id) ?? [];
    const facts = apartmentFacts(apartment);
    const owner = selectFlatOwner(members);
    const occupant = selectFlatOccupant(members, apartment.occupancyStatus);
    const selected = policy.ownerOnly ? owner : occupant;

    if (selected === null) {
      unassigned.push({
        apartmentId: apartment.id,
        apartmentNumber: apartment.apartmentNumber,
        reason: policy.ownerOnly
          ? "unassigned_no_owner"
          : "unassigned_no_member",
        ...facts,
      });
      continue;
    }

    // PRD §3.5.4's routing, recorded only when it moved a *tenant's* share.
    const routedFrom =
      policy.ownerOnly &&
      occupant !== null &&
      occupant.id !== selected.id &&
      isTenant(occupant)
        ? occupant.id
        : null;

    participants.push({
      memberId: selected.id,
      apartmentId: apartment.id,
      apartmentNumber: apartment.apartmentNumber,
      assignedReason:
        routedFrom === null ? null : policy.ownerOnlyAssignedReason,
      routedFromMemberId: routedFrom,
      ...facts,
    });
  }

  if (participants.length === 0 && unassigned.length === 0) {
    return err(
      expenseError(
        "validation",
        "The participant selector matches no billable flats in this society.",
        { field: "selector" },
      ),
    );
  }

  return ok(
    Object.freeze({
      participants: Object.freeze(participants.sort(flatOrder)),
      unassigned: Object.freeze(unassigned.sort(flatOrder)),
    }),
  );

  function isEligible(apartment: ParticipantApartment): boolean {
    if (!apartment.isBillable) return false;
    if (excluded.has(apartment.id)) return false;
    if (buildingFilter.size > 0 && !buildingFilter.has(apartment.buildingId)) {
      return false;
    }
    if (wingFilter.size > 0) {
      if (apartment.wingId === null || !wingFilter.has(apartment.wingId)) {
        return false;
      }
    }
    if (floorFilter.size > 0) {
      if (apartment.floor === null || !floorFilter.has(apartment.floor)) {
        return false;
      }
    }
    if (statusFilter.size > 0 && !statusFilter.has(apartment.occupancyStatus)) {
      return false;
    }
    if (apartment.occupancyStatus === "vacant" && !vacantBillable) return false;
    return true;
  }
}

function apartmentFacts(
  apartment: ParticipantApartment,
): ParticipantApartmentFacts {
  return {
    floor: apartment.floor,
    carpetAreaSqft: apartment.carpetAreaSqft,
    builtupAreaSqft: apartment.builtupAreaSqft,
    bhk: apartment.bhk,
    parkingSlots: apartment.parkingSlots,
    shareUnits: apartment.shareUnits,
  };
}
