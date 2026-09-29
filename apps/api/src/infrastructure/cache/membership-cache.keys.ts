import type { SocietyId, UserId } from "@ses/domain";

/**
 * The three keys of the membership cache, in one place.
 *
 * WHY THEY ARE NOT INLINED AT THE CALL SITES: the isolation property this cache
 * has to have (a test asserts it, and §16 of the task's own rules demands it) is
 * "no key can be reached from the wrong `(societyId, userId)`". That is a property
 * of *the strings*, so the strings are derived here, once, from the two UUIDs —
 * never from a name, a slug, a join code or any other value that can be reassigned
 * to a different member.
 *
 * All three share the `ses:authz:` prefix so an operator can see, in `redis-cli`,
 * exactly which keys are authorization state and which are a rate-limit bucket or
 * a queue.
 */

/** Counts authorization-relevant mutations currently in flight. See the port's note. */
export const MEMBERSHIP_CACHE_GATE_KEY = "ses:authz:gate";

/** Per-society invalidation counter, bumped after a mutation commits. */
export function membershipCacheVersionKey(societyId: SocietyId): string {
  return `ses:authz:ver:${societyId}`;
}

/** One member's cached authorization context. */
export function membershipCacheContextKey(
  societyId: SocietyId,
  userId: UserId,
): string {
  return `ses:authz:ctx:${societyId}:${userId}`;
}
