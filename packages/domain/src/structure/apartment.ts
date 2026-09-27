import type { ApartmentId, BuildingId, SocietyId, WingId } from "../shared/ids";

/**
 * Apartment entity (PRD §7 `apartments`, SAD §8.2) — the last level of a society's
 * physical structure, and the row that will carry the financial weight: members,
 * dues and meter readings all hang off a flat (PRD §3, §6).
 *
 * The field list is the PRD's DDL and nothing more. Everything here is either a
 * column, a default the column declares, or a bound the PRD states in prose; a
 * field invented here would be a field with no migration behind it.
 *
 * **What is deliberately absent, and why:** residents, owners, tenants and
 * occupancy *relationships* (`members.apartment_id`), meter readings, and any
 * derived value — a flat has an occupancy *status* (is it lived in) but no
 * occupant, because who lives in it is a membership fact and members are T045+.
 * Also absent is `wing` as an entity: `wingId` is a foreign key, and the wings
 * table has no write path yet (`docs/Roadmap.md` T043), so the domain models the
 * reference without pretending the aggregate is reachable.
 */
export interface Apartment {
  readonly id: ApartmentId;
  /** Denormalised from the building, matching the column and the SAD's ER. */
  readonly societyId: SocietyId;
  readonly buildingId: BuildingId;
  /** Optional grouping inside the building. `null` when the building has no wings. */
  readonly wingId: WingId | null;
  /** The label a resident recognises — "101", "A-4", "G-2". Unique per building. */
  readonly apartmentNumber: string;
  /** `null` = not recorded. Negative floors are basements, and `0` is ground. */
  readonly floor: number | null;
  /** e.g. `2`, `1.5`. `null` = not recorded. */
  readonly bhk: number | null;
  /** `null` = not measured. Never 0. */
  readonly carpetAreaSqft: number | null;
  readonly builtupAreaSqft: number | null;
  readonly parkingSlots: number;
  /** Manual weight for share-based splits (PRD §4). `0` = exempt. */
  readonly shareUnits: number;
  readonly occupancyStatus: OccupancyStatus;
  /** Billed differently, and excluded from residential-only rules (PRD §4). */
  readonly isCommercial: boolean;
  /** PRD §3.3: vacant flats are billable by default; this is the per-flat switch. */
  readonly isBillable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * PRD §7.1's `occupancy_status` enum, in its declared order.
 *
 * A three-value read (`vacant` / occupied / not finished) would have been easier
 * for the UI and wrong for billing: `owner_occupied` and `rented` are the two cases
 * PRD §6 treats differently (an owner-only expense category is charged to the
 * owner even when a tenant lives there), so the distinction has to exist in the
 * data before any rule can read it.
 */
export const OCCUPANCY_STATUSES = [
  "owner_occupied",
  "rented",
  "vacant",
  "under_construction",
] as const;

export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];

/** PRD §7 column default. A new flat is assumed empty until someone says otherwise. */
export const DEFAULT_OCCUPANCY_STATUS: OccupancyStatus = "vacant";

/**
 * Length bounds, exported so the SQL `varchar(24)`, the wire contract and the
 * value object cannot disagree about where a limit is.
 *
 * 24 rather than the PRD's neighbours' width because real Indian flat labels are
 * compound: `"B-1204"`, `"Tower 2 / 1101"`, `"Shop-3"`. The column is `varchar(24)`
 * and this is the same number.
 */
export const APARTMENT_NUMBER_MAX_LENGTH = 24;

/**
 * Floors are `smallint` and nullable, and the range is deliberately wide in both
 * directions: basements are negative, mezzanines are `0`, and no residential
 * building has 200 floors. The bound exists so a typo (`1200` for `12`) fails with
 * a field error instead of reaching the per-floor generators of T044.
 */
export const FLOOR_MIN = -5;
export const FLOOR_MAX = 200;

/** BHK configurations are whole or half units; `0.5` exists, `0` does not. */
export const BHK_MIN = 0.5;
export const BHK_MAX = 20;

/**
 * Both areas share one bound. `numeric(8,2)` could hold 999,999.99; a flat is not
 * 100,000 sqft, and the split rules divide by this number, so a slipped decimal
 * point here is a wrong bill rather than a visibly wrong field.
 */
export const AREA_MIN_SQFT = 0;
export const AREA_MAX_SQFT = 100000;

/** Parking is `smallint NOT NULL DEFAULT 0`; 0 means "no allotted slot". */
export const PARKING_SLOTS_MIN = 0;
export const PARKING_SLOTS_MAX = 20;

/**
 * `numeric(8,3) NOT NULL DEFAULT 1`. Zero is legal and meaningful — a caretaker's
 * quarter or a commercial unit can be exempt from share-based splits — which is why
 * there is no separate "not applicable" state for this column.
 */
export const SHARE_UNITS_MIN = 0;
export const SHARE_UNITS_MAX = 10000;

/** Create payload — what the form collected, nothing derived. */
export interface CreateApartmentInput {
  readonly apartmentNumber: string;
  readonly wingId?: string | null | undefined;
  readonly floor?: number | null | undefined;
  readonly bhk?: number | null | undefined;
  readonly carpetAreaSqft?: number | null | undefined;
  readonly builtupAreaSqft?: number | null | undefined;
  readonly parkingSlots?: number | undefined;
  readonly shareUnits?: number | undefined;
  readonly occupancyStatus?: OccupancyStatus | undefined;
  readonly isCommercial?: boolean | undefined;
  readonly isBillable?: boolean | undefined;
}

/**
 * Partial update: every field optional, an empty patch rejected by the use case.
 *
 * Every field here **can also be cleared** — unlike a building's floor count — and
 * the spelling that says so is explicit `null`: `floor: null` means "we no longer
 * claim to know which floor this is", while an absent key means "leave it alone".
 * The two are different states the PRD models (the columns are nullable), and a
 * patch API that collapsed them would make a recorded value impossible to unset.
 *
 * `buildingId` is absent on purpose: moving a flat to another building would move
 * its members, dues and history across a tenant boundary, and the column grant
 * refuses it as well (see the migration).
 */
export interface UpdateApartmentInput {
  readonly apartmentNumber?: string | undefined;
  readonly wingId?: string | null | undefined;
  readonly floor?: number | null | undefined;
  readonly bhk?: number | null | undefined;
  readonly carpetAreaSqft?: number | null | undefined;
  readonly builtupAreaSqft?: number | null | undefined;
  readonly parkingSlots?: number | undefined;
  readonly shareUnits?: number | undefined;
  readonly occupancyStatus?: OccupancyStatus | undefined;
  readonly isCommercial?: boolean | undefined;
  readonly isBillable?: boolean | undefined;
}

/**
 * Sort order every read path uses: floor, then flat number.
 *
 * ## Why the comparison is byte-wise and not `localeCompare`
 *
 * The list is ordered by the **database** (`idx_apartments_building`, ordered
 * `apartment_number COLLATE "C"`) and re-sorted **optimistically** by this
 * function after an edit. If the two disagreed, a user who renumbered a flat would
 * see it jump to a position the server would then move it out of a moment later.
 * `localeCompare` is locale-dependent (`"10" < "2"` in some collations, `"10" > "2"`
 * in others) and can change with an ICU upgrade, so this comparator and the index
 * are both pinned to code-unit order — `"10"` sorts before `"2"` in both, which is
 * a predictable rule a society can work with, unlike a rule that changes under an
 * operating-system patch.
 *
 * Null floors sort last: a flat whose floor nobody recorded has no place in the
 * reading order, and putting it first would bury the numbered floors below it.
 */
export function compareApartments(left: Apartment, right: Apartment): number {
  const leftFloor = left.floor ?? Number.MAX_SAFE_INTEGER;
  const rightFloor = right.floor ?? Number.MAX_SAFE_INTEGER;
  if (leftFloor !== rightFloor) return leftFloor - rightFloor;
  if (left.apartmentNumber === right.apartmentNumber) return 0;
  return left.apartmentNumber < right.apartmentNumber ? -1 : 1;
}
