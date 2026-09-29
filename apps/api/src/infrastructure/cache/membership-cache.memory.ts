import type { SocietyId, UserId } from "@ses/domain";

import type {
  MembershipCache,
  MembershipCacheEntry,
  MembershipCacheKey,
  MembershipCacheLookup,
  MembershipInvalidationOutcome,
} from "../../common/authorization/membership-cache";
import type { SocietyAuthorizationContext } from "../../common/authorization/society-authorization";

/**
 * The membership cache in this process's memory.
 *
 * **Not for production use across more than one instance.** An API process holds
 * its own map, so an invalidation raised by instance A is invisible to instance B,
 * and B keeps serving the revoked role until its entries expire — precisely the
 * stale-privilege window this whole design exists to remove. It is here for two
 * legitimate jobs and no others: unit and e2e tests (which need the ordering
 * protocol, not a Redis deployment) and the single-process development server.
 *
 * The protocol is implemented exactly as the Redis adapter implements it,
 * including the gate and the version check on `store`, because a fake that is more
 * permissive than the real thing would let the tests that matter pass while
 * production failed. Where Redis gets atomicity from executing a script on one
 * thread, this gets it from JavaScript's run-to-completion: every mutating
 * sequence below is synchronous, so nothing can interleave inside one.
 */
export class InMemoryMembershipCache implements MembershipCache {
  private readonly entries = new Map<
    string,
    { raw: string; expiresAt: number }
  >();
  private readonly versions = new Map<string, number>();
  private gate = 0;
  private gateExpiresAt = 0;

  constructor(
    private readonly ttlSeconds: number,
    private readonly gateTtlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  // ── the port ───────────────────────────────────────────────────────────────

  async lookup(key: MembershipCacheKey): Promise<MembershipCacheLookup> {
    if (this.gateOpen()) {
      return { status: "bypass" };
    }
    const version = this.version(key.societyId);
    const entry = this.entries.get(this.entryKey(key));
    if (entry === undefined || entry.expiresAt <= this.now()) {
      return { status: "miss", version };
    }
    const decoded = decodeEntry(entry.raw);
    // An entry stored under a different version is a miss even though it is
    // present: a version bump is an invalidation on its own, which is what makes a
    // failed `DEL` harmless.
    if (decoded === undefined || decoded.v !== version) {
      return { status: "miss", version };
    }
    return { status: "hit", version, context: decoded.context };
  }

  async store(
    key: MembershipCacheKey,
    version: string,
    context: SocietyAuthorizationContext,
  ): Promise<void> {
    if (this.gateOpen()) {
      return;
    }
    if (this.version(key.societyId) !== version) {
      return;
    }
    const entry: MembershipCacheEntry = { v: version, context };
    this.entries.set(this.entryKey(key), {
      raw: JSON.stringify(entry),
      expiresAt: this.now() + this.ttlSeconds * 1000,
    });
  }

  async begin(): Promise<boolean> {
    this.gate += 1;
    this.gateExpiresAt = this.now() + this.gateTtlSeconds * 1000;
    return true;
  }

  async commit(
    societyId: SocietyId,
    userIds: readonly UserId[],
  ): Promise<MembershipInvalidationOutcome> {
    this.versions.set(societyId, (this.versions.get(societyId) ?? 0) + 1);
    for (const userId of userIds) {
      this.entries.delete(this.entryKey({ societyId, userId }));
    }
    this.lowerGate();
    return "invalidated";
  }

  async abort(): Promise<void> {
    this.lowerGate();
  }

  // ── testing affordances ────────────────────────────────────────────────────

  /**
   * Drops everything. Test-only: it is the only way to get a clean cache without
   * constructing a second application, and it is on the adapter rather than on the
   * port so no production caller can reach it.
   */
  reset(): void {
    this.entries.clear();
    this.versions.clear();
    this.gate = 0;
    this.gateExpiresAt = 0;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private gateOpen(): boolean {
    if (this.gate <= 0) {
      return false;
    }
    if (this.now() > this.gateExpiresAt) {
      // The mutation that raised the gate never lowered it — a crashed or wedged
      // writer. Expiring is the same answer Redis gives through its TTL, and the
      // consequence is only that the database answers for a while.
      this.gate = 0;
      return false;
    }
    return true;
  }

  private lowerGate(): void {
    this.gate = Math.max(0, this.gate - 1);
  }

  private version(societyId: SocietyId): string {
    return String(this.versions.get(societyId) ?? 0);
  }

  private entryKey(key: MembershipCacheKey): string {
    return `${key.societyId}:${key.userId}`;
  }
}

/** `undefined` for anything that is not a well-formed entry — never a throw. */
function decodeEntry(raw: string): MembershipCacheEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const entry = parsed as { v?: unknown; context?: unknown };
    if (typeof entry.v !== "string") {
      return undefined;
    }
    if (typeof entry.context !== "object" || entry.context === null) {
      return undefined;
    }
    return entry as MembershipCacheEntry;
  } catch {
    return undefined;
  }
}
