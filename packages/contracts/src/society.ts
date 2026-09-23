import { JOIN_CODE_PATTERN, OCCUPANCY_TYPES, SOCIETY_TYPES } from "@ses/domain";
import { z } from "zod";

import { societyTypeSchema } from "./primitives";

/**
 * Society wire contract (SAD §7: DTOs are Zod schemas in `packages/contracts`,
 * validated identically by the client and the API — a rule can never drift
 * between the two, PRD §18.1).
 *
 * Numbers here are the *payload* shape (days are integers, money is paise).
 * Forms keep their own all-string schemas in the feature and map onto these —
 * text inputs should not need coercion to satisfy a resolver.
 */

export const joinCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    JOIN_CODE_PATTERN,
    "A join code is 6 letters or digits (no 0, O, 1 or I)",
  );

const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Enter a 6-digit PIN code");

/**
 * Request bodies are **strict**; response schemas are not.
 *
 * SAD §7.8 stage 1 requires it: an unknown field is a `400`, because silently
 * dropping it is how a client comes to believe it set something it did not. A
 * typo (`billingdate`, `pincode ` with a space) is a bug on the caller's side,
 * and the only useful moment to say so is the request that carried it.
 *
 * The asymmetry with the response schemas is deliberate and is the same rule
 * seen from both ends: **strict inbound, lenient outbound.** A server that adds
 * a field must not break an older client that has not been rebuilt, while a
 * client that sends a field the server does not know about must be told rather
 * than have its intent quietly discarded. Applying strictness in both directions
 * would turn every additive server-side change into a breaking one.
 */
export const createSocietySchema = z.strictObject({
  name: z.string().trim().min(3, "Name must be at least 3 characters").max(160),
  type: z.enum(SOCIETY_TYPES),
  registrationNumber: z.string().trim().max(64).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2, "Enter a city").max(80),
  state: z.string().trim().min(2, "Enter a state").max(80),
  pincode: pincodeSchema.optional(),
  billingDay: z
    .number()
    .int()
    .min(1, "Between 1 and 28")
    .max(28, "Between 1 and 28"),
  dueDay: z
    .number()
    .int()
    .min(1, "Between 1 and 28")
    .max(28, "Between 1 and 28"),
  approvalThresholdPaise: z.number().int().min(0, "Cannot be negative"),
});
export type CreateSocietyPayload = z.infer<typeof createSocietySchema>;

/**
 * Update = create with every field optional, never an empty patch, **plus** the
 * settings the create wizard never asked for.
 *
 * The `.extend` is not decoration. The application layer's `UpdateSocietyCommand`
 * accepts `graceDays`, `billVacantFlats`, `allowPartialPayments`,
 * `defaulterListPublic`, `financialYearStartMonth` and `timezone`, and the
 * endpoint's own documentation promises it patches "the society and/or its
 * settings atomically" — a schema without them would make every one of those
 * fields unsettable over HTTP while the request still returned `200`, which is
 * the worst possible outcome: the caller is told the change succeeded and the
 * only evidence otherwise is a field that quietly kept its old value.
 */
export const updateSocietySchema = createSocietySchema
  .partial()
  .extend({
    graceDays: z.number().int().min(0).max(90).optional(),
    billVacantFlats: z.boolean().optional(),
    allowPartialPayments: z.boolean().optional(),
    defaulterListPublic: z.boolean().optional(),
    financialYearStartMonth: z.number().int().min(1).max(12).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });
export type UpdateSocietyPayload = z.infer<typeof updateSocietySchema>;

export const joinSocietySchema = z.strictObject({
  code: joinCodeSchema,
  occupancyType: z.enum(OCCUPANCY_TYPES),
});
export type JoinSocietyPayload = z.infer<typeof joinSocietySchema>;

/** Settings block of a society response. */
export const societySettingsSchema = z.object({
  billingDay: z.number().int(),
  dueDay: z.number().int(),
  graceDays: z.number().int(),
  approvalThresholdPaise: z.number().int(),
  billVacantFlats: z.boolean(),
  allowPartialPayments: z.boolean(),
  defaulterListPublic: z.boolean(),
  financialYearStartMonth: z.number().int(),
  timezone: z.string(),
  currency: z.literal("INR"),
});

export const societySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  type: societyTypeSchema,
  registrationNumber: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  pincode: z.string().nullable(),
  country: z.literal("IN"),
  currency: z.literal("INR"),
  timezone: z.string(),
  joinCode: z.string(),
  joinCodeExpiresAt: z.string().nullable(),
  plan: z.enum(["free", "pro", "enterprise"]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  settings: societySettingsSchema,
  memberCount: z.number().int(),
});
export type SocietyDto = z.infer<typeof societySchema>;

export const membershipSchema = z.object({
  id: z.string(),
  societyId: z.string(),
  userId: z.string(),
  role: z.enum([
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
    "guest",
  ]),
  status: z.enum(["pending", "active", "removed"]),
  occupancyType: z.enum(OCCUPANCY_TYPES),
  joinedAt: z.string().nullable(),
});
export type MembershipDto = z.infer<typeof membershipSchema>;

/** Join preview — deliberately excludes the join code itself. */
export const societyJoinPreviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  state: z.string(),
  type: societyTypeSchema,
  memberCount: z.number().int(),
});
export type SocietyJoinPreviewDto = z.infer<typeof societyJoinPreviewSchema>;

export const membershipListSchema = z.array(membershipSchema);

/**
 * Switcher / list view of a membership (PRD §3.1 multi-society).
 *
 * Carries the role and membership status alongside the society, because that is
 * what the switcher row renders and a second round trip would be pure latency.
 */
export const societySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  type: societyTypeSchema,
  role: membershipSchema.shape.role,
  status: membershipSchema.shape.status,
  memberCount: z.number().int(),
});
export type SocietySummaryDto = z.infer<typeof societySummarySchema>;

export const societySummaryListSchema = z.array(societySummarySchema);

/**
 * What the caller may do in this society.
 *
 * Computed by the domain (`evaluateSocietyCapabilities`) and shipped in the
 * response so the client does not re-derive permissions from a role string. A
 * disabled button and a rejected request then always agree.
 */
export const societyCapabilitiesSchema = z.object({
  canManage: z.boolean(),
  canDelete: z.boolean(),
  canRegenerateJoinCode: z.boolean(),
  canViewJoinCode: z.boolean(),
  canLeave: z.boolean(),
});
export type SocietyCapabilitiesDto = z.infer<typeof societyCapabilitiesSchema>;

/**
 * `GET /societies/lookup?code=` — the public join-code preview.
 *
 * Names its member for the same reason every other response here does: `data` is
 * a resource envelope, so a field can be added later without breaking a client
 * that destructures it.
 */
export const joinPreviewResponseSchema = z.object({
  preview: societyJoinPreviewSchema,
});
export type JoinPreviewResponseDto = z.infer<typeof joinPreviewResponseSchema>;

/** `GET /societies/:id` — everything one profile screen needs in one response. */
export const societyProfileResponseSchema = z.object({
  society: societySchema,
  membership: membershipSchema,
  capabilities: societyCapabilitiesSchema,
});
export type SocietyProfileResponseDto = z.infer<
  typeof societyProfileResponseSchema
>;

/**
 * `POST /societies` — the created society and the creator's Admin membership.
 *
 * Both are returned because the caller needs both immediately: it navigates
 * into the society it just created, and it has to know its own role there. The
 * API can state it exactly, whereas the client would have to re-derive it.
 */
export const createdSocietyResponseSchema = z.object({
  society: societySchema,
  membership: membershipSchema,
});
export type CreatedSocietyResponseDto = z.infer<
  typeof createdSocietyResponseSchema
>;

/**
 * `POST /societies/join` — the membership that join produced.
 *
 * Wrapped in a named member rather than returned bare, so `data` is a resource
 * envelope everywhere in this module and adding a field later is not a breaking
 * change (SAD §7.9).
 */
export const membershipResponseSchema = z.object({
  membership: membershipSchema,
});
export type MembershipResponseDto = z.infer<typeof membershipResponseSchema>;

/**
 * The shape shared by every endpoint that returns only the society — an edit
 * (`PATCH /societies/:id`) and a join-code rotation, whose new code is part of
 * the society row.
 */
export const societyResponseSchema = z.object({
  society: societySchema,
});
export type SocietyResponseDto = z.infer<typeof societyResponseSchema>;

/**
 * Rotation's response. An alias rather than a second declaration: one shape,
 * one definition, and the name says which endpoint it documents.
 */
export const regenerateJoinCodeResponseSchema = societyResponseSchema;
export type RegenerateJoinCodeResponseDto = SocietyResponseDto;

/** Settings-only patch (PRD §3.2 step 3 fields), never an empty object. */
export const updateSocietySettingsSchema = societySettingsSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });
export type UpdateSocietySettingsPayload = z.infer<
  typeof updateSocietySettingsSchema
>;

/** Partial patch of the society itself (settings carry their own schema). */
export const updateSocietyDetailsSchema = createSocietySchema.partial().omit({
  billingDay: true,
  dueDay: true,
  approvalThresholdPaise: true,
});
export type UpdateSocietyDetailsPayload = z.infer<
  typeof updateSocietyDetailsSchema
>;

/** Body of a WhatsApp/invite share — the client builds the message. */
export const joinCodeShareSchema = z.object({
  societyName: z.string(),
  joinCode: joinCodeSchema,
  expiresAt: z.string().nullable(),
});
