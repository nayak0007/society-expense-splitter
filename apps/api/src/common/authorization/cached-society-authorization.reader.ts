import { Logger } from "@nestjs/common";
import type { SocietyId, UserId } from "@ses/domain";

import type { MembershipCache } from "./membership-cache";
import type {
  SocietyAuthorizationContext,
  SocietyAuthorizationReader,
} from "./society-authorization";

/**
 * The membership read `SocietyGuard` performs, with the 5-minute cache SAD §9.4
 * has described since T038 in front of it.
 *
 * A decorator rather than a rewrite of the adapter: the guard asks the same
 * question either way, and the societies module decides whether the question is
 * answered from Redis or from Postgres. That is also what makes the cache
 * testable — the whole of the added behaviour is *here*, and the SQL underneath is
 * unchanged and still the only thing that can produce a context.
 *
 * ## It caches exactly one thing, and it is not a decision
 *
 * The cached value is what `load` returned: the society and the caller's live
 * membership. Neither is a permission. `can(role, action)` is still evaluated per
 * request by `PermissionGuard`, and `canOnResource` still reads the record — so a
 * cached entry can never answer a question the database has not already answered
 * at least once, and it can never stand in for a resource the caller has not been
 * authorised against.
 *
 * ## A negative answer is never cached
 *
 * `null` is "no such society, or you are not a member" — and it is deliberately
 * *not* stored. Two reasons, in order of importance:
 *
 * 1. **It is the answer to a question that is about to change.** The commonest
 *    `null` in this system is a member who has been invited but has not joined
 *    yet; caching it means the request that accepts the invitation can still be
 *    refused by a guard reading a five-minute-old "you are nobody here".
 * 2. **It is the cheapest answer to produce.** `society_snapshot` returning
 *    nothing is one indexed lookup that touched no rows, whereas a positive
 *    answer is a society row plus a membership row.
 *
 * So a miss that loads nothing simply is not stored, and the invalidation rules
 * never have to reason about which negative entries a new membership has to
 * remove.
 *
 * ## A failed cache is not a failed request
 *
 * `lookup` answers `bypass` when the cache is unreachable or a mutation is in
 * flight, and `store` swallows its own transport errors. Both paths fall through
 * to the same database read this decorator wraps, so the uncached application and
 * the cached one differ in latency and in nothing else — which is §15's rule, and
 * the reason the cache may be enabled without becoming a dependency.
 */
export class CachedSocietyAuthorizationReader implements SocietyAuthorizationReader {
  private readonly logger = new Logger(CachedSocietyAuthorizationReader.name);

  constructor(
    private readonly inner: SocietyAuthorizationReader,
    private readonly cache: MembershipCache,
  ) {}

  async load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    const key = { societyId, userId: actor };

    const cached = await this.cache.lookup(key);
    if (cached.status === "hit") {
      // Debug, not info: one line per guarded request is far too much for the
      // default level, and the moment it is worth having is exactly the moment
      // somebody has already raised `LOG_LEVEL` to find out why a grant went
      // missing. A cache with no hit/miss visibility is a cache nobody can
      // operate.
      this.logger.debug(`membership cache hit for ${societyId}`);
      return cached.context;
    }

    const loaded = await this.inner.load(societyId, actor);

    // `bypass` means a mutation is in flight, so the read that just happened may
    // already be superseded: storing it would be storing a value the version
    // protocol has no chance to reject, because there is no version to compare.
    if (cached.status === "miss" && loaded !== null) {
      await this.cache.store(key, cached.version, loaded);
    } else if (cached.status === "bypass") {
      // A mutation is in flight, so this read went to the database and was not
      // stored. Worth a line because it is the one case where a *slow* cache is
      // correct rather than broken.
      this.logger.debug(`membership cache bypassed for ${societyId}`);
    }

    return loaded;
  }
}
