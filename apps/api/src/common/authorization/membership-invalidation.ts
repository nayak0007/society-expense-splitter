import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { SocietyId, UserId } from "@ses/domain";

import { MEMBERSHIP_CACHE, type MembershipCache } from "./membership-cache";

/**
 * What a write changed, cache-wise.
 *
 * `societyId` is required and `userIds` is not, and the asymmetry is the design:
 * the invalidation is **per society** (a version bump) and the entry deletes are
 * housekeeping. So a caller that does not know the affected member's `userId` —
 * `PATCH /members/:id` is addressed by membership id, and `invitation_accept()`
 * only learns whose row it wrote from inside the function — can pass `[]` and
 * still be correct. Correctness that depended on enumerating the right users would
 * be correctness that one forgotten call site silently removes.
 */
export interface MembershipWriteScope {
  readonly societyId: SocietyId;
  /**
   * The members whose cached context this write changed. Optional, and only ever a
   * memory optimisation: the version bump has already invalidated every entry in
   * the society by the time these are read.
   */
  readonly userIds?: readonly UserId[];
}

/**
 * The one place a membership write and the cache are ordered against each other.
 *
 * ## Why this is a wrapper and not a `cache.invalidate()` call at the end
 *
 * The ordering is the whole correctness argument (see `membership-cache.ts`), and
 * it has three parts that a call at the end of a method cannot express:
 *
 * ```
 * begin()        ← gate raised BEFORE the transaction opens
 *   work()       ← the transaction; commits somewhere inside here
 * commit()       ← version bumped, entries dropped, gate lowered — after the commit
 * abort()        ← gate lowered, versions untouched — when work() threw
 * ```
 *
 * Written as a wrapper, every write path gets all three by construction. Written as
 * a trailing call, the failure path — the one that matters, because a rollback must
 * not leave a version bump behind that would be meaningless — is the one a caller
 * forgets.
 *
 * ## The gate goes up before the transaction, not before the commit
 *
 * It only has to precede the commit, and it is cheapest to precede the whole
 * transaction: the window in which reads bypass the cache is then the transaction
 * plus its invalidation, which for these writes is milliseconds. Placing it
 * *inside* the transaction, immediately before the commit, would need the write to
 * know the society it is mutating before it has mutated it — which is exactly the
 * case (`invitation_accept`) that the optional-scope form exists for.
 *
 * ## A missing cache is a no-op, not a branch at every call site
 *
 * With no `MEMBERSHIP_CACHE` bound — a unit test, a build with the cache off — the
 * wrapper runs `work` and returns it. No caller has to ask whether the cache is
 * configured.
 */
@Injectable()
export class MembershipInvalidation {
  private readonly logger = new Logger(MembershipInvalidation.name);

  constructor(
    @Optional()
    @Inject(MEMBERSHIP_CACHE)
    private readonly cache: MembershipCache | undefined,
  ) {}

  /**
   * Runs `work` with the cache fenced, and invalidates on success.
   *
   * `scope` may be the scope itself or a function of `work`'s result, for the
   * writes that only learn which society they touched from their own answer.
   */
  async around<T>(
    scope:
      MembershipWriteScope | ((result: T) => MembershipWriteScope | undefined),
    work: () => Promise<T>,
  ): Promise<T> {
    const cache = this.cache;
    if (cache === undefined) {
      return work();
    }

    const gated = await cache.begin();
    if (!gated) {
      // Rare and safe — an unreachable cache cannot serve a stale entry, because
      // reads fail the same way — but worth a line, because it means this write's
      // revocation is protected by nothing at all while the cache is down, and by
      // the post-commit invalidation once it comes back.
      this.logger.warn(
        "The membership cache gate could not be raised; this write will rely on post-commit invalidation alone.",
      );
    }

    let result: T;
    try {
      result = await work();
    } catch (error: unknown) {
      // Rolled back: the database says nothing changed, so the version must not
      // move either. A bump here would be a correctness no-op and a cache miss for
      // every member of the society, which is the kind of "harmless" that shows up
      // as a latency graph nobody can explain.
      await cache.abort();
      throw error;
    }

    const resolved = typeof scope === "function" ? scope(result) : scope;
    if (resolved === undefined) {
      await cache.abort();
      return result;
    }

    const outcome = await cache.commit(
      resolved.societyId,
      resolved.userIds ?? [],
    );
    if (outcome === "gated") {
      // The version bump did not happen. Every read is still refused by the raised
      // gate until its TTL, so no stale privilege is served — but a revocation is
      // now being enforced by an expiring gate rather than by an invalidation, and
      // that is an operator's problem, not a silent one.
      this.logger.warn(
        `The membership cache could not be invalidated for society ${resolved.societyId}; reads are gated until the gate TTL expires.`,
      );
    }

    return result;
  }
}
