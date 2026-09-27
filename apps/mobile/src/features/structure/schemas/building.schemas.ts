import type { CreateBuildingPayload, UpdateBuildingPayload } from '@ses/contracts';
import {
  BUILDING_NAME_MAX_LENGTH,
  DISPLAY_ORDER_MAX,
  DISPLAY_ORDER_MIN,
  isStructureError,
  TOTAL_FLOORS_MAX,
  TOTAL_FLOORS_MIN,
} from '@ses/domain';
import type { Building } from '@ses/domain';
import { z } from 'zod';

import { sesResolver } from '@/lib/forms/resolver';

/**
 * Form schema + mappers for the structure feature.
 *
 * WHY SEPARATE FROM THE CONTRACT: the same reason `society.schemas.ts` gives in
 * full — `packages/contracts` describes the *payload* (integers, bounds, enums)
 * because that is what crosses the wire and what the API validates, while a form
 * is all-strings because that is what a text field yields. Coercing inside the
 * resolver would make React Hook Form's types lie about what the user typed. The
 * mappers below are the single conversion point, and the service validates the
 * payload again against the contract before it reaches a use case.
 *
 * The bounds are **imported from `@ses/domain`** rather than written as literals
 * here, for the reason the wire schemas are: a `max(80)` in one place and
 * `BUILDING_NAME_MAX_LENGTH = 80` in another is two definitions of one rule, and
 * the way that fails is that the form accepts what the server refuses.
 */

/** A non-negative integer typed into a text field, or the empty string. */
const optionalInteger = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => value.length === 0 || /^\d{1,4}$/.test(value), `${label} must be a number`)
    .refine(
      (value) => value.length === 0 || (Number(value) >= min && Number(value) <= max),
      `${label} must be between ${min} and ${max}`,
    );

export const buildingFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a building name')
    .max(
      BUILDING_NAME_MAX_LENGTH,
      `Building name must be ${BUILDING_NAME_MAX_LENGTH} characters or fewer`,
    ),
  /**
   * Empty is a real value here, not a missing one: `null` in the database means
   * "the floor count has not been recorded", and `Building.totalFloors` is
   * nullable for exactly that reason. Forcing a number would make the app record a
   * count the society never gave.
   */
  totalFloors: optionalInteger('Floor count', TOTAL_FLOORS_MIN, TOTAL_FLOORS_MAX),
  displayOrder: optionalInteger('Display order', DISPLAY_ORDER_MIN, DISPLAY_ORDER_MAX),
});

export type BuildingFormValues = z.infer<typeof buildingFormSchema>;

export const buildingFormResolver = sesResolver(buildingFormSchema);

export function emptyBuildingForm(): BuildingFormValues {
  return { name: '', totalFloors: '', displayOrder: String(DISPLAY_ORDER_MIN) };
}

/** Prefill the edit form from a building (`null` floors → an empty field). */
export function buildingToFormValues(building: Building): BuildingFormValues {
  return {
    name: building.name,
    totalFloors: building.totalFloors === null ? '' : String(building.totalFloors),
    displayOrder: String(building.displayOrder),
  };
}

/**
 * Form → create payload.
 *
 * An empty optional field is **omitted**, never sent as `null` or `0`: the
 * contract makes both optional, the database distinguishes "not recorded" from
 * "zero floors", and `0` is not a legal floor count (`TOTAL_FLOORS_MIN` is 1).
 */
export function formValuesToCreatePayload(values: BuildingFormValues): CreateBuildingPayload {
  return {
    name: values.name.trim(),
    ...(values.totalFloors.trim().length === 0 ? {} : { totalFloors: Number(values.totalFloors) }),
    ...(values.displayOrder.trim().length === 0
      ? {}
      : { displayOrder: Number(values.displayOrder) }),
  };
}

/**
 * Form → update payload.
 *
 * Deliberately **not** the create payload with a different name, even though it
 * computes the same object today. A PATCH omits what it does not change, so an
 * empty floor field means "leave it alone" — the domain records that a floor count
 * can never be cleared to unknown, only set at creation. Sending the field as
 * `undefined` would be indistinguishable from omitting it, which is what makes
 * this identical in practice; keeping it a separate function is what stops a later
 * change to the create path (a default, a derived order) from silently becoming a
 * write on every edit.
 */
export function formValuesToUpdatePayload(values: BuildingFormValues): UpdateBuildingPayload {
  return {
    name: values.name.trim(),
    ...(values.totalFloors.trim().length === 0 ? {} : { totalFloors: Number(values.totalFloors) }),
    ...(values.displayOrder.trim().length === 0
      ? {}
      : { displayOrder: Number(values.displayOrder) }),
  };
}

const FORM_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'totalFloors',
  'displayOrder',
] satisfies ReadonlyArray<keyof BuildingFormValues>);

/**
 * The form input a failed request belongs to, when the server named one.
 *
 * A duplicate building name is not a banner — it is this input's problem, and the
 * API deliberately says so: `toAppError` attaches `field: "name"` to a conflict for
 * exactly this reason, so the user sees the error under the box they typed in
 * instead of parsing a message to work out which one is wrong.
 *
 * The returned name is checked against this form's own fields first. The server's
 * vocabulary is broader than one form's, and an unrecognised name passed to
 * `setError` would create an error key no input ever renders — an invisible failure.
 */
export function formFieldOfError(error: unknown): keyof BuildingFormValues | undefined {
  if (!isStructureError(error)) return undefined;
  const field = error.details?.field;
  return typeof field === 'string' && FORM_FIELDS.has(field)
    ? (field as keyof BuildingFormValues)
    : undefined;
}
