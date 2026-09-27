import type { CreateApartmentPayload, UpdateApartmentPayload } from '@ses/contracts';
import {
  APARTMENT_NUMBER_MAX_LENGTH,
  AREA_MAX_SQFT,
  AREA_MIN_SQFT,
  BHK_MAX,
  BHK_MIN,
  FLOOR_MAX,
  FLOOR_MIN,
  isStructureError,
  OCCUPANCY_STATUSES,
  PARKING_SLOTS_MAX,
  PARKING_SLOTS_MIN,
  SHARE_UNITS_MAX,
  SHARE_UNITS_MIN,
} from '@ses/domain';
import type { Apartment, OccupancyStatus } from '@ses/domain';
import { z } from 'zod';

import { sesResolver } from '@/lib/forms/resolver';

/**
 * Form schema + mappers for the flat form.
 *
 * WHY SEPARATE FROM THE CONTRACT, and why every field is a `string`: the same
 * reason `building.schemas.ts` gives — `packages/contracts` describes the *payload*
 * (numbers, bounds, enums) because that is what crosses the wire, while a form is
 * all-strings because that is what a text field yields. Coercing inside the
 * resolver would make React Hook Form's types lie about what the user typed. The
 * mappers below are the single conversion point, and the service validates the
 * payload against the contract again before it reaches a use case.
 *
 * ## Empty means two different things, and the form is where that is decided
 *
 * On **create**, an empty measurement is omitted: nothing has been recorded, and
 * the column's `null` says exactly that. On **edit**, an empty measurement is
 * `null` — the user cleared a field that had a value, which is a real, intended
 * change (`UpdateApartmentInput` documents `undefined` as "leave alone" and `null`
 * as "no longer recorded"). `building.schemas.ts` has the opposite rule because a
 * building's floor count can never be cleared; this is the one place the two forms
 * must diverge, and it is why they are not one file.
 *
 * ## `0` is rejected in the two areas and accepted in the two weights
 *
 * Carpet and built-up area must be **greater than zero** — PRD §4's per-sqft split
 * divides by them — while `parkingSlots: 0` and `shareUnits: 0` are legitimate
 * ("no allotted slot", "exempt from share-based splits"). The bounds come from
 * `@ses/domain`, so the form cannot accept what the value objects refuse.
 */

/**
 * An optional whole number typed into a text field, or the empty string.
 *
 * `\d{1,4}` with an optional leading `-` rather than a `Number()` check, so
 * `"12abc"` fails at the input instead of becoming `NaN` and reaching the contract
 * as `null`.
 */
const optionalInteger = (label: string, min: number, max: number) => {
  const pattern = min < 0 ? /^-?\d{1,4}$/ : /^\d{1,4}$/;
  return z
    .string()
    .trim()
    .refine((value) => value.length === 0 || pattern.test(value), `${label} must be a whole number`)
    .refine(
      (value) => value.length === 0 || (Number(value) >= min && Number(value) <= max),
      `${label} must be between ${min} and ${max}`,
    );
};

/**
 * An optional decimal typed into a text field, limited to `decimals` places.
 *
 * The place limit is what enforces the domain's half-step rule for BHK
 * (`createBhk` rejects `1.25` rather than rounding it): a form that accepted two
 * decimals would produce a value the use case refuses, and the user would see a
 * server error for something the form said was fine.
 */
const optionalDecimal = (label: string, min: number, max: number, decimals: number) => {
  const pattern = new RegExp(`^\\d{1,6}(\\.\\d{1,${decimals}})?$`);
  return z
    .string()
    .trim()
    .refine(
      (value) => value.length === 0 || pattern.test(value),
      `${label} must be a number with at most ${decimals} decimal place${decimals === 1 ? '' : 's'}`,
    )
    .refine(
      (value) => value.length === 0 || (Number(value) >= min && Number(value) <= max),
      `${label} must be between ${min} and ${max}`,
    );
};

/** An optional area, which must be **greater than** zero — never zero itself. */
const optionalArea = (label: string) =>
  optionalDecimal(label, AREA_MIN_SQFT, AREA_MAX_SQFT, 2).refine(
    (value) => value.length === 0 || Number(value) > AREA_MIN_SQFT,
    `${label} must be more than ${AREA_MIN_SQFT} sq ft`,
  );

export const apartmentFormSchema = z
  .object({
    apartmentNumber: z
      .string()
      .trim()
      .min(1, 'Enter a flat number')
      .max(
        APARTMENT_NUMBER_MAX_LENGTH,
        `Flat number must be ${APARTMENT_NUMBER_MAX_LENGTH} characters or fewer`,
      ),
    floor: optionalInteger('Floor', FLOOR_MIN, FLOOR_MAX),
    bhk: optionalDecimal('Configuration', BHK_MIN, BHK_MAX, 1),
    carpetAreaSqft: optionalArea('Carpet area'),
    builtupAreaSqft: optionalArea('Built-up area'),
    parkingSlots: optionalInteger('Parking slots', PARKING_SLOTS_MIN, PARKING_SLOTS_MAX),
    shareUnits: optionalDecimal('Share units', SHARE_UNITS_MIN, SHARE_UNITS_MAX, 3),
    /**
     * The enum is a value in the form rather than text: it is the only field whose
     * legal values are a closed list, and rendering it as free text would mean
     * validating what the user typed against the same list anyway.
     */
    occupancyStatus: z.enum(OCCUPANCY_STATUSES),
    isCommercial: z.boolean(),
    isBillable: z.boolean(),
  })
  /**
   * The cross-field rule, stated here as well as in `@ses/contracts` and in the
   * domain, so the user sees it under the built-up field rather than as a banner
   * after a round trip. The three copies cannot drift into disagreement: the
   * message is the same, the field is the same, and the payload is re-validated
   * against the contract by the service.
   */
  .refine(
    (values) => {
      const carpet = values.carpetAreaSqft.trim();
      const builtup = values.builtupAreaSqft.trim();
      if (carpet.length === 0 || builtup.length === 0) return true;
      return Number(builtup) >= Number(carpet);
    },
    {
      message: 'Built-up area cannot be smaller than the carpet area',
      path: ['builtupAreaSqft'],
    },
  );

export type ApartmentFormValues = z.infer<typeof apartmentFormSchema>;

export const apartmentFormResolver = sesResolver(apartmentFormSchema);

/**
 * A new flat: empty measurements, and the column defaults the API would apply
 * anyway — spelled out so the form shows the state that will be stored.
 */
export function emptyApartmentForm(): ApartmentFormValues {
  return {
    apartmentNumber: '',
    floor: '',
    bhk: '',
    carpetAreaSqft: '',
    builtupAreaSqft: '',
    parkingSlots: '0',
    shareUnits: '1',
    occupancyStatus: 'vacant',
    isCommercial: false,
    isBillable: true,
  };
}

/** Prefill the edit form from a flat (`null` measurements → empty fields). */
export function apartmentToFormValues(apartment: Apartment): ApartmentFormValues {
  const text = (value: number | null): string => (value === null ? '' : String(value));
  return {
    apartmentNumber: apartment.apartmentNumber,
    floor: text(apartment.floor),
    bhk: text(apartment.bhk),
    carpetAreaSqft: text(apartment.carpetAreaSqft),
    builtupAreaSqft: text(apartment.builtupAreaSqft),
    parkingSlots: String(apartment.parkingSlots),
    shareUnits: String(apartment.shareUnits),
    occupancyStatus: apartment.occupancyStatus,
    isCommercial: apartment.isCommercial,
    isBillable: apartment.isBillable,
  };
}

/** A measurement the user may leave blank: absent on create, `null` on edit. */
function measurement(value: string, cleared: 'omit' | 'null'): number | null | undefined {
  if (value.trim().length > 0) return Number(value);
  return cleared === 'null' ? null : undefined;
}

/**
 * Form → create payload.
 *
 * Empty measurements are **omitted**, never sent as `null` or `0`: the contract
 * makes them optional, and `0` is not a legal area. The four fields with a column
 * default are always sent, because the form always shows a value for them — the
 * defaults are visible and the user can change them, so "the server picked it"
 * would describe a choice the user actually made.
 */
export function formValuesToCreatePayload(values: ApartmentFormValues): CreateApartmentPayload {
  const floor = measurement(values.floor, 'omit');
  const bhk = measurement(values.bhk, 'omit');
  const carpetAreaSqft = measurement(values.carpetAreaSqft, 'omit');
  const builtupAreaSqft = measurement(values.builtupAreaSqft, 'omit');

  return {
    apartmentNumber: values.apartmentNumber.trim(),
    ...(floor === undefined ? {} : { floor }),
    ...(bhk === undefined ? {} : { bhk }),
    ...(carpetAreaSqft === undefined ? {} : { carpetAreaSqft }),
    ...(builtupAreaSqft === undefined ? {} : { builtupAreaSqft }),
    parkingSlots: Number(values.parkingSlots),
    shareUnits: Number(values.shareUnits),
    occupancyStatus: values.occupancyStatus,
    isCommercial: values.isCommercial,
    isBillable: values.isBillable,
  };
}

/**
 * Form → update payload.
 *
 * An emptied measurement becomes `null` — "no longer recorded" — while a field the
 * form did not have at all (never set) would be absent. The distinction is the
 * whole reason this is a separate function rather than a flag on the create one.
 */
export function formValuesToUpdatePayload(values: ApartmentFormValues): UpdateApartmentPayload {
  return {
    apartmentNumber: values.apartmentNumber.trim(),
    floor: measurement(values.floor, 'null') ?? null,
    bhk: measurement(values.bhk, 'null') ?? null,
    carpetAreaSqft: measurement(values.carpetAreaSqft, 'null') ?? null,
    builtupAreaSqft: measurement(values.builtupAreaSqft, 'null') ?? null,
    parkingSlots: Number(values.parkingSlots),
    shareUnits: Number(values.shareUnits),
    occupancyStatus: values.occupancyStatus,
    isCommercial: values.isCommercial,
    isBillable: values.isBillable,
  };
}

const FORM_FIELDS: ReadonlySet<string> = new Set([
  'apartmentNumber',
  'floor',
  'bhk',
  'carpetAreaSqft',
  'builtupAreaSqft',
  'parkingSlots',
  'shareUnits',
  'occupancyStatus',
] satisfies ReadonlyArray<keyof ApartmentFormValues>);

/**
 * The form input a failed request belongs to, when the server named one.
 *
 * A duplicate flat number is not a banner — it is the number input's problem, and
 * the API says so: the flat adapter attaches `field: 'apartmentNumber'` to the
 * conflict. The name is checked against this form's own fields first, because the
 * server's vocabulary is broader than one form's and an unrecognised name passed to
 * `setError` would create an error key no input renders — an invisible failure.
 */
export function formFieldOfError(error: unknown): keyof ApartmentFormValues | undefined {
  if (!isStructureError(error)) return undefined;
  const field = error.details?.field;
  return typeof field === 'string' && FORM_FIELDS.has(field)
    ? (field as keyof ApartmentFormValues)
    : undefined;
}

/** The label a person reads for an occupancy status, in one place. */
export const OCCUPANCY_STATUS_LABELS: Readonly<Record<OccupancyStatus, string>> = {
  owner_occupied: 'Owner occupied',
  rented: 'Rented',
  vacant: 'Vacant',
  under_construction: 'Under construction',
};
