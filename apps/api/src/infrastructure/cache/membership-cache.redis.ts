import type { SocietyId, UserId } from "@ses/domain";

import type {
  MembershipCache,
  MembershipCacheEntry,
  MembershipCacheKey,
  MembershipCacheLookup,
  MembershipInvalidationOutcome,
} from "../../common/authorization/membership-cache";
import type { SocietyAuthorizationContext } from "../../common/authorization/society-authorization";
import {
  MEMBERSHIP_CACHE_GATE_KEY,
  membershipCacheContextKey,
  membershipCacheVersionKey,
} from "./membership-cache.keys";
import type { RedisService } from "./redis.service";

/**
 * The membership cache, in the only place it can be correct across more than one
 * API instance: Redis.
 *
 * ## Why every operation is a script
 *
 * Each of the four operations is a read-modify-write over three keys, and every
 * split version of one has a window the design depends on not existing:
 *
 * - reading the gate and then the version could see a gate that was raised after
 *   the version was read — a `bypass` decision made from a state that never held;
 * - checking the fence and then storing could let a store through in the instant a
 *   mutation started, which is exactly the repopulation the gate prevents;
 * - invalidating would be three round trips, so a revoke would be observable
 *   between the version bump and the delete.
 *
 * A script is executed on one thread, so none of those states is observable. That
 * is the entire reason this adapter is longer than `get`/`set`/`del`.
 *
 * ## Failure is always the same answer: ask the database
 *
 * Nothing here throws. A connection that is refused, a script error, a Redis that
 * was never configured: every one of them makes `lookup` answer `bypass`, which
 * the reader treats as "read the database and do not populate the cache". The
 * cache is an optimisation, and an optimisation that can fail a request is a
 * liability — see the port's note, and §15 of the authorization rules.
 */

/** Gate, version, entry → hit / miss / bypass, with no window between the reads. */
const LOOKUP_SCRIPT = `
local gate = redis.call('GET', KEYS[1])
if gate and tonumber(gate) and tonumber(gate) > 0 then
  return {'bypass'}
end
local ver = redis.call('GET', KEYS[2])
if not ver then ver = '0' end
local raw = redis.call('GET', KEYS[3])
if not raw then return {'miss', ver} end
local ok, decoded = pcall(cjson.decode, raw)
if not ok or type(decoded) ~= 'table' or decoded.v == nil then
  return {'miss', ver}
end
if tostring(decoded.v) ~= ver then return {'miss', ver} end
return {'hit', ver, raw}
`;

/** Gate, version, entry → store only if the gate is down and the version is unmoved. */
const STORE_SCRIPT = `
local gate = redis.call('GET', KEYS[1])
if gate and tonumber(gate) and tonumber(gate) > 0 then return 0 end
local ver = redis.call('GET', KEYS[2])
if not ver then ver = '0' end
if ver ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])
return 1
`;

/** Gate → raise it. The TTL is set by whoever raises it from zero. */
const BEGIN_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** Gate, version, entries… → bump, drop, lower. The whole invalidation, atomically. */
const COMMIT_SCRIPT = `
redis.call('INCR', KEYS[2])
for i = 3, #KEYS do redis.call('DEL', KEYS[i]) end
return lowerGate(KEYS[1], ARGV[1])
`;

/** Gate → lower it without touching versions. */
const ABORT_SCRIPT = `
return lowerGate(KEYS[1], ARGV[1])
`;

/**
 * The decrement both COMMIT and ABORT end with, defined once so the two cannot
 * disagree about when the gate is empty. `DEL` at zero rather than leaving a `0`
 * behind: a leftover key with a TTL would keep the gate "configured but down",
 * and `EXISTS`-free reads are one command cheaper.
 */
const LOWER_GATE_FUNCTION = `
local function lowerGate(gateKey, ttl)
  local n = tonumber(redis.call('GET', gateKey) or '0') - 1
  if n <= 0 then
    redis.call('DEL', gateKey)
    return 0
  end
  redis.call('SET', gateKey, n, 'EX', ttl)
  return n
end
`;

export class RedisMembershipCache implements MembershipCache {
  constructor(
    private readonly redis: RedisService,
    private readonly ttlSeconds: number,
    private readonly gateTtlSeconds: number,
  ) {}

  async lookup(key: MembershipCacheKey): Promise<MembershipCacheLookup> {
    try {
      const answer = await this.redis.evalScript(
        LOOKUP_SCRIPT,
        [
          MEMBERSHIP_CACHE_GATE_KEY,
          membershipCacheVersionKey(key.societyId),
          membershipCacheContextKey(key.societyId, key.userId),
        ],
        [],
      );
      const [status, rawVersion, raw] = asReplyArray(answer);
      if (status === "bypass") {
        return { status: "bypass" };
      }
      // A version Redis did not answer with is treated as `0`, which is the value
      // `lookup` compares an entry against: an entry stored under anything else is
      // then a miss. Defensive rather than reachable — the script always returns
      // one — because the alternative on a malformed reply is to guess `hit`.
      const version = typeof rawVersion === "string" ? rawVersion : "0";
      if (status === "hit" && typeof raw === "string") {
        const entry = decodeEntry(raw);
        if (entry !== undefined) {
          return { status: "hit", version, context: entry.context };
        }
      }
      return { status: "miss", version };
    } catch {
      return { status: "bypass" };
    }
  }

  async store(
    key: MembershipCacheKey,
    version: string,
    context: SocietyAuthorizationContext,
  ): Promise<void> {
    const entry: MembershipCacheEntry = { v: version, context };
    try {
      await this.redis.evalScript(
        STORE_SCRIPT,
        [
          MEMBERSHIP_CACHE_GATE_KEY,
          membershipCacheVersionKey(key.societyId),
          membershipCacheContextKey(key.societyId, key.userId),
        ],
        [version, JSON.stringify(entry), String(this.ttlSeconds)],
      );
    } catch {
      // A store that did not happen is a slower next request and nothing else.
    }
  }

  async begin(): Promise<boolean> {
    try {
      await this.redis.evalScript(
        BEGIN_SCRIPT,
        [MEMBERSHIP_CACHE_GATE_KEY],
        [String(this.gateTtlSeconds)],
      );
      return true;
    } catch {
      // Unreachable Redis. Reported rather than thrown: the mutation proceeds,
      // and the reader will bypass the cache anyway for the same reason.
      return this.raiseGateDirectly();
    }
  }

  /**
   * The compensation path for a `begin` that failed.
   *
   * `INCR` failing while `GET` succeeds is not the usual "Redis is down" — it is a
   * Redis that refuses writes (a read-only endpoint, a misrouted replica), and in
   * that shape the gate would otherwise never be raised, leaving the post-commit
   * invalidation as the only protection. `SET` needs no script, so it can still
   * succeed where `EVAL` did not; and a gate that is raised and never lowered is
   * safe, because a raised gate only means "read the database".
   */
  private async raiseGateDirectly(): Promise<boolean> {
    try {
      await this.redis.evalScript(
        "redis.call('SET', KEYS[1], 1, 'EX', ARGV[1]) return 1",
        [MEMBERSHIP_CACHE_GATE_KEY],
        [String(this.gateTtlSeconds)],
      );
      return true;
    } catch {
      // Genuinely unreachable. Reads cannot succeed either, so there is nothing to
      // protect: an unreachable cache is an uncached application.
      return false;
    }
  }

  async commit(
    societyId: SocietyId,
    userIds: readonly UserId[],
  ): Promise<MembershipInvalidationOutcome> {
    try {
      await this.redis.evalScript(
        `${LOWER_GATE_FUNCTION}${COMMIT_SCRIPT}`,
        [
          MEMBERSHIP_CACHE_GATE_KEY,
          membershipCacheVersionKey(societyId),
          ...userIds.map((userId) =>
            membershipCacheContextKey(societyId, userId),
          ),
        ],
        [String(this.gateTtlSeconds)],
      );
      return "invalidated";
    } catch {
      // The gate is still up — the script never lowered it — so every read goes to
      // the database until its TTL expires. That is the safe direction, and it is
      // the reason `commit` must not lower the gate *before* it invalidates.
      return "gated";
    }
  }

  async abort(): Promise<void> {
    try {
      await this.redis.evalScript(
        `${LOWER_GATE_FUNCTION}${ABORT_SCRIPT}`,
        [MEMBERSHIP_CACHE_GATE_KEY],
        [String(this.gateTtlSeconds)],
      );
    } catch {
      // The gate's TTL is the backstop; a leaked gate is safe by construction.
    }
  }
}

/**
 * `commit` answers `"gated"` instead of throwing when Redis cannot be reached
 * after a successful write, and the reason is in the port's own note: the
 * database has already committed, so an exception here could only turn a
 * successful mutation into a failed request. The safety comes from the gate the
 * failed script never lowered, not from the caller's error handling.
 */
function asReplyArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function decodeEntry(raw: string): MembershipCacheEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const entry = parsed as { v?: unknown; context?: unknown };
    if (typeof entry.context !== "object" || entry.context === null) {
      return undefined;
    }
    return entry as MembershipCacheEntry;
  } catch {
    return undefined;
  }
}
