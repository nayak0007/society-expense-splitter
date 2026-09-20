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

export const createSocietySchema = z.object({
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

/** Update = create with every field optional, but never an empty patch. */
export const updateSocietySchema = createSocietySchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  });
export type UpdateSocietyPayload = z.infer<typeof updateSocietySchema>;

export const joinSocietySchema = z.object({
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

/** Body of a WhatsApp/invite share — the client builds the message. */
export const joinCodeShareSchema = z.object({
  societyName: z.string(),
  joinCode: joinCodeSchema,
  expiresAt: z.string().nullable(),
});
