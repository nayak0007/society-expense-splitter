import type {
  Society,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

/**
 * The one read `SocietyGuard` needs, expressed as a port.
 *
 * ## Why a port rather than a repository call
 *
 * The guard runs before any handler and needs exactly two facts — *does this
 * caller belong to this society, and as what* — plus the society itself, because
 * `request.currentSociety` is part of the contract. The domain's
 * `SocietyRepository` port is shaped for the use cases (it is actor-scoped by
 * argument and returns domain aggregates); asking it for this would mean either a
 * whole roster read per request or a new method every implementor — including the
 * mobile mock — has to satisfy, for a concern that is server-side only.
 *
 * So the interface lives here, in `common/`, and the implementation lives in the
 * societies module where the SQL and row parsing already are. The dependency
 * points inward, and nothing about the mobile app changes.
 *
 * ## One query, null for every refusal
 *
 * `load` returns the society **and** the caller's membership in a single read —
 * they come from the same `society_snapshot` call the profile route already uses,
 * which is what makes "do not query the same membership twice" achievable rather
 * than aspirational. `null` covers all three refusals identically: no such
 * society, a soft-deleted one, and a caller who is not a member. That is not
 * laziness — SAD §7.2 and PRD T041 make those three indistinguishable on purpose,
 * because a distinguishable answer lets a caller enumerate society ids they have
 * no access to.
 */
export interface SocietyAuthorizationContext {
  readonly society: Society;
  readonly membership: SocietyMembership;
}

export interface SocietyAuthorizationReader {
  /**
   * The society and the caller's live membership, or `null` when the caller may
   * not be told that it exists.
   */
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null>;
}

/**
 * DI token. An `InjectionToken` string rather than a class, so the interface stays
 * the contract and the module decides what satisfies it.
 *
 * Deliberately **not** `@Optional()` at the injection site: a guard that cannot
 * read memberships must fail at boot rather than at the first request, and an
 * optional dependency would turn a missing provider into a silent "every
 * society-scoped route is now unguarded".
 */
export const SOCIETY_AUTHORIZATION_READER = "SOCIETY_AUTHORIZATION_READER";

/** Where the guard leaves the resolved context, for `@Ctx()` and the repository. */
export const REQUEST_SOCIETY_KEY = "currentSociety";
export const REQUEST_MEMBERSHIP_KEY = "currentMembership";
