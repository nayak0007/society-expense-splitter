import {
  AREA_MAX_SQFT,
  AREA_MIN_SQFT,
  APARTMENT_NUMBER_MAX_LENGTH,
  BHK_MAX,
  BHK_MIN,
  FLOOR_MAX,
  FLOOR_MIN,
  MAX_PATTERN_APARTMENTS,
  OCCUPANCY_STATUSES,
  PARKING_SLOTS_MAX,
  PARKING_SLOTS_MIN,
  SHARE_UNITS_MAX,
  SHARE_UNITS_MIN,
  UNITS_PER_FLOOR_MAX,
} from "@ses/domain";
import { z } from "zod";

/**
 * Apartment wire contract (SAD §7: DTOs are Zod schemas in `packages/contracts`,
 * validated identically by the client and the API — a rule can never drift between
 * the two, PRD §18.1).
 *
 * Bounds are **imported from `@ses/domain`** rather than repeated as literals, for
 * the reason `structure.ts` records: a `z.number().max(20)` here and a
 * `PARKING_SLOTS_MAX = 20` there is two definitions of one rule, and the way that
 * fails is asymmetric — the client accepts a value, the server refuses it, and the
 * user sees a validation error for a field the form said was fine.
 *
 * Request bodies are strict and responses are not (SAD §7.8 stage 1): an unknown
 * inbound field is a caller mistake worth reporting, while an added outbound field
 * must not break a client that has not been rebuilt.
 *
 * ## `null` versus absent, spelled out
 *
 * Every optional *measurement* is `.nullable().optional()`: absent means "leave it
 * alone" (on a patch) and `null` means "no longer recorded". Both are needed, and
 * the database distinguishes them — the columns are nullable, and a society that
 * discovers a wrong area wants to stop claiming it rather than be forced to keep a
 * number it does not believe. `apartmentNumber` is the one required field.
 */

const apartmentFields = {
  apartmentNumber: z
    .string()
    .trim()
    .min(1, "Enter a flat number")
    .max(
      APARTMENT_NUMBER_MAX_LENGTH,
      `Flat number must be at most ${APARTMENT_NUMBER_MAX_LENGTH} characters`,
    ),
  /**
   * The wing, as an id rather than a nested object: wings have no write API yet
   * (Roadmap T043), so accepting one here would be accepting a reference the caller
   * cannot have created. It is in the contract because the column and its foreign
   * key are in the schema — and because the composite key that ties a wing to its
   * *building* is the database's rule, not this schema's, so a wrong wing arrives
   * as a field-named validation error rather than as a shape the client must
   * pre-check.
   */
  wingId: z.uuid().nullable().optional(),
  floor: z
    .number()
    .int()
    .min(FLOOR_MIN, `Between ${FLOOR_MIN} and ${FLOOR_MAX}`)
    .max(FLOOR_MAX, `Between ${FLOOR_MIN} and ${FLOOR_MAX}`)
    .nullable()
    .optional(),
  bhk: z
    .number()
    .min(BHK_MIN, `Between ${BHK_MIN} and ${BHK_MAX} BHK`)
    .max(BHK_MAX, `Between ${BHK_MIN} and ${BHK_MAX} BHK`)
    .nullable()
    .optional(),
  /** `0` is refused here although the column allows it — see `createArea()`. */
  carpetAreaSqft: z
    .number()
    .gt(AREA_MIN_SQFT, `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`)
    .max(AREA_MAX_SQFT, `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`)
    .nullable()
    .optional(),
  builtupAreaSqft: z
    .number()
    .gt(AREA_MIN_SQFT, `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`)
    .max(AREA_MAX_SQFT, `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`)
    .nullable()
    .optional(),
  parkingSlots: z
    .number()
    .int()
    .min(
      PARKING_SLOTS_MIN,
      `Between ${PARKING_SLOTS_MIN} and ${PARKING_SLOTS_MAX}`,
    )
    .max(
      PARKING_SLOTS_MAX,
      `Between ${PARKING_SLOTS_MIN} and ${PARKING_SLOTS_MAX}`,
    )
    .optional(),
  shareUnits: z
    .number()
    .min(SHARE_UNITS_MIN, `Between ${SHARE_UNITS_MIN} and ${SHARE_UNITS_MAX}`)
    .max(SHARE_UNITS_MAX, `Between ${SHARE_UNITS_MIN} and ${SHARE_UNITS_MAX}`)
    .optional(),
  occupancyStatus: z.enum(OCCUPANCY_STATUSES).optional(),
  isCommercial: z.boolean().optional(),
  isBillable: z.boolean().optional(),
};

/**
 * The cross-field rule, shared by create and update.
 *
 * It lives in the schema rather than only in the domain because a `superRefine`
 * here fails at the *wire boundary* with the issue attached to
 * `builtupAreaSqft` — which is the difference between a form highlighting one input
 * and a form showing a banner for a two-field problem. `createAreaPair()` in the
 * domain states the same rule for the mobile use-case path, and both call it a
 * validation failure, so the two orders of failure are indistinguishable to the
 * caller.
 */
function areaOrdering(value: {
  readonly carpetAreaSqft?: number | null | undefined;
  readonly builtupAreaSqft?: number | null | undefined;
}): boolean {
  const carpet = value.carpetAreaSqft;
  const builtup = value.builtupAreaSqft;
  if (carpet === undefined || carpet === null) return true;
  if (builtup === undefined || builtup === null) return true;
  return builtup >= carpet;
}

const AREA_ORDERING = {
  message: "Built-up area cannot be smaller than the carpet area",
  path: ["builtupAreaSqft"],
};

export const createApartmentSchema = z
  .strictObject(apartmentFields)
  .refine(areaOrdering, AREA_ORDERING);
export type CreateApartmentPayload = z.infer<typeof createApartmentSchema>;

/**
 * Update = the same fields, every one optional, never an empty patch.
 *
 * The `refine` is the rule `updateBuildingSchema` carries and for the same reason:
 * an empty body would otherwise reach the use case, which rejects it as
 * `validation` — the right answer, arriving as a 422 whose message no form field
 * can be attached to, when what the caller actually did was send a request with
 * nothing in it.
 */
export const updateApartmentSchema = z
  .strictObject(apartmentFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  })
  .refine(areaOrdering, AREA_ORDERING);
export type UpdateApartmentPayload = z.infer<typeof updateApartmentSchema>;

export const apartmentSchema = z.object({
  id: z.string(),
  societyId: z.string(),
  buildingId: z.string(),
  wingId: z.string().nullable(),
  apartmentNumber: z.string(),
  /** `null` = not recorded; `0` is the ground floor. Never the same thing. */
  floor: z.number().int().nullable(),
  bhk: z.number().nullable(),
  carpetAreaSqft: z.number().nullable(),
  builtupAreaSqft: z.number().nullable(),
  parkingSlots: z.number().int(),
  shareUnits: z.number(),
  occupancyStatus: z.enum(OCCUPANCY_STATUSES),
  isCommercial: z.boolean(),
  isBillable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type ApartmentDto = z.infer<typeof apartmentSchema>;

export const apartmentListSchema = z.array(apartmentSchema);
export type ApartmentListDto = z.infer<typeof apartmentListSchema>;

/** `POST` and `PATCH` — the flat alone, with no capabilities block (see `structure.ts`). */
export const apartmentResponseSchema = z.object({
  apartment: apartmentSchema,
});
export type ApartmentResponseDto = z.infer<typeof apartmentResponseSchema>;

/** `GET /buildings/:buildingId/apartments` — the flats, plus what the caller may do. */
export const apartmentListResponseSchema = z.object({
  apartments: apartmentListSchema,
  capabilities: z.object({
    canManage: z.boolean(),
    canView: z.boolean(),
  }),
});
export type ApartmentListResponseDto = z.infer<
  typeof apartmentListResponseSchema
>;

/** `GET /apartments/:apartmentId` — one flat and the caller's capabilities. */
export const apartmentDetailResponseSchema = z.object({
  apartment: apartmentSchema,
  capabilities: z.object({
    canManage: z.boolean(),
    canView: z.boolean(),
  }),
});
export type ApartmentDetailResponseDto = z.infer<
  typeof apartmentDetailResponseSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Bulk create (T043) and pattern generation (T044)
// ─────────────────────────────────────────────────────────────────────────────
//
// Both are **one request, many flats**, and both answer with a per-row report —
// which is why the report line is the same shape nowhere: bulk create reports
// what happened to *your* rows (`created` / `existing` / `duplicate` / `invalid`),
// while the generator reports whether the batch it expanded would land. The
// request bounds that are domain facts are imported from `@ses/domain`, like every
// other bound in this file.

/**
 * `POST /buildings/:buildingId/apartments/bulk` — the per-row payload.
 *
 * A row is a flat with fewer things said about it: `apartmentNumber` is required
 * and everything else is optional, taking the same default the single-flat form
 * resolves. The upper bound is the generator's cap (`MAX_PATTERN_APARTMENTS`),
 * so a paste can never ask for more than a generation can produce — one bound,
 * one reason, stated once.
 */
export const bulkCreateApartmentsRequestSchema = z.strictObject({
  rows: z
    .array(
      z
        .strictObject({
          apartmentNumber: z
            .string()
            .trim()
            .min(1, "Enter a flat number")
            .max(
              APARTMENT_NUMBER_MAX_LENGTH,
              `Flat number must be at most ${APARTMENT_NUMBER_MAX_LENGTH} characters`,
            ),
          wingId: z.uuid().nullable().optional(),
          floor: z
            .number()
            .int()
            .min(FLOOR_MIN, `Between ${FLOOR_MIN} and ${FLOOR_MAX}`)
            .max(FLOOR_MAX, `Between ${FLOOR_MIN} and ${FLOOR_MAX}`)
            .nullable()
            .optional(),
          bhk: z
            .number()
            .min(BHK_MIN, `Between ${BHK_MIN} and ${BHK_MAX} BHK`)
            .max(BHK_MAX, `Between ${BHK_MIN} and ${BHK_MAX} BHK`)
            .nullable()
            .optional(),
          carpetAreaSqft: z
            .number()
            .gt(
              AREA_MIN_SQFT,
              `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`,
            )
            .max(
              AREA_MAX_SQFT,
              `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`,
            )
            .nullable()
            .optional(),
          builtupAreaSqft: z
            .number()
            .gt(
              AREA_MIN_SQFT,
              `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`,
            )
            .max(
              AREA_MAX_SQFT,
              `Between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft`,
            )
            .nullable()
            .optional(),
          parkingSlots: z
            .number()
            .int()
            .min(
              PARKING_SLOTS_MIN,
              `Between ${PARKING_SLOTS_MIN} and ${PARKING_SLOTS_MAX}`,
            )
            .max(
              PARKING_SLOTS_MAX,
              `Between ${PARKING_SLOTS_MIN} and ${PARKING_SLOTS_MAX}`,
            )
            .optional(),
          shareUnits: z
            .number()
            .min(
              SHARE_UNITS_MIN,
              `Between ${SHARE_UNITS_MIN} and ${SHARE_UNITS_MAX}`,
            )
            .max(
              SHARE_UNITS_MAX,
              `Between ${SHARE_UNITS_MIN} and ${SHARE_UNITS_MAX}`,
            )
            .optional(),
          occupancyStatus: z.enum(OCCUPANCY_STATUSES).optional(),
          isCommercial: z.boolean().optional(),
          isBillable: z.boolean().optional(),
        })
        // The pair rule rides on each row for the reason `createApartmentSchema`
        // carries it: the failure is attached to the row's own built-up field,
        // not to a banner the caller has to correlate with a line number.
        .refine(areaOrdering, AREA_ORDERING),
    )
    .min(1, "Add at least one row")
    .max(
      MAX_PATTERN_APARTMENTS,
      `At most ${MAX_PATTERN_APARTMENTS.toLocaleString("en-IN")} flats per request`,
    ),
});
export type BulkCreateApartmentsRequestDto = z.infer<
  typeof bulkCreateApartmentsRequestSchema
>;

/**
 * One line of the bulk report, in input order. `invalid` carries the field and
 * the reason; the other statuses name themselves. Requests are strict so a
 * typo'd row is a `400` naming the offending key; the report is not.
 */
export const bulkCreateApartmentOutcomeSchema = z.object({
  apartmentNumber: z.string(),
  status: z.enum(["created", "existing", "duplicate", "invalid"]),
  field: z.string().optional(),
  message: z.string().optional(),
});

export const bulkCreateApartmentsResponseSchema = z.object({
  total: z.number().int(),
  createdCount: z.number().int(),
  existingCount: z.number().int(),
  duplicateCount: z.number().int(),
  invalidCount: z.number().int(),
  outcomes: z.array(bulkCreateApartmentOutcomeSchema),
  /** The created flats in full — the same shape a single create returns, so a
   * client maps one type, not two. */
  created: z.array(apartmentSchema),
});
export type BulkCreateApartmentsResponseDto = z.infer<
  typeof bulkCreateApartmentsResponseSchema
>;

/**
 * `POST /buildings/:buildingId/apartments/generate` — the pattern request.
 *
 * The grammar lives in `@ses/domain` (`generateApartmentNumbers`), so this schema
 * checks only what the wire has to bound before the domain sees it: a non-empty
 * pattern, the dimension lists, and the optional bookends. Everything else —
 * token spelling, `{unit}` presence, the 2,000 cap, ground-floor `G` — is the
 * domain's `validation` error and arrives as `422` naming the field.
 */
export const generateApartmentsRequestSchema = z.strictObject({
  pattern: z.string().trim().min(1, "Enter a pattern").max(120),
  floors: z
    .array(
      z
        .number()
        .int()
        .min(FLOOR_MIN, `Between ${FLOOR_MIN} and ${FLOOR_MAX}`)
        .max(FLOOR_MAX, `Between ${FLOOR_MIN} and ${FLOOR_MAX}`),
    )
    .max(
      FLOOR_MAX - FLOOR_MIN + 1,
      `At most ${FLOOR_MAX - FLOOR_MIN + 1} floors`,
    ),
  unitsPerFloor: z
    .number()
    .int()
    .min(1, "At least 1 unit per floor")
    .max(UNITS_PER_FLOOR_MAX, `At most ${UNITS_PER_FLOOR_MAX} units per floor`),
  /** Required by the domain when the pattern carries `{wing}`; ignored otherwise. */
  wings: z
    .array(
      z.strictObject({
        /** `null` labels a wing-less building while still rendering the label. */
        id: z.uuid().nullable(),
        label: z.string().trim().min(1, "Every wing needs a label").max(24),
      }),
    )
    .max(MAX_PATTERN_APARTMENTS)
    .optional(),
  prefix: z.string().max(24).optional(),
  suffix: z.string().max(24).optional(),
  /**
   * `true` → the batch is expanded and reported with **no write**; `false` →
   * everything that does not already exist is created. Absent resolves to a
   * preview at the edge: a client that forgets the flag gets a report it can
   * confirm, never a surprise write.
   */
  dryRun: z.boolean().optional(),
});
export type GenerateApartmentsRequestDto = z.infer<
  typeof generateApartmentsRequestSchema
>;

/** One line of the generation report, in generation order. */
export const generatedApartmentRowSchema = z.object({
  apartmentNumber: z.string(),
  floor: z.number().int().nullable(),
  wingId: z.string().nullable(),
  status: z.enum(["created", "skipped"]),
});

export const generateApartmentsResponseSchema = z.object({
  dryRun: z.boolean(),
  total: z.number().int(),
  createdCount: z.number().int(),
  skippedCount: z.number().int(),
  rows: z.array(generatedApartmentRowSchema),
});
export type GenerateApartmentsResponseDto = z.infer<
  typeof generateApartmentsResponseSchema
>;
