import {
  BUILDING_NAME_MAX_LENGTH,
  DISPLAY_ORDER_MAX,
  DISPLAY_ORDER_MIN,
  TOTAL_FLOORS_MAX,
  TOTAL_FLOORS_MIN,
} from "@ses/domain";
import { z } from "zod";

/**
 * Building wire contract (SAD §7: DTOs are Zod schemas in `packages/contracts`,
 * validated identically by the client and the API — a rule can never drift
 * between the two, PRD §18.1).
 *
 * The bounds are **imported from `@ses/domain`** rather than repeated as
 * literals. A `z.number().max(200)` here and a `TOTAL_FLOORS_MAX = 200` there is
 * two definitions of one rule, and the way that fails is asymmetric: the client
 * accepts a value, the server refuses it, and the user sees a validation error
 * for a field the form said was fine.
 *
 * Request bodies are strict and response schemas are not, for the reason
 * `society.ts` records in full (SAD §7.8 stage 1): an unknown inbound field is a
 * caller mistake worth reporting, while an added outbound field must not break a
 * client that has not been rebuilt.
 */

export const createBuildingSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Enter a building name")
    .max(BUILDING_NAME_MAX_LENGTH),
  /**
   * Optional, and `.optional()` rather than `.nullable()`: "not recorded" is a
   * genuinely absent value, and accepting an explicit `null` here would give the
   * client two ways to say one thing — one of which the update path treats
   * differently from the create path.
   */
  totalFloors: z
    .number()
    .int()
    .min(
      TOTAL_FLOORS_MIN,
      `Between ${TOTAL_FLOORS_MIN} and ${TOTAL_FLOORS_MAX}`,
    )
    .max(
      TOTAL_FLOORS_MAX,
      `Between ${TOTAL_FLOORS_MIN} and ${TOTAL_FLOORS_MAX}`,
    )
    .optional(),
  displayOrder: z
    .number()
    .int()
    .min(DISPLAY_ORDER_MIN)
    .max(DISPLAY_ORDER_MAX)
    .optional(),
});
export type CreateBuildingPayload = z.infer<typeof createBuildingSchema>;

/**
 * Update = create with every field optional, never an empty patch.
 *
 * The `refine` is the same rule `updateSocietySchema` carries and it is load
 * bearing rather than tidy: an empty body would otherwise reach the use case,
 * which would reject it as `validation` — the right answer, but arriving as a 422
 * whose message no form field can be attached to, when what the caller actually
 * did was send a request with nothing in it.
 */
export const updateBuildingSchema = createBuildingSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });
export type UpdateBuildingPayload = z.infer<typeof updateBuildingSchema>;

export const buildingSchema = z.object({
  id: z.string(),
  societyId: z.string(),
  name: z.string(),
  /** `null` = the floor count has not been recorded; never 0. */
  totalFloors: z.number().int().nullable(),
  displayOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type BuildingDto = z.infer<typeof buildingSchema>;

export const buildingListSchema = z.array(buildingSchema);
export type BuildingListDto = z.infer<typeof buildingListSchema>;

/**
 * `POST /buildings` and `PATCH /buildings/:buildingId` — the building alone.
 *
 * No capabilities block on a write: a caller that just changed a building already
 * received the capabilities with the read that put it on screen, and a failed
 * write carries a status rather than a permission summary.
 */
export const buildingResponseSchema = z.object({
  building: buildingSchema,
});
export type BuildingResponseDto = z.infer<typeof buildingResponseSchema>;

/**
 * `GET /buildings` — every building, plus what the caller may do with them.
 *
 * The capabilities travel with the list because that is where they are *used*: a
 * list screen has to decide whether to render an "Add building" affordance and
 * whether each row's edit and delete are available, and computing that from a role
 * string in the screen is exactly what SAD §9.3 forbids.
 */
export const buildingListResponseSchema = z.object({
  buildings: buildingListSchema,
  capabilities: z.object({
    canManage: z.boolean(),
    canView: z.boolean(),
  }),
});
export type BuildingListResponseDto = z.infer<
  typeof buildingListResponseSchema
>;

/** `GET /buildings/:buildingId` — one building and the caller's capabilities. */
export const buildingDetailResponseSchema = z.object({
  building: buildingSchema,
  capabilities: z.object({
    canManage: z.boolean(),
    canView: z.boolean(),
  }),
});
export type BuildingDetailResponseDto = z.infer<
  typeof buildingDetailResponseSchema
>;
