import { asMemberId, asSocietyId, asUserId } from "../../../shared/ids";
import type {
  MemberRole,
  MembershipStatus,
  OccupancyType,
  SocietyMembership,
} from "../../society";

/**
 * `SocietyMembership` builders for the rules tests.
 *
 * These live in the domain package because they build a *domain object* with no
 * port involved — a rule like "a society can never be left without an active
 * admin" is asserted over memberships, not over a repository. The richer fake
 * repository (which does implement the port) lives beside the use-case tests in
 * `@ses/application`, which is the layer that actually calls a repository.
 *
 * The spec takes plain strings and brands them here rather than at every call
 * site, so a test reads `membership({ role: "treasurer" })` instead of
 * `'member-1' as SocietyMembership['id']`.
 */

/** The instant every helper defaults to — matches `fixedClock` in the tests. */
export const TEST_NOW = "2026-09-20T10:00:00.000Z";

export interface MembershipSpec {
  readonly id?: string;
  readonly userId?: string;
  readonly societyId?: string;
  readonly role?: MemberRole;
  readonly status?: MembershipStatus;
  readonly occupancyType?: OccupancyType;
  readonly joinedAt?: string | null;
}

export function membership(spec: MembershipSpec = {}): SocietyMembership {
  return {
    id: asMemberId(spec.id ?? "member-1"),
    societyId: asSocietyId(spec.societyId ?? "society-1"),
    userId: asUserId(spec.userId ?? "user-admin"),
    role: spec.role ?? "admin",
    status: spec.status ?? "active",
    occupancyType: spec.occupancyType ?? "owner",
    joinedAt: spec.joinedAt === undefined ? TEST_NOW : spec.joinedAt,
  };
}
