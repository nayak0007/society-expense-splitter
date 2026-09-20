import type { MemberId, SocietyId, UserId } from "../shared/ids";

/**
 * Society entity + value unions (PRD §3.2, SAD §8.2 `societies` /
 * `society_settings`).
 *
 * The field names and nullability mirror the database columns deliberately:
 * the entity is the contract between the local replica, the API and the UI,
 * so a rename here is a migration there.
 */

/** PRD §3.2 step 1 — society type. */
export const SOCIETY_TYPES = [
  "apartment",
  "villa",
  "rowhouse",
  "shared_flat",
  "other",
] as const;
export type SocietyType = (typeof SOCIETY_TYPES)[number];

/** PRD §2 — roles are scoped to a membership, never global to a user. */
export const MEMBER_ROLES = [
  "admin",
  "treasurer",
  "committee_member",
  "resident",
  "tenant",
  "guest",
] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Membership lifecycle: a join starts `pending` and needs an admin (§3.2). */
export const MEMBERSHIP_STATUSES = ["pending", "active", "removed"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** PRD §3.2 join flow — occupancy declared at join time. */
export const OCCUPANCY_TYPES = ["owner", "tenant", "family_member"] as const;
export type OccupancyType = (typeof OCCUPANCY_TYPES)[number];

export const SUBSCRIPTION_PLANS = ["free", "pro", "enterprise"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

/** Defaults mirror `society_settings` column defaults (PRD §3.2 step 3). */
export interface SocietySettings {
  /** 1–28; 29+ breaks February billing. */
  readonly billingDay: number;
  readonly dueDay: number;
  readonly graceDays: number;
  /** ₹10,000 in paise (PRD §2: expenses above this need an Admin). */
  readonly approvalThresholdPaise: number;
  readonly billVacantFlats: boolean;
  readonly allowPartialPayments: boolean;
  readonly defaulterListPublic: boolean;
  /** 4 = April, the Indian financial year (PRD §3.2 step 3). */
  readonly financialYearStartMonth: number;
  readonly timezone: string;
  readonly currency: "INR";
}

export interface Society {
  readonly id: SocietyId;
  readonly name: string;
  readonly slug: string;
  readonly type: SocietyType;
  readonly registrationNumber: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly pincode: string | null;
  readonly country: "IN";
  readonly currency: "INR";
  readonly timezone: string;
  readonly joinCode: string;
  readonly joinCodeExpiresAt: string | null;
  readonly plan: SubscriptionPlan;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly settings: SocietySettings;
  /** Denormalised for lists/preview — the server is the source of truth. */
  readonly memberCount: number;
}

export interface SocietyMembership {
  readonly id: MemberId;
  readonly societyId: SocietyId;
  readonly userId: UserId;
  readonly role: MemberRole;
  readonly status: MembershipStatus;
  readonly occupancyType: OccupancyType;
  readonly joinedAt: string | null;
}

/** Lightweight shape for the society switcher and choice screens (PRD §3.1). */
export interface SocietySummary {
  readonly id: SocietyId;
  readonly name: string;
  readonly city: string;
  readonly type: SocietyType;
  readonly role: MemberRole;
  readonly status: MembershipStatus;
  readonly memberCount: number;
}

/** What the join screen shows before the user commits (PRD §3.2 join flow). */
export interface SocietyJoinPreview {
  readonly id: SocietyId;
  readonly name: string;
  readonly city: string;
  readonly state: string;
  readonly type: SocietyType;
  readonly memberCount: number;
  /**
   * Expiry of the code that produced this preview, evaluated by the *domain*
   * against an injected clock (`join-society.ts`) rather than by whichever
   * adapter happens to remember to check. `null` = no expiry.
   */
  readonly joinCodeExpiresAt: string | null;
}

/** Create payload — the wizard's basics + financial-defaults steps (§3.2). */
export interface CreateSocietyInput {
  readonly name: string;
  readonly type: SocietyType;
  readonly registrationNumber?: string | undefined;
  readonly addressLine1?: string | undefined;
  readonly addressLine2?: string | undefined;
  readonly city: string;
  readonly state: string;
  readonly pincode?: string | undefined;
  readonly billingDay: number;
  readonly dueDay: number;
  readonly approvalThresholdPaise: number;
}

/**
 * Partial update — every field optional, empty patch rejected by contract.
 *
 * Two deliberate modifiers:
 *  - the explicit `| undefined`, because with `exactOptionalPropertyTypes` a
 *    plain `Partial<>` would reject a patch whose keys are present-but-undefined,
 *    which is exactly what the contract's `.partial()` schema produces;
 *  - `-readonly`, because a patch is *assembled* field by field by the update
 *    use case (`patch.name = …`) one validated field at a time. The immutability
 *    that matters is on the entity the repository returns and on the command it
 *    receives — not on the builder the domain writes into.
 */
export type UpdateSocietyInput = {
  -readonly [K in keyof CreateSocietyInput]?: CreateSocietyInput[K] | undefined;
};

export interface JoinSocietyInput {
  /** Raw user input; normalised by the join-code value object. */
  readonly code: string;
  readonly occupancyType: OccupancyType;
}
