import type { BuildingId, SocietyId } from "../shared/ids";

/**
 * Building entity (PRD §7 `buildings`, SAD §8.2).
 *
 * A building is the first level of a society's physical structure:
 * `Society → Building → Wing → Floor → Apartment` (PRD §5). Wings and floors are
 * **optional** levels inside a building — a six-flat building should not be
 * forced through them — which is why `totalFloors` is nullable here rather than
 * mandatory: a society that has not counted its floors says nothing, and nothing
 * is not the same as zero.
 *
 * The field names mirror the database columns and the wire contract deliberately:
 * the entity is what the API, the local replica and the UI all pass around, so a
 * rename here is a migration there.
 *
 * **What is deliberately absent, and why:** wings and apartments. The PRD models
 * the full hierarchy as `Society → Building → Wing → Floor → Apartment`, but wings
 * exist only to group apartments and floors only exist inside apartments — so a
 * wing count on this entity would be a structurally-zero field on every response
 * until apartments land (T043/T044). The wings table and these two fields arrive
 * together, in the slice that can populate them.
 */
export interface Building {
  readonly id: BuildingId;
  readonly societyId: SocietyId;
  readonly name: string;
  /** `null` = not recorded yet; always ≥ 1 when present. */
  readonly totalFloors: number | null;
  /** Lower sorts first; ties broken by name. PRD §7 column default is 0. */
  readonly displayOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * Length bounds, exported so the SQL `varchar`, the wire contract and the value
 * object cannot disagree about where a limit is.
 */

/** `varchar(80)` in the PRD's DDL. */
export const BUILDING_NAME_MAX_LENGTH = 80;

/**
 * `smallint` in the SQL, and deliberately not 32767.
 *
 * The PRD's own top tier is "200–2,000 units" for a large complex (PRD §3), and a
 * 200-floor residential building does not exist. The bound is here so a typo
 * (`1200` for `12`) fails validation with a field error instead of persisting a
 * number that every per-floor generator in T043/T044 would then loop over.
 */
export const TOTAL_FLOORS_MIN = 1;
export const TOTAL_FLOORS_MAX = 200;

/** Display order is a manual sort key, not a ranking; the column is `smallint`. */
export const DISPLAY_ORDER_MIN = 0;
export const DISPLAY_ORDER_MAX = 999;

/** Create payload — what the form collected, nothing derived. */
export interface CreateBuildingInput {
  readonly name: string;
  readonly totalFloors?: number | undefined;
  readonly displayOrder?: number | undefined;
}

/**
 * Partial update: every field optional, an empty patch rejected by the use case.
 *
 * The explicit `| undefined` is the same modifier `UpdateSocietyInput` carries and
 * for the same reason — with `exactOptionalPropertyTypes` a plain `Partial<>`
 * would reject a patch whose keys are present-but-undefined, which is exactly what
 * a contract's `.partial()` schema produces.
 *
 * Note what is **absent**: `totalFloors` cannot be cleared to "unknown" by sending
 * `null`, only by omitting it. That is deliberate — `update` treats `undefined` as
 * "leave unchanged" (see `update-building.ts`), so there is no third state to
 * express. A building whose floor count is unknown is created without one.
 */
export type UpdateBuildingInput = {
  readonly name?: string | undefined;
  readonly totalFloors?: number | undefined;
  readonly displayOrder?: number | undefined;
};

/** Sort order every read path uses: manual order first, then name (§8.5). */
export function compareBuildings(left: Building, right: Building): number {
  if (left.displayOrder !== right.displayOrder) {
    return left.displayOrder - right.displayOrder;
  }
  return left.name.localeCompare(right.name);
}
