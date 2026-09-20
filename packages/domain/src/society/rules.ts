import type { SocietyId, UserId } from "../shared/ids";

import { SOCIETY_TYPES } from "./society";
import type {
  MemberRole,
  SocietyMembership,
  SocietySettings,
  SocietyType,
} from "./society";

/**
 * Pure society rules (PRD §3.2, §2 role matrix, Phase 3 DoD "a society can
 * never be left without an active admin").
 *
 * Everything here is a total function of its arguments — no I/O, no clock —
 * so the API can enforce the identical rule inside a transaction.
 */

/** `Green Valley Residency` → `green-valley-residency` (PRD task 16). */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

/** Column defaults of `society_settings` (PRD §3.2 step 3). */
export const DEFAULT_SOCIETY_SETTINGS: SocietySettings = {
  billingDay: 1,
  dueDay: 10,
  graceDays: 5,
  approvalThresholdPaise: 1_000_000,
  billVacantFlats: true,
  allowPartialPayments: true,
  defaulterListPublic: false,
  financialYearStartMonth: 4,
  timezone: "Asia/Kolkata",
  currency: "INR",
};

export function defaultSocietySettings(
  overrides: Partial<SocietySettings> = {},
): SocietySettings {
  return { ...DEFAULT_SOCIETY_SETTINGS, ...overrides };
}

/** Runtime guard for a value that arrived over the wire. */
export function isSocietyType(value: unknown): value is SocietyType {
  return (
    typeof value === "string" &&
    (SOCIETY_TYPES as readonly string[]).includes(value)
  );
}

export function isMembershipActive(membership: SocietyMembership): boolean {
  return membership.status === "active";
}

/**
 * The membership a given user holds in a society, or `null`.
 *
 * `userId` is required, and that is the entire point: an earlier version matched
 * on `societyId` alone and returned whichever row the repository happened to
 * list first. Because the creator's Admin row is the oldest, every member then
 * read as that Admin — a privilege-escalation bug that a use-case test caught
 * (a resident could edit and delete the society). "Which membership?" is only
 * answerable together with "for whom?", so the signature makes that explicit
 * instead of leaving it to the caller to remember.
 */
export function findMembership(
  memberships: readonly SocietyMembership[],
  societyId: SocietyId,
  userId: UserId,
): SocietyMembership | null {
  return (
    memberships.find(
      (membership) =>
        membership.societyId === societyId && membership.userId === userId,
    ) ?? null
  );
}

export function activeAdmins(
  memberships: readonly SocietyMembership[],
  societyId: SocietyId,
): readonly SocietyMembership[] {
  return memberships.filter(
    (membership) =>
      membership.societyId === societyId &&
      membership.status === "active" &&
      membership.role === "admin",
  );
}

/** Result of a rule check — a reason, not a boolean, so the UI can explain. */
export type RuleOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export const RULE_ALLOWED: RuleOutcome = { allowed: true };

/**
 * Who may edit or delete the society itself. PRD §2: Admin only —
 * the Treasurer explicitly "cannot change roles or society structure".
 */
export function canManageSociety(role: MemberRole | null): RuleOutcome {
  if (role === "admin") return RULE_ALLOWED;
  return {
    allowed: false,
    reason: "Only a society Admin can change society details.",
  };
}

/**
 * PRD Phase 3 DoD: a society can never be left without an active admin.
 * The check needs every membership of that society, not just the actor's.
 */
export function canLeaveSociety(
  membership: SocietyMembership,
  memberships: readonly SocietyMembership[],
): RuleOutcome {
  if (membership.role !== "admin") return RULE_ALLOWED;

  const admins = activeAdmins(memberships, membership.societyId);
  const isSoleAdmin =
    admins.length <= 1 && admins.some((admin) => admin.id === membership.id);
  if (isSoleAdmin) {
    return {
      allowed: false,
      reason:
        "You are the only Admin. Promote another member to Admin before you can leave this society.",
    };
  }
  return RULE_ALLOWED;
}

/** Deleting removes the whole tenant, so it needs the strongest role. */
export function canDeleteSociety(role: MemberRole | null): RuleOutcome {
  if (role === "admin") return RULE_ALLOWED;
  return {
    allowed: false,
    reason: "Only a society Admin can delete a society.",
  };
}

/**
 * Everything the UI is allowed to offer for one membership, derived in one
 * place.
 *
 * The client must not re-implement these rules as ad-hoc role checks scattered
 * through screens — that is how the affordance and the server drift apart. The
 * API's guard, the RLS policy and the UI all read this evaluation, so a
 * disabled button and a 403 can never disagree about who may do what (SAD §9.3).
 */
export interface SocietyCapabilities {
  /** Edit society details and settings. */
  readonly canManage: boolean;
  /** Delete the tenant outright. */
  readonly canDelete: boolean;
  /** Rotate the join code. */
  readonly canRegenerateJoinCode: boolean;
  /** See the join code (every member may invite — PRD §2). */
  readonly canViewJoinCode: boolean;
  /** Leave, if doing so would not orphan the society. */
  readonly canLeave: boolean;
}

const NO_CAPABILITIES: SocietyCapabilities = {
  canManage: false,
  canDelete: false,
  canRegenerateJoinCode: false,
  canViewJoinCode: false,
  canLeave: false,
};

export function evaluateSocietyCapabilities(
  membership: SocietyMembership | null,
  memberships: readonly SocietyMembership[],
): SocietyCapabilities {
  if (membership === null || membership.status === "removed")
    return NO_CAPABILITIES;

  const isAdmin = membership.role === "admin";
  const active = membership.status === "active";
  const canLeave = active && canLeaveSociety(membership, memberships).allowed;

  return {
    canManage: active && isAdmin,
    canDelete: active && isAdmin,
    canRegenerateJoinCode: active && isAdmin,
    canViewJoinCode: active,
    // A pending member may withdraw their request; a removed member has nothing
    // to leave.
    canLeave: membership.status === "pending" ? true : canLeave,
  };
}

/** Optional expiry on the join code (PRD §3.2: "Regenerable", optional expiry). */
export function isJoinCodeExpired(
  expiresAt: string | null,
  nowMilliseconds: number = Date.now(),
): boolean {
  if (expiresAt === null) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return false;
  return expiry <= nowMilliseconds;
}
