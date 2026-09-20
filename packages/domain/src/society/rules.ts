import type { SocietyId } from "../shared/ids";

import type { MemberRole, SocietyMembership, SocietySettings } from "./society";

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

export function isMembershipActive(membership: SocietyMembership): boolean {
  return membership.status === "active";
}

export function findMembership(
  memberships: readonly SocietyMembership[],
  societyId: SocietyId,
): SocietyMembership | null {
  return (
    memberships.find((membership) => membership.societyId === societyId) ?? null
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
