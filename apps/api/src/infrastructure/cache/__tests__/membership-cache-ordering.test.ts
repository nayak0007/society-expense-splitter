import {
  asMemberId,
  asSocietyId,
  asUserId,
  type MemberRole,
  type MembershipStatus,
  type Society,
  type SocietyId,
  type SocietyMembership,
  type UserId,
} from "@ses/domain";

import { CachedSocietyAuthorizationReader } from "../../../common/authorization/cached-society-authorization.reader";
import { MembershipInvalidation } from "../../../common/authorization/membership-invalidation";
import type {
  SocietyAuthorizationContext,
  SocietyAuthorizationReader,
} from "../../../common/authorization/society-authorization";
import { InMemoryMembershipCache } from "../membership-cache.memory";

/**
 * The membership cache's ordering, exercised as a system rather than as a store's
 * API.
 *
 * Every test here drives the *real* trio — the invalidation wrapper the
 * repositories use, the reader the guard uses, and the cache between them — so an
 * assertion like "a suspension is visible to the next request" is a statement about
 * the shipped wiring, not about an in-memory map.
 *
 * ## What is and is not proven here
 *
 * These are deterministic interleavings: the ordering that matters is between an
 * `await`ed database step and an `await`ed cache step, and a test can place them
 * exactly. What a unit test cannot do is prove that two *genuinely* overlapping
 * requests on different processes behave; that is what the concurrency probe
 * against hosted PostgreSQL is for (`scripts/verification/`), and it asserts the
 * same invariant on real sockets.
 *
 * ## The invariant every test below is a form of
 *
 * > After a membership or role mutation has committed, no subsequent authorization
 * > may be granted from the state that preceded it.
 */

const SOCIETY_A = asSocietyId("11111111-1111-4111-8111-111111111111");
const SOCIETY_B = asSocietyId("22222222-2222-4222-8222-222222222222");
const USER = asUserId("33333333-3333-4333-8333-333333333333");
const OTHER_USER = asUserId("44444444-4444-4444-8444-444444444444");

function society(id: SocietyId, name = "Green Valley"): Society {
  return {
    id,
    name,
    slug: "green-valley",
    type: "registered",
    registrationNumber: null,
    addressLine1: null,
    addressLine2: null,
    city: "Pune",
    state: "MH",
    pincode: null,
    country: "IN",
    currency: "INR",
    timezone: "Asia/Kolkata",
    joinCode: "ABC123",
    joinCodeExpiresAt: null,
    plan: "free",
    createdBy: USER,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    settings: {
      lateFeeEnabled: false,
      lateFeePercent: 0,
      graceDays: 0,
      dueDayOfMonth: 5,
      currency: "INR",
    },
    memberCount: 12,
  } as unknown as Society;
}

function membership(
  id: SocietyId,
  userId: UserId,
  role: MemberRole,
  status: MembershipStatus,
): SocietyMembership {
  return {
    id: asMemberId(`aaaa${id}-0000-4000-8000-000000000000`),
    societyId: id,
    userId,
    role,
    status,
    occupancyType: "owner_occupied",
    joinedAt: "2026-09-01T00:00:00.000Z",
  } as unknown as SocietyMembership;
}

function context(
  id: SocietyId,
  userId: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
): SocietyAuthorizationContext {
  return {
    society: society(id),
    membership: membership(id, userId, role, status),
  };
}

/**
 * The database, reduced to the two questions the guard asks: is this caller a
 * member here, and as what.
 *
 * A real Map, mutated by the tests, so a "mutation" is a real change of state and
 * the cache is the only thing under test.
 */
class FakeMembershipTable implements SocietyAuthorizationReader {
  private readonly rows = new Map<string, SocietyAuthorizationContext>();
  public reads = 0;

  put(context: SocietyAuthorizationContext): void {
    this.rows.set(key(context.society.id, context.membership.userId), context);
  }

  remove(id: SocietyId, userId: UserId): void {
    this.rows.delete(key(id, userId));
  }

  async load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    this.reads += 1;
    return this.rows.get(key(societyId, actor)) ?? null;
  }
}

function key(societyId: SocietyId, userId: UserId): string {
  return `${societyId}:${userId}`;
}

/** The wiring: one cache, one table, one invalidator, one cached reader. */
function harness(clock: { now: () => number } = { now: () => Date.now() }) {
  const table = new FakeMembershipTable();
  const cache = new InMemoryMembershipCache(300, 60, clock.now);
  const invalidation = new MembershipInvalidation(cache);
  const reader = new CachedSocietyAuthorizationReader(table, cache);
  return { table, cache, invalidation, reader };
}

describe("membership cache ordering", () => {
  it("serves the second identical read without a second database read", async () => {
    const { table, reader } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));

    await reader.load(SOCIETY_A, USER);
    await reader.load(SOCIETY_A, USER);

    expect(table.reads).toBe(1);
  });

  it("A · a membership that stops being active is visible to the next request", async () => {
    const { table, reader, invalidation } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));

    const before = await reader.load(SOCIETY_A, USER);
    expect(before?.membership.status).toBe("active");

    // The write: the row changes, then the invalidation runs after the commit.
    // `pending` rather than a suspension because the domain's `MembershipStatus`
    // models the three states the guard distinguishes; a suspended row arrives here
    // through the same mapping, and every non-`active` value is refused identically.
    await invalidation.around({ societyId: SOCIETY_A, userIds: [USER] }, () => {
      table.put(context(SOCIETY_A, USER, "admin", "pending"));
      return Promise.resolve();
    });

    const after = await reader.load(SOCIETY_A, USER);
    expect(after?.membership.status).toBe("pending");
  });

  it("B · a role downgrade is visible to the next request", async () => {
    const { table, reader, invalidation } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));
    await reader.load(SOCIETY_A, USER);

    await invalidation.around({ societyId: SOCIETY_A, userIds: [USER] }, () => {
      table.put(context(SOCIETY_A, USER, "resident"));
      return Promise.resolve();
    });

    const after = await reader.load(SOCIETY_A, USER);
    expect(after?.membership.role).toBe("resident");
  });

  it("C · a removal cannot be answered from the cached membership", async () => {
    const { table, reader, invalidation } = harness();
    table.put(context(SOCIETY_A, USER, "treasurer"));
    await reader.load(SOCIETY_A, USER);

    await invalidation.around({ societyId: SOCIETY_A, userIds: [USER] }, () => {
      table.remove(SOCIETY_A, USER);
      return Promise.resolve();
    });

    expect(await reader.load(SOCIETY_A, USER)).toBeNull();
  });

  it("C′ · a removal invalidates the whole society, so a bare societyId is enough", async () => {
    // `member.repository` passes `{ societyId }` and no user ids, because the
    // version bump — not the entry delete — is what does the work. This is that
    // claim, asserted.
    const { table, reader, invalidation } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));
    table.put(context(SOCIETY_A, OTHER_USER, "resident"));
    await reader.load(SOCIETY_A, USER);
    await reader.load(SOCIETY_A, OTHER_USER);

    await invalidation.around({ societyId: SOCIETY_A }, () => {
      table.put(context(SOCIETY_A, USER, "guest"));
      return Promise.resolve();
    });

    expect((await reader.load(SOCIETY_A, USER))?.membership.role).toBe("guest");
    expect((await reader.load(SOCIETY_A, OTHER_USER))?.membership.role).toBe(
      "resident",
    );
  });

  it("D · a rolled-back write leaves the cache exactly as it was", async () => {
    const { table, reader, invalidation } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));
    await reader.load(SOCIETY_A, USER);
    const readsBefore = table.reads;

    await expect(
      invalidation.around({ societyId: SOCIETY_A, userIds: [USER] }, () => {
        // A transaction that aborts after its write: the member row was changed and
        // then rolled back, so the database says the old role still holds.
        return Promise.reject(new Error("deadlock detected"));
      }),
    ).rejects.toThrow("deadlock detected");

    // The entry is still valid — a bump here would have been a lie about the
    // database — so the cached read is served and no extra query is made.
    const after = await reader.load(SOCIETY_A, USER);
    expect(after?.membership.role).toBe("admin");
    expect(table.reads).toBe(readsBefore);
  });

  it("D′ · a rollback does not leave the gate up", async () => {
    const { table, reader, invalidation, cache } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));
    await reader.load(SOCIETY_A, USER);

    await expect(
      invalidation.around({ societyId: SOCIETY_A, userIds: [USER] }, () =>
        Promise.reject(new Error("aborted")),
      ),
    ).rejects.toThrow("aborted");

    // A permanently raised gate would be safe but would silently disable the cache
    // for this society forever; the gate must be down again.
    const lookup = await cache.lookup({ societyId: SOCIETY_A, userId: USER });
    expect(lookup.status).toBe("hit");
  });

  it("E · a negative answer is not cached, so a new membership is seen at once", async () => {
    const { table, reader, invalidation } = harness();

    expect(await reader.load(SOCIETY_A, USER)).toBeNull();

    // Acceptance: the membership appears, with no invalidation needed, because
    // nothing was ever stored for this (society, user).
    await invalidation.around({ societyId: SOCIETY_A, userIds: [USER] }, () => {
      table.put(context(SOCIETY_A, USER, "resident"));
      return Promise.resolve();
    });

    const after = await reader.load(SOCIETY_A, USER);
    expect(after?.membership.role).toBe("resident");
  });

  it("F · invalidation is per society: another tenant's entry survives it", async () => {
    const { table, reader, invalidation } = harness();
    // One user, two societies, two different roles — PRD §2's reason the key needs
    // both halves.
    table.put(context(SOCIETY_A, USER, "admin"));
    table.put(context(SOCIETY_B, USER, "guest"));
    await reader.load(SOCIETY_A, USER);
    await reader.load(SOCIETY_B, USER);
    const readsBefore = table.reads;

    await invalidation.around({ societyId: SOCIETY_A }, () => {
      table.put(context(SOCIETY_A, USER, "tenant"));
      return Promise.resolve();
    });

    expect((await reader.load(SOCIETY_A, USER))?.membership.role).toBe(
      "tenant",
    );
    // Society B was not invalidated and not affected, so its cached entry is still a
    // hit — and it still holds B's role, not A's.
    expect((await reader.load(SOCIETY_B, USER))?.membership.role).toBe("guest");
    expect(table.reads).toBe(readsBefore + 1);
  });

  it("G · a read during a mutation bypasses the cache and stores nothing", async () => {
    const { table, reader, invalidation, cache } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));

    // Freeze the mutation mid-flight: the gate is up and the write has not yet
    // committed.
    let release: () => void = () => undefined;
    const inFlight = invalidation.around(
      { societyId: SOCIETY_A },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const during = await cache.lookup({ societyId: SOCIETY_A, userId: USER });
    expect(during.status).toBe("bypass");

    // The read is answered from the database and, because it was a bypass, is not
    // stored — which is what stops a pre-commit value from outliving the mutation.
    const loaded = await reader.load(SOCIETY_A, USER);
    expect(loaded?.membership.role).toBe("admin");
    release();
    await inFlight;

    const after = await cache.lookup({ societyId: SOCIETY_A, userId: USER });
    expect(after.status).toBe("miss");
  });

  it("H · a read that raced a commit cannot repopulate the cache", async () => {
    const { table, reader, invalidation, cache } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));

    // The reader's database read happens first and captures version 0…
    const captured = await cache.lookup({ societyId: SOCIETY_A, userId: USER });
    expect(captured.status).toBe("miss");

    // …then the mutation commits and invalidates…
    await invalidation.around({ societyId: SOCIETY_A }, () => {
      table.put(context(SOCIETY_A, USER, "guest"));
      return Promise.resolve();
    });

    // …and only then does the stale read try to store what it read before the
    // commit. The version has moved, so the store is refused — which is the window
    // a plain `delete`-after-commit design leaves open.
    await cache.store(
      { societyId: SOCIETY_A, userId: USER },
      captured.status === "miss" ? captured.version : "0",
      context(SOCIETY_A, USER, "admin"),
    );

    const after = await reader.load(SOCIETY_A, USER);
    expect(after?.membership.role).toBe("guest");
  });

  it("I · the gate expires, so a writer that never returns cannot disable the cache forever", async () => {
    let now = 1_000;
    const { cache } = harness({ now: () => now });
    await cache.begin();

    expect(
      (await cache.lookup({ societyId: SOCIETY_A, userId: USER })).status,
    ).toBe("bypass");

    now += 61_000;
    // Expired rather than decremented — the crashed-writer case. The answer is the
    // same one Redis's TTL gives, and it is the safe direction: a cold cache, not a
    // stale one.
    expect(
      (await cache.lookup({ societyId: SOCIETY_A, userId: USER })).status,
    ).toBe("miss");
  });
});

describe("membership cache key isolation", () => {
  it("cannot be read across societies or across users", async () => {
    const { table, reader } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));
    table.put(context(SOCIETY_B, OTHER_USER, "treasurer"));

    await reader.load(SOCIETY_A, USER);
    await reader.load(SOCIETY_B, OTHER_USER);

    // The same user id in another society, and another user in the same society:
    // both must miss, because neither key exists.
    expect(await reader.load(SOCIETY_B, USER)).toBeNull();
    expect(await reader.load(SOCIETY_A, OTHER_USER)).toBeNull();
  });

  it("is keyed on identity, not on the mutable labels in the context", async () => {
    const { table, reader } = harness();
    table.put(context(SOCIETY_A, USER, "admin"));
    await reader.load(SOCIETY_A, USER);

    // A slug, a name and a join code are not keys; changing them in the stored
    // context cannot make one member's entry answer for another's.
    expect(await reader.load(SOCIETY_A, OTHER_USER)).toBeNull();
  });
});
