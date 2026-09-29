import type { SocietyId, UserId } from "@ses/domain";

import type { SocietyAuthorizationContext } from "./society-authorization";

/**
 * The membership cache SAD §9.4 has been describing since T038 — and the ordering
 * protocol that makes it safe to turn on.
 *
 * ## What is cached, and what that costs
 *
 * One entry per **`(societyId, userId)`**, holding exactly what
 * `SocietyAuthorizationReader.load()` returns: the society and the caller's live
 * membership. It is the read `SocietyGuard` performs on every guarded request, so
 * caching it is the difference between one query per request and none.
 *
 * The value is deliberately *not* a decision (`can(user, action, resource)`).
 * Authorisation inputs are reusable; decisions are not, because the resource half
 * of a decision changes for reasons the membership cache can never observe
 * (SAD §9.3 — `canOnResource` reads the record, and the record is not this).
 *
 * ## The key is identity, never a label
 *
 * `ses:authz:ctx:{societyId}:{userId}` — two immutable UUIDs. Both are needed:
 * `userId` alone would collide across societies, which is exactly the tenancy bug
 * a permission cache is capable of (one user is a Treasurer in one society and a
 * Resident in another — PRD §2), and `societyId` alone would serve one member's
 * role to another. Display names, slugs and join codes appear nowhere: they are
 * mutable, and a cache key that can be reassigned is a key that can be made to
 * collide.
 *
 * ## Why there is a protocol here rather than `get`/`set`/`delete`
 *
 * `delete` after commit is the obvious design and it has a hole, which is the
 * whole reason T038 deferred this. The hole is *between* commit and invalidation:
 *
 * ```
 * writer  ── commit ──────────────────────────────► delete        (a few ms later)
 * reader                    read cache → HIT stale role
 * ```
 *
 * A revocation that commits at `t` and is invalidated at `t+ε` grants rights for
 * `ε`. Worse, a reader that captured the pre-commit state can *repopulate* the
 * entry after the delete, so the stale value outlives the invalidation that was
 * supposed to remove it.
 *
 * The protocol below closes both by making the invalidation happen **before** the
 * commit is observable, and by making every cache *write* conditional:
 *
 * ```
 * begin   INCR gate            ← before the transaction starts
 * …       write, commit        ← the mutation
 * commit  INCR version, DEL ctx, DECR gate     ← after the commit
 * abort   DECR gate                            ← on rollback
 * ```
 *
 * ### The gate closes the post-commit/pre-invalidation window
 *
 * `gate` counts authorization-relevant transactions currently in flight. While it
 * is non-zero every read **bypasses the cache entirely** and goes to the database.
 * A mutation is therefore never observable through a stale entry: from before its
 * write until after its invalidation, the cache is not consulted at all.
 *
 * ### The version closes the repopulation window
 *
 * `version` is a per-society counter, bumped after commit. A reader captures the
 * version *before* its database read and stores the entry under that captured
 * value; the store is refused if the version has moved. So an entry written from a
 * read that raced a commit can never be reachable afterwards — and, because the
 * entry also carries the version it was stored under, a bump alone makes it a miss
 * even if the delete never happened.
 *
 * That second property is the failure story: **a failed invalidation cannot leave
 * a revoke invisible.** If the post-commit step never runs at all, the gate stays
 * raised until its TTL and the database answers; if only the delete fails, the
 * version mismatch does the work; if only the version bump fails, the delete does.
 * No single failed step can restore a stale privilege.
 *
 * ### It is a bounded window, not a distributed transaction
 *
 * Everything here is Redis plus the database's own commit. There is no two-phase
 * commit, no lock service and no cross-store transaction, because none is needed:
 * the gate only has to outlive one commit, and the version only has to be
 * monotonic. Both are cheap, and every failure mode degrades to the database.
 */

/** Where an entry lives. Both halves are immutable identity — see the note above. */
export interface MembershipCacheKey {
  readonly societyId: SocietyId;
  readonly userId: UserId;
}

/** What a reader is told. `bypass` means "do not use the cache at all". */
export type MembershipCacheLookup =
  | {
      readonly status: "hit";
      readonly version: string;
      readonly context: SocietyAuthorizationContext;
    }
  | { readonly status: "miss"; readonly version: string }
  | { readonly status: "bypass" };

/**
 * How a mutation's invalidation ended.
 *
 * `invalidated` is the normal answer: the entry is gone and the version has
 * moved. `gated` means the post-commit step could not reach the cache, so the
 * gate is still holding the key cold until its TTL — **still safe**, because a
 * raised gate makes every read consult the database, but worth reporting: an
 * operator wants to know that a revocation is being enforced by an expiring gate
 * rather than by an invalidation.
 *
 * An outcome rather than an exception because the invalidation runs after the
 * database has already committed: throwing here would turn a successful mutation
 * into a failed request, which is the one thing the caller must not do.
 */
export type MembershipInvalidationOutcome = "invalidated" | "gated";

/**
 * The cache.
 *
 * Every method is **best-effort and must not throw**: an unavailable cache is a
 * slower request, never a failed one, and §15 of the task's own rules makes the
 * same point from the other side — correctness must not depend on this being up.
 * Implementations swallow their own transport errors and report a `bypass`.
 */
export interface MembershipCache {
  /**
   * Reads an entry. Never throws.
   *
   * `bypass` covers three cases that are answered identically — a raised gate, an
   * unusable Redis, and a store configured off — because the caller's response to
   * all three is the same: read the database and do not populate the cache.
   */
  lookup(key: MembershipCacheKey): Promise<MembershipCacheLookup>;

  /**
   * Stores `context` under the version the caller captured **before** its database
   * read. Silently refuses (and never overwrites a newer entry) when the version
   * has moved or a mutation is in flight.
   */
  store(
    key: MembershipCacheKey,
    version: string,
    context: SocietyAuthorizationContext,
  ): Promise<void>;

  /**
   * Raises the gate. Called *before* the mutation's transaction opens.
   *
   * Returns whether the gate is actually up. A `false` is not a reason to abort
   * the mutation — it is a reason to expect the post-commit step to be the only
   * thing standing between a commit and a stale entry, which is why the caller
   * reports it.
   */
  begin(): Promise<boolean>;

  /**
   * Lowers the gate, bumps `societyId`'s version and drops the named entries.
   * Called after the mutation has committed.
   */
  commit(
    societyId: SocietyId,
    userIds: readonly UserId[],
  ): Promise<MembershipInvalidationOutcome>;

  /** Lowers the gate without touching versions. Called when the mutation failed. */
  abort(): Promise<void>;
}

/**
 * DI token. A string, like the other authorization ports, so the interface stays
 * the contract and the module decides which store satisfies it.
 *
 * Injected with `@Optional()` at its one consumer rather than as a required
 * dependency: the cache is an optimisation, and a build (or a unit test) that
 * wires no store must get an uncached but perfectly correct application.
 */
export const MEMBERSHIP_CACHE = "MEMBERSHIP_CACHE";

/** The cache entry's shape on the wire. Short keys: it is the hot path. */
export interface MembershipCacheEntry {
  /** The society version this entry was stored under. */
  readonly v: string;
  readonly context: SocietyAuthorizationContext;
}

/**
 * Gate TTL — far longer than any transaction (`DB_STATEMENT_TIMEOUT_MS` is 10s),
 * so it cannot lapse mid-mutation, and short enough that a process that dies
 * between `begin` and `commit` cannot disable the cache for long. A raised gate is
 * safe (it means "read the database"), so the failure direction is the benign one.
 */
export const MEMBERSHIP_CACHE_GATE_TTL_SECONDS = 60;
