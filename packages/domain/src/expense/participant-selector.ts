import {
  FLOOR_MAX,
  FLOOR_MIN,
  OCCUPANCY_STATUSES,
  type OccupancyStatus,
} from "../structure/apartment";
import { err, ok, type Result } from "../shared/result";
import {
  asApartmentId,
  asBuildingId,
  type ApartmentId,
  type BuildingId,
} from "../shared/ids";

import { expenseError, type ExpenseError } from "./errors";

/**
 * The **participant selector** — who an expense is charged to, as data (PRD §3.5.4,
 * Roadmap T063).
 *
 * ## What it is
 *
 * The PRD resolves participants from a selector rather than a hard-coded list, and
 * stores that selector on the expense (`expenses.participant_selector jsonb NOT NULL
 * DEFAULT '{}'`), because the same question is asked three times — by the preview, by
 * the publish and by the recalculation after an edit — and a stored answer that could
 * drift from the resolution would make the preview and the bill disagree, which is the
 * Sev-1 bug the split engine's own docstring calls out.
 *
 * The eight dimensions are the PRD's own, verbatim from §3.5.4's example:
 *
 * ```json
 * { "scope": "society", "buildings": ["uuid"], "wings": ["A"], "floors": [1,2,3],
 *   "occupancy": ["owner_occupied","rented"], "excludeApartments": ["uuid"],
 *   "includeVacant": false, "ownerOnly": true }
 * ```
 *
 * Nothing is added to that list and nothing is dropped: a dimension the product has
 * not asked for is a field no screen can set, and a PRD dimension left out here would
 * have to be re-invented by whoever needed it.
 *
 * ## `occupancy` is the *flat's* status, not the member's occupancy type
 *
 * The two vocabularies look alike and are different columns:
 *
 *  - `apartments.occupancy_status` — `owner_occupied | rented | vacant |
 *    under_construction` (“is this flat lived in by its owner, let out, empty, or still
 *    being built?”);
 *  - `members.occupancy` — `owner_occupied | tenant | family_member | vacant_owner`
 *    (“what is this person's relationship to the flat?”).
 *
 * The PRD's example settles which one the selector means: it names `rented`, which
 * exists **only** in the flat's enum. So `occupancy` filters flats, and the membership
 * type drives owner-only *routing* (`resolveOwnerOnly`) rather than selection.
 * Validating against `OCCUPANCY_STATUSES` is therefore not a style preference — the
 * other union would accept `family_member` and match no flat at all.
 *
 * ## `wings` are names, and that is the PRD's choice
 *
 * `"wings": ["A"]` is a label, while `apartments.wing_id` is a uuid; the resolution
 * therefore maps label → id against the society's own wings before filtering (see
 * `resolveExpenseParticipants`). The comparison is exact and case-sensitive, matching
 * `uq_wings_building_name` — the same argument `getByName` records for categories: a
 * case-insensitive match here would accept a selector the database would never have
 * written.
 *
 * ## Normalisation, and why the arrays are canonically ordered
 *
 * Two selectors that mean the same thing are made to be the *same value*: ids and wing
 * labels are de-duplicated and sorted, floors sorted ascending, and `occupancy`
 * ordered by the column's own declared order. That is what lets a stored selector be
 * compared — "did the treasurer change the participants?" is a deep equality — and
 * what makes the resolution's output a function of the selector rather than of the
 * array order the client happened to send.
 */

/** PRD §3.5.4's `scope`. The two documented values, and no third. */
export const PARTICIPANT_SCOPES = ["society", "building"] as const;
export type ParticipantScope = (typeof PARTICIPANT_SCOPES)[number];

/**
 * The scope an absent `scope` means.
 *
 * `expenses.participant_selector` defaults to `'{}'`, so an empty selector has to mean
 * something, and "every eligible flat in the society" is the only reading that bills
 * somebody: a default of `building` would silently resolve to *nobody* and turn a
 * missing field into an empty expense.
 */
export const DEFAULT_PARTICIPANT_SCOPE: ParticipantScope = "society";

/** `wings.name varchar(40)` — the column's width, so a label the client sends is one
 * the database could have stored. */
export const WING_NAME_MAX_LENGTH = 40;

/** Bounds a selector's arrays so a malformed payload cannot ask for a scan of
 * everything: a society's flats are bounded by hundreds, not by thousands of terms. */
export const SELECTOR_MAX_TERMS = 1000;

/**
 * The selector as it arrives — every field optional, because that is what
 * `'{}'::jsonb` and a partial form both look like.
 */
export interface ParticipantSelectorInput {
  readonly scope?: ParticipantScope | undefined;
  readonly buildings?: readonly string[] | undefined;
  readonly wings?: readonly string[] | undefined;
  readonly floors?: readonly number[] | undefined;
  readonly occupancy?: readonly OccupancyStatus[] | undefined;
  readonly excludeApartments?: readonly string[] | undefined;
  readonly includeVacant?: boolean | undefined;
  readonly ownerOnly?: boolean | undefined;
}

/**
 * The selector, normalised and frozen.
 *
 * `includeVacant` is `boolean | null` rather than a resolved `boolean`, and that is
 * deliberate: "the treasurer did not say" and "the treasurer said false" are different
 * facts, and only the *second* overrides the society's `bill_vacant_flats` policy. A
 * parse that folded the two together would make the setting un-overridable in one
 * direction — see `resolveExpenseParticipants`.
 */
export interface ParticipantSelector {
  readonly scope: ParticipantScope;
  readonly buildings: readonly BuildingId[];
  readonly wings: readonly string[];
  /** Ascending, de-duplicated. Empty means "every floor". */
  readonly floors: readonly number[];
  /** In `OCCUPANCY_STATUSES` order, de-duplicated. Empty means "every status". */
  readonly occupancy: readonly OccupancyStatus[];
  readonly excludeApartments: readonly ApartmentId[];
  /** `null` = not stated, so the society's policy decides. */
  readonly includeVacant: boolean | null;
  readonly ownerOnly: boolean;
}

/** RFC 4122 shape, case-insensitive, matching what the API's `z.uuid()` accepts. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(
  raw: unknown,
  field: string,
): Result<readonly string[], ExpenseError> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) {
    return err(
      expenseError("validation", `${field} must be an array.`, { field }),
    );
  }
  if (raw.length > SELECTOR_MAX_TERMS) {
    return err(
      expenseError(
        "validation",
        `${field} cannot carry more than ${SELECTOR_MAX_TERMS} terms.`,
        { field },
      ),
    );
  }
  const out: string[] = [];
  for (const term of raw) {
    if (typeof term !== "string") {
      return err(
        expenseError("validation", `${field} must contain text values.`, {
          field,
        }),
      );
    }
    out.push(term);
  }
  return ok(out);
}

/**
 * Validates and normalises a selector.
 *
 * `validation` for every refusal, with `details.field` naming the dimension, because
 * every one of these is a form error the treasurer can fix — never `not_found`, which
 * is reserved for a *well-formed* selector naming something this society does not have
 * (that check needs the society's rows and lives in `resolveExpenseParticipants`).
 */
export function createParticipantSelector(
  input: unknown,
): Result<ParticipantSelector, ExpenseError> {
  if (!isRecord(input)) {
    return err(
      expenseError("validation", "A participant selector is required.", {
        field: "selector",
      }),
    );
  }

  const rawScope = input["scope"] ?? DEFAULT_PARTICIPANT_SCOPE;
  if (typeof rawScope !== "string" || !isParticipantScope(rawScope)) {
    return err(
      expenseError(
        "validation",
        `scope must be one of ${PARTICIPANT_SCOPES.join(", ")}.`,
        { field: "selector.scope" },
      ),
    );
  }
  const scope: ParticipantScope = rawScope;

  const rawBuildings = readStringArray(
    input["buildings"],
    "selector.buildings",
  );
  if (!rawBuildings.ok) return rawBuildings;
  const rawExcludes = readStringArray(
    input["excludeApartments"],
    "selector.excludeApartments",
  );
  if (!rawExcludes.ok) return rawExcludes;
  const rawWings = readStringArray(input["wings"], "selector.wings");
  if (!rawWings.ok) return rawWings;

  const buildings: BuildingId[] = [];
  for (const id of rawBuildings.value) {
    if (!UUID_PATTERN.test(id)) {
      return err(
        expenseError("validation", `${id} is not a building id.`, {
          field: "selector.buildings",
        }),
      );
    }
    buildings.push(asBuildingId(id));
  }
  if (scope === "building" && buildings.length === 0) {
    return err(
      expenseError(
        "validation",
        "A building-scoped selector must name at least one building.",
        { field: "selector.buildings" },
      ),
    );
  }

  const excludeApartments: ApartmentId[] = [];
  for (const id of rawExcludes.value) {
    if (!UUID_PATTERN.test(id)) {
      return err(
        expenseError("validation", `${id} is not an apartment id.`, {
          field: "selector.excludeApartments",
        }),
      );
    }
    excludeApartments.push(asApartmentId(id));
  }

  const wings: string[] = [];
  for (const raw of rawWings.value) {
    const name = raw.trim();
    if (name.length === 0 || name.length > WING_NAME_MAX_LENGTH) {
      return err(
        expenseError(
          "validation",
          `A wing name must be 1–${WING_NAME_MAX_LENGTH} characters.`,
          { field: "selector.wings" },
        ),
      );
    }
    wings.push(name);
  }

  const floors: number[] = [];
  const rawFloors = input["floors"];
  if (rawFloors !== undefined && rawFloors !== null) {
    if (!Array.isArray(rawFloors)) {
      return err(
        expenseError("validation", "selector.floors must be an array.", {
          field: "selector.floors",
        }),
      );
    }
    for (const floor of rawFloors) {
      if (
        typeof floor !== "number" ||
        !Number.isInteger(floor) ||
        floor < FLOOR_MIN ||
        floor > FLOOR_MAX
      ) {
        return err(
          expenseError(
            "validation",
            `A floor must be a whole number between ${FLOOR_MIN} and ${FLOOR_MAX}.`,
            { field: "selector.floors" },
          ),
        );
      }
      floors.push(floor);
    }
  }

  const occupancy: OccupancyStatus[] = [];
  const rawOccupancy = input["occupancy"];
  if (rawOccupancy !== undefined && rawOccupancy !== null) {
    if (!Array.isArray(rawOccupancy)) {
      return err(
        expenseError("validation", "selector.occupancy must be an array.", {
          field: "selector.occupancy",
        }),
      );
    }
    for (const status of rawOccupancy) {
      if (
        typeof status !== "string" ||
        !(OCCUPANCY_STATUSES as readonly string[]).includes(status)
      ) {
        return err(
          expenseError(
            "validation",
            `occupancy must be one of ${OCCUPANCY_STATUSES.join(", ")}.`,
            { field: "selector.occupancy" },
          ),
        );
      }
      occupancy.push(status as OccupancyStatus);
    }
  }

  const includeVacant = input["includeVacant"];
  if (
    includeVacant !== undefined &&
    includeVacant !== null &&
    typeof includeVacant !== "boolean"
  ) {
    return err(
      expenseError("validation", "includeVacant must be true or false.", {
        field: "selector.includeVacant",
      }),
    );
  }

  const ownerOnly = input["ownerOnly"];
  if (
    ownerOnly !== undefined &&
    ownerOnly !== null &&
    typeof ownerOnly !== "boolean"
  ) {
    return err(
      expenseError("validation", "ownerOnly must be true or false.", {
        field: "selector.ownerOnly",
      }),
    );
  }

  return ok(
    Object.freeze({
      scope,
      // Sorted and de-duplicated so the value is canonical: `["b","a","a"]` and
      // `["a","b"]` are one selector, which is what makes a stored selector
      // comparable and the resolution independent of the array's order.
      buildings: Object.freeze(sortedStrings(buildings)),
      wings: Object.freeze(sortedStrings(wings)),
      floors: Object.freeze(sortedNumbers(floors)),
      occupancy: Object.freeze(
        sortedStrings(occupancy).sort(
          (left, right) =>
            OCCUPANCY_STATUSES.indexOf(left) -
            OCCUPANCY_STATUSES.indexOf(right),
        ),
      ),
      excludeApartments: Object.freeze(sortedStrings(excludeApartments)),
      includeVacant: includeVacant === undefined ? null : includeVacant,
      ownerOnly: ownerOnly === true,
    }),
  );
}

function isParticipantScope(value: string): value is ParticipantScope {
  return (PARTICIPANT_SCOPES as readonly string[]).includes(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Byte-wise (`<`), which is `COLLATE "C"` — the same order the ids index in. */
function sortedStrings<T extends string>(values: readonly T[]): T[] {
  return unique(values).sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
}

function sortedNumbers(values: readonly number[]): number[] {
  return unique(values).sort((left, right) => left - right);
}
