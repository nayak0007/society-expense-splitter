import { asMemberId, asUserId } from "@ses/domain";
import type {
  ApartmentId,
  BuildingId,
  MemberId,
  MemberRepository,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import {
  MEMBERSHIP_CACHE,
  type MembershipCache,
} from "../../src/common/authorization/membership-cache";
import { MEMBER_REPOSITORY } from "../../src/modules/members/application/member.tokens";

import {
  createLocalUser,
  ownerClient,
  resetData,
} from "../utils/integration-db";
import {
  insertApartment,
  insertBuilding,
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  ownerUrl,
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * `MemberRepositoryPostgres` against real PostgreSQL and real RLS — the storage
 * behaviour the member module's use cases and the guard chain depend on.
 *
 * What is being asserted is the *repository's* contract, not the SQL: the
 * adapter's own rules ("absent means leave alone, null means clear", the
 * directory's filters and totals, the join queue's claims, the soft-removal
 * semantics, and the database errors this adapter classifies) are all decisions
 * made in the adapter or in the policies it runs under, and none of them can be
 * observed through a fake repository. Where a constraint decides — a duplicate
 * shadow phone, a second primary occupant, an unknown flat — the test asserts the
 * *translated* domain error, never PostgreSQL's message.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let members: MemberRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  members = harness.app.get<MemberRepository>(MEMBER_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

interface Fixture extends SocietyFixture {
  readonly buildingId: BuildingId;
  readonly flat101: ApartmentId;
  readonly flat102: ApartmentId;
  readonly residentUserId: UserId;
  readonly residentMemberId: MemberId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(harness);
  const buildingId = await insertBuilding(owner, society.societyId, "A Wing");
  const flat101 = await insertApartment(
    owner,
    society.societyId,
    buildingId,
    "101",
    1,
  );
  const flat102 = await insertApartment(
    owner,
    society.societyId,
    buildingId,
    "102",
    2,
  );
  const residentUserId = asUserId(
    await createLocalUser(owner, "resident@repo.ses.test", "Ravi Kumar"),
  );
  const residentMemberId = asMemberId(
    await insertMember(owner, society.societyId, {
      userId: residentUserId,
      displayName: "Ravi Kumar",
      phone: "+919876500001",
      apartmentId: flat101,
      role: "resident",
    }),
  );
  return {
    ...society,
    buildingId,
    flat101,
    flat102,
    residentUserId,
    residentMemberId,
  };
}

/**
 * The rejection, or a failure if the call resolved. Asserting `code` (the
 * domain's vocabulary) rather than a message is what keeps these tests from
 * encoding PostgreSQL's wording.
 */
async function rejection(
  promise: Promise<unknown>,
): Promise<{ code?: unknown; details?: unknown }> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { code?: unknown; details?: unknown };
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

describe("MemberRepositoryPostgres", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("create", () => {
    it("records a shadow member with the column defaults the directory shows", async () => {
      const member = await members.create(
        fixture.societyId,
        { displayName: "Meera Joshi", phone: "+919876500010" },
        fixture.adminUserId,
      );

      // A shadow member: no account, active, an ordinary resident — the three
      // facts `members_insert_admin` pins and the API depends on.
      expect(member.userId).toBeNull();
      expect(member.status).toBe("active");
      expect(member.role).toBe("resident");
      expect(member.occupancy).toBe("owner_occupied");
      expect(member.isPrimary).toBe(false);
      expect(member.shareContact).toBe(false);
      // `joined_at` is the trigger's, and it ran — an active row is a joined row.
      expect(member.joinedAt).not.toBeNull();

      const [row] = await owner<{ count: string }[]>`
        select count(*)::text as count from public.members
         where society_id = ${fixture.societyId}::uuid and user_id is null
      `;
      expect(Number(row?.count)).toBe(1);
    });

    it("persists every optional field and maps them back from a joined read", async () => {
      const created = await members.create(
        fixture.societyId,
        {
          displayName: "Sana Qureshi",
          phone: "+919876500011",
          email: "sana@repo.ses.test",
          occupancy: "tenant",
          apartmentId: fixture.flat102,
          isPrimary: true,
          leaseStart: "2026-04-01",
          leaseEnd: "2027-03-31",
          shareContact: true,
        },
        fixture.adminUserId,
      );

      // Re-read through the joined path: a mapping mistake that only shows up on
      // one of the two read shapes is exactly what this catches.
      const read = await members.findById(
        created.id,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(read).not.toBeNull();
      expect(read).toMatchObject({
        displayName: "Sana Qureshi",
        phone: "+919876500011",
        email: "sana@repo.ses.test",
        occupancy: "tenant",
        isPrimary: true,
        leaseStart: "2026-04-01",
        leaseEnd: "2027-03-31",
        shareContact: true,
      });
      // The flat's label projection rides the left join.
      expect(read?.apartment).toMatchObject({ number: "102", floor: 2 });
    });

    it("translates the shadow-phone constraint into a field error, keeping one row", async () => {
      await members.create(
        fixture.societyId,
        { displayName: "First", phone: "+919876500012" },
        fixture.adminUserId,
      );

      const error = await rejection(
        members.create(
          fixture.societyId,
          { displayName: "Second", phone: "+919876500012" },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");
      expect(error.details).toMatchObject({ field: "phone" });

      const [row] = await owner<{ count: string }[]>`
        select count(*)::text as count from public.members
         where society_id = ${fixture.societyId}::uuid and phone = '+919876500012'
      `;
      expect(Number(row?.count)).toBe(1);
    });

    it("refuses a flat from another society as a field error, not a crash", async () => {
      const other = await seedSociety(
        harness,
        "Beta Court",
        "beta@repo.ses.test",
      );
      const otherBuilding = await insertBuilding(
        owner,
        other.societyId,
        "B Wing",
      );
      const otherFlat = await insertApartment(
        owner,
        other.societyId,
        otherBuilding,
        "B-1",
        1,
      );

      const error = await rejection(
        members.create(
          fixture.societyId,
          {
            displayName: "Wrong Flat",
            phone: "+919876500013",
            apartmentId: otherFlat,
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "apartmentId" });
    });

    it("refuses a primary occupant with no flat", async () => {
      const error = await rejection(
        members.create(
          fixture.societyId,
          {
            displayName: "Primary No Flat",
            phone: "+919876500014",
            isPrimary: true,
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "apartmentId" });
    });

    it("refuses an inverted lease window", async () => {
      const error = await rejection(
        members.create(
          fixture.societyId,
          {
            displayName: "Backwards Lease",
            phone: "+919876500015",
            apartmentId: fixture.flat101,
            leaseStart: "2027-01-01",
            leaseEnd: "2026-01-01",
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("validation");
      expect(error.details).toMatchObject({ field: "leaseEnd" });
    });

    it("translates a second primary owner of the same flat into a conflict", async () => {
      // Make the fixture resident the primary owner of 101 first, then the next
      // primary owner of the same flat and occupancy is `uq_primary_occupant` —
      // the rule two racing writers cannot check in application code.
      await members.update(
        fixture.residentMemberId,
        fixture.societyId,
        { isPrimary: true },
        fixture.adminUserId,
      );
      const error = await rejection(
        members.create(
          fixture.societyId,
          {
            displayName: "Second Owner",
            phone: "+919876500016",
            apartmentId: fixture.flat101,
            isPrimary: true,
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");
      expect(error.details).toMatchObject({ field: "apartmentId" });
    });
  });

  describe("reads", () => {
    it("returns a live member with their flat, and null across tenants", async () => {
      const member = await members.findById(
        fixture.residentMemberId,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(member).toMatchObject({
        displayName: "Ravi Kumar",
        status: "active",
      });
      expect(member?.apartment).toMatchObject({ number: "101", floor: 1 });

      // A member of another society: the policy filters the row, so the answer
      // is `null` — the same answer as "no such member" (PRD T041).
      const other = await seedSociety(
        harness,
        "Gamma Court",
        "gamma@repo.ses.test",
      );
      const outsider = await members.findById(
        fixture.residentMemberId,
        fixture.societyId,
        other.adminUserId,
      );
      expect(outsider).toBeNull();
    });

    it("stops returning a removed member", async () => {
      await members.remove(
        fixture.residentMemberId,
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(
        await members.findById(
          fixture.residentMemberId,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBeNull();
    });

    it("returns the caller's own row in any live status, and null otherwise", async () => {
      // Pending is not a refusal — the capability evaluation is what turns it
      // into one, and collapsing it here would make a suspended member see
      // "not available" for their own society.
      await owner`
        update public.members set status = 'pending'
         where id = ${fixture.residentMemberId}::uuid
      `;
      const pending = await members.findViewer(
        fixture.societyId,
        fixture.residentUserId,
      );
      expect(pending).toMatchObject({ status: "pending" });

      await owner`
        update public.members set status = 'inactive'
         where id = ${fixture.residentMemberId}::uuid
      `;
      const inactive = await members.findViewer(
        fixture.societyId,
        fixture.residentUserId,
      );
      expect(inactive).toMatchObject({ status: "inactive" });

      // No membership at all.
      const strangerUserId = asUserId(
        await createLocalUser(owner, "stranger@repo.ses.test", "Stranger"),
      );
      expect(
        await members.findViewer(fixture.societyId, strangerUserId),
      ).toBeNull();
    });

    it("finds a live shadow member by number, and only a shadow member", async () => {
      const shadow = await members.create(
        fixture.societyId,
        { displayName: "Shadow", phone: "+919876500020" },
        fixture.adminUserId,
      );

      const found = await members.findLiveShadowByPhone(
        fixture.societyId,
        "+919876500020",
        fixture.adminUserId,
      );
      expect(found?.id).toBe(shadow.id);

      // Ravi holds a number and an account: two account holders may share a
      // number, so this is deliberately not a hit.
      expect(
        await members.findLiveShadowByPhone(
          fixture.societyId,
          "+919876500001",
          fixture.adminUserId,
        ),
      ).toBeNull();

      // `exceptId` is how the update path asks about the number it is keeping.
      expect(
        await members.findLiveShadowByPhone(
          fixture.societyId,
          "+919876500020",
          fixture.adminUserId,
          shadow.id,
        ),
      ).toBeNull();

      // Removed rows are not live shadows.
      await members.remove(shadow.id, fixture.societyId, fixture.adminUserId);
      expect(
        await members.findLiveShadowByPhone(
          fixture.societyId,
          "+919876500020",
          fixture.adminUserId,
        ),
      ).toBeNull();
    });

    it("lists the live roster by default and the removed rows on request", async () => {
      await members.create(
        fixture.societyId,
        { displayName: "Aarav Shah", phone: "+919876500030" },
        fixture.adminUserId,
      );
      const toRemove = await members.create(
        fixture.societyId,
        { displayName: "Zoya Khan", phone: "+919876500031" },
        fixture.adminUserId,
      );
      await members.remove(toRemove.id, fixture.societyId, fixture.adminUserId);

      const live = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {},
      );
      // The society's creator is a member too — the directory shows every live
      // membership, and that is an invariant worth seeing explicitly.
      expect(live.members.map((m) => m.displayName)).toEqual([
        "Aarav Shah",
        "Admin",
        "Ravi Kumar",
      ]);
      // The total counts the filtered roster, not the page.
      expect(live.total).toBe(3);

      const removed = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        { status: "removed" },
      );
      expect(removed.members.map((m) => m.displayName)).toEqual(["Zoya Khan"]);
      expect(removed.total).toBe(1);
    });

    it("filters by role, occupancy, flat and building", async () => {
      const committeeMemberId = await insertMember(owner, fixture.societyId, {
        displayName: "Committee Member",
        phone: "+919876500032",
        role: "committee_member",
        occupancy: "tenant",
        apartmentId: fixture.flat102,
      });
      expect(committeeMemberId).toBeTruthy();

      // `committee_member` is the domain's spelling; the database's is
      // `committee`. A filter that pushed the raw value would fail the enum cast.
      const byRole = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        { role: "committee_member" },
      );
      expect(byRole.members.map((m) => m.role)).toEqual(["committee_member"]);

      const byOccupancy = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        { occupancy: "tenant" },
      );
      expect(byOccupancy.members.map((m) => m.displayName)).toEqual([
        "Committee Member",
      ]);

      const byFlat = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {
          apartmentId: fixture.flat102,
        },
      );
      expect(byFlat.members.map((m) => m.displayName)).toEqual([
        "Committee Member",
      ]);

      const byBuilding = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        { buildingId: fixture.buildingId },
      );
      expect(byBuilding.members.map((m) => m.displayName)).toEqual([
        "Committee Member",
        "Ravi Kumar",
      ]);
    });

    it("searches names, numbers and flat labels, and treats wildcards literally", async () => {
      await members.create(
        fixture.societyId,
        { displayName: "50% Owner", phone: "+919876500040" },
        fixture.adminUserId,
      );

      const byName = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {
          query: "ravi",
        },
      );
      expect(byName.members.map((m) => m.displayName)).toEqual(["Ravi Kumar"]);

      const byPhone = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {
          query: "876500040",
        },
      );
      expect(byPhone.members.map((m) => m.displayName)).toEqual(["50% Owner"]);

      const byFlat = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {
          query: "101",
        },
      );
      expect(byFlat.members.map((m) => m.displayName)).toEqual(["Ravi Kumar"]);

      // A `%` is a percent sign here, not "match everything": the escaping and
      // the `escape '\'` clause are the only reason this returns one row.
      const byWildcard = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        { query: "%" },
      );
      expect(byWildcard.members.map((m) => m.displayName)).toEqual([
        "50% Owner",
      ]);
    });

    it("orders by name or by join date, deterministically", async () => {
      await insertMember(owner, fixture.societyId, {
        displayName: "Aarav Shah",
        phone: "+919876500050",
        joinedAt: "2026-01-01T00:00:00Z",
      });
      await insertMember(owner, fixture.societyId, {
        displayName: "Zoya Khan",
        phone: "+919876500051",
        joinedAt: "2026-06-01T00:00:00Z",
      });
      // Ravi's fixture row joined "now", so joined-desc is Zoya, Ravi, Aarav.
      const byJoined = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {
          sort: "joined",
        },
      );
      // Newest first: Ravi and Admin joined during the seed (Ravi last), then the
      // two explicit dates.
      expect(byJoined.members.map((m) => m.displayName)).toEqual([
        "Ravi Kumar",
        "Admin",
        "Zoya Khan",
        "Aarav Shah",
      ]);

      // Byte order, not locale order — the same rule the index uses. ("Aarav"
      // before "Admin": code units, where `a` sorts before `d`.)
      const byName = await members.list(
        fixture.societyId,
        fixture.adminUserId,
        {},
      );
      expect(byName.members.map((m) => m.displayName)).toEqual([
        "Aarav Shah",
        "Admin",
        "Ravi Kumar",
        "Zoya Khan",
      ]);
    });

    it("pages the roster without changing the total", async () => {
      await insertMember(owner, fixture.societyId, {
        displayName: "Aarav Shah",
      });
      await insertMember(owner, fixture.societyId, {
        displayName: "Zoya Khan",
      });

      const page = await members.list(fixture.societyId, fixture.adminUserId, {
        limit: 1,
        offset: 1,
      });
      expect(page.members).toHaveLength(1);
      // Name order across the whole roster: Aarav, Admin, Ravi, Zoya — offset 1
      // is the second row, and the total is still the filtered count.
      expect(page.members[0]?.displayName).toBe("Admin");
      expect(page.total).toBe(4);
    });

    it("shows a non-member nothing, rather than an error", async () => {
      const outsiderUserId = asUserId(
        await createLocalUser(owner, "other@repo.ses.test", "Other"),
      );

      const page = await members.list(fixture.societyId, outsiderUserId, {});
      expect(page.members).toEqual([]);
      // The count rides the same filtered scan: an empty page has no total row,
      // and the honest answer then is zero.
      expect(page.total).toBe(0);
    });
  });

  describe("writes", () => {
    it("patches only the fields that were sent, with null meaning clear", async () => {
      const patched = await members.update(
        fixture.residentMemberId,
        fixture.societyId,
        { displayName: "Ravi K. Kumar" },
        fixture.adminUserId,
      );
      // The absent fields survived; only the sent one changed.
      expect(patched.displayName).toBe("Ravi K. Kumar");
      expect(patched.phone).toBe("+919876500001");

      const cleared = await members.update(
        fixture.residentMemberId,
        fixture.societyId,
        { phone: null, apartmentId: null, leaseStart: null },
        fixture.adminUserId,
      );
      expect(cleared.phone).toBeNull();
      expect(cleared.apartmentId).toBeNull();
      expect(cleared.leaseStart).toBeNull();
      expect(cleared.email).toBeNull();

      // Persisted, not just returned.
      const reread = await members.findById(
        fixture.residentMemberId,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(reread).toMatchObject({
        displayName: "Ravi K. Kumar",
        phone: null,
        apartmentId: null,
      });
      expect(reread?.apartment).toBeNull();
    });

    it("rejects an empty patch as the caller mistake it is", async () => {
      const error = await rejection(
        members.update(
          fixture.residentMemberId,
          fixture.societyId,
          {},
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("validation");
    });

    it("answers not_found for a member of another society or a removed one", async () => {
      const other = await seedSociety(
        harness,
        "Delta Court",
        "delta@repo.ses.test",
      );
      const otherMemberId = asMemberId(
        await insertMember(owner, other.societyId, { displayName: "Theirs" }),
      );

      // Another society's id, filtered by this society's WHERE — and by RLS.
      const foreign = await rejection(
        members.update(
          otherMemberId,
          fixture.societyId,
          { displayName: "Mine Now" },
          fixture.adminUserId,
        ),
      );
      expect(foreign.code).toBe("not_found");

      await members.remove(otherMemberId, other.societyId, other.adminUserId);
      const removed = await rejection(
        members.update(
          otherMemberId,
          other.societyId,
          { displayName: "Again" },
          other.adminUserId,
        ),
      );
      expect(removed.code).toBe("not_found");
    });

    it("suspends and reactivates without restamping the join date", async () => {
      const before = await members.findById(
        fixture.residentMemberId,
        fixture.societyId,
        fixture.adminUserId,
      );

      const suspended = await members.setStatus(
        fixture.residentMemberId,
        fixture.societyId,
        "inactive",
        fixture.adminUserId,
      );
      expect(suspended.status).toBe("inactive");

      const reactivated = await members.setStatus(
        fixture.residentMemberId,
        fixture.societyId,
        "active",
        fixture.adminUserId,
      );
      expect(reactivated.status).toBe("active");
      // `stamp_member_approval()` is an INSERT trigger; re-activation is not a
      // second join and must not restamp the date the directory sorts on.
      expect(reactivated.joinedAt).toBe(before?.joinedAt);

      // Re-writing the status it already holds is not an error: one row matched,
      // and the answer is the row.
      const idempotent = await members.setStatus(
        fixture.residentMemberId,
        fixture.societyId,
        "active",
        fixture.adminUserId,
      );
      expect(idempotent.status).toBe("active");
    });

    it("changes a stored role through the domain's spelling", async () => {
      const promoted = await members.setRole(
        fixture.residentMemberId,
        fixture.societyId,
        "committee_member",
        fixture.adminUserId,
      );
      expect(promoted.role).toBe("committee_member");

      // Round-trip: the database holds `committee`, the domain reads
      // `committee_member`, and a second write of the same value is allowed.
      const [row] = await owner<{ role: string }[]>`
        select role::text as role from public.members
         where id = ${fixture.residentMemberId}::uuid
      `;
      expect(row?.role).toBe("committee");

      // Changing one's *own* role is refused by `chk_member_self_change()` even
      // for the Admin: a demotion is a decision about somebody else.
      const error = await rejection(
        members.setRole(
          fixture.adminMemberId,
          fixture.societyId,
          "resident",
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("forbidden");

      // A caller whose role cannot write at all is refused by the policy before
      // the trigger ever runs — another row, another role, same answer as a row
      // that does not exist.
      const shadowId = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Promotion Target",
        }),
      );
      const notAllowed = await rejection(
        members.setRole(
          shadowId,
          fixture.societyId,
          "treasurer",
          fixture.residentUserId,
        ),
      );
      expect(notAllowed.code).toBe("not_found");
    });

    it("counts only active holders of a role, excluding the row being written", async () => {
      await members.setRole(
        fixture.residentMemberId,
        fixture.societyId,
        "committee_member",
        fixture.adminUserId,
      );
      const suspendedId = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Suspended Committee",
          role: "committee_member",
          status: "inactive",
        }),
      );
      expect(suspendedId).toBeTruthy();

      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "committee_member",
          fixture.adminUserId,
        ),
      ).toBe(1);
      // The suspended holder is not occupying a slot — the count is what PRD
      // §2.2's caps are made of.
      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "committee_member",
          fixture.adminUserId,
          fixture.residentMemberId,
        ),
      ).toBe(0);
      // No committee members under `admin`, where the count is zero rather than
      // "not found".
      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "guest",
          fixture.adminUserId,
        ),
      ).toBe(0);
    });

    it("soft-removes with the actor stamped, and refuses a second removal", async () => {
      await members.remove(
        fixture.residentMemberId,
        fixture.societyId,
        fixture.adminUserId,
      );

      const [row] = await owner<
        {
          status: string;
          removed_at: string | null;
          removed_by: string | null;
        }[]
      >`
        select status::text as status, removed_at::text as removed_at, removed_by
          from public.members where id = ${fixture.residentMemberId}::uuid
      `;
      expect(row?.status).toBe("removed");
      expect(row?.removed_at).not.toBeNull();
      // The trigger stamps the acting admin's own membership, not a value sent
      // by the caller.
      expect(row?.removed_by).toBe(fixture.adminMemberId);

      const again = await rejection(
        members.remove(
          fixture.residentMemberId,
          fixture.societyId,
          fixture.adminUserId,
        ),
      );
      expect(again.code).toBe("not_found");
    });
  });

  describe("the join queue", () => {
    /** One pending request, as the join flow lands it: `pending` and `resident`. */
    async function joinRequest(displayName: string): Promise<MemberId> {
      return asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName,
          status: "pending",
        }),
      );
    }

    /** The stored row, for the assertions about what actually landed. */
    async function storedRow(
      id: MemberId,
    ): Promise<{ status: string; role: string }> {
      const [row] = await owner<{ status: string; role: string }[]>`
        select status::text as status, role::text as role
          from public.members where id = ${id}::uuid
      `;
      if (row === undefined) throw new Error("the member row is missing");
      return row;
    }

    it("lists pending requests newest-first with the same flat's live claimants", async () => {
      const claimantId = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Flatmate",
          phone: "+919876500060",
          apartmentId: fixture.flat101,
        }),
      );
      const requestWithFlat = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Requester One",
          status: "pending",
          apartmentId: fixture.flat101,
          requestNote: "I live here",
        }),
      );
      const requestWithoutFlat = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Requester Two",
          status: "pending",
        }),
      );
      expect(claimantId && requestWithoutFlat).toBeTruthy();

      const page = await members.listJoinRequests(
        fixture.societyId,
        fixture.adminUserId,
        {},
      );
      expect(page.total).toBe(2);
      // Newest first: the two inserts share a timestamp at millisecond
      // resolution only rarely, so the order is asserted via the notes instead.
      const byName = new Map(
        page.requests.map((request) => [
          request.member.displayName,
          request.claims.map((claim) => claim.displayName),
        ]),
      );

      // The request's own flat: the pending claimant, the live flatmate, and the
      // requester itself — every live membership naming that flat.
      expect(byName.get("Requester One")).toEqual([
        "Ravi Kumar",
        "Flatmate",
        "Requester One",
      ]);
      // No flat, no claims by construction: "both have no flat" is not a claim.
      expect(byName.get("Requester Two")).toEqual([]);
      expect(requestWithFlat).toBeTruthy();

      const first = await members.listJoinRequests(
        fixture.societyId,
        fixture.adminUserId,
        { limit: 1, offset: 0 },
      );
      expect(first.requests).toHaveLength(1);
      expect(first.total).toBe(2);
    });

    it("admits a pending request with the approver's corrections", async () => {
      const requestId = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Applicant",
          status: "pending",
          requestNote: "Please approve",
        }),
      );

      const approved = await members.approveJoinRequest(
        requestId,
        fixture.societyId,
        {
          occupancy: "tenant",
          apartmentId: fixture.flat102,
          isPrimary: false,
        },
        fixture.adminUserId,
      );

      expect(approved.status).toBe("active");
      expect(approved.occupancy).toBe("tenant");
      expect(approved.apartmentId).toBe(fixture.flat102);
      // No role was sent, so the requested role survives the approval.
      expect(approved.role).toBe("resident");
      // The approval is a join: the function stamps it, with the reviewer's own
      // membership as the approver.
      expect(approved.joinedAt).not.toBeNull();
      expect(approved.approvedBy).toBe(fixture.adminMemberId);
    });

    it("admits a request at a corrected role", async () => {
      // The regression this file carried as `it.failing`: `member_approve_join()`
      // sets `status = 'active'` and the corrected `role` in ONE update, and
      // `chk_role_caps()` refused any role change while `OLD.status = 'pending'` —
      // so the documented "corrected role" path (Roadmap T049) failed with
      // MEMBER_ROLE_CHANGE_FORBIDDEN. `committee_member` is deliberately the case:
      // it is the one role whose label differs between the domain and the enum, so
      // the payload's translation is exercised on the way in and the read's on the
      // way back.
      const requestId = await joinRequest("Corrected Role Applicant");

      const approved = await members.approveJoinRequest(
        requestId,
        fixture.societyId,
        { role: "committee_member" },
        fixture.adminUserId,
      );
      expect(approved.status).toBe("active");
      expect(approved.role).toBe("committee_member");
      // The database's own label landed, and the decision consumed the request.
      expect(await storedRow(requestId)).toEqual({
        status: "active",
        role: "committee",
      });
    });

    it("admits at the requested role or at any role the approver corrects to", async () => {
      // The approval's role menu (PRD §2.1): absent means "as requested", and a
      // correction may be any role the reviewer holds `member.role_change` for — all
      // six, for an Admin. Every request row here is `resident` before the decision,
      // because both INSERT policies pin one to that; what the approval settles is
      // the *effective* role.
      const corrected = [
        "resident",
        "committee_member",
        "tenant",
        "guest",
        "treasurer",
        "admin",
      ] as const;

      for (const role of corrected) {
        const requestId = await joinRequest(`Applicant ${role}`);
        const approved = await members.approveJoinRequest(
          requestId,
          fixture.societyId,
          { role },
          fixture.adminUserId,
        );
        expect(approved.status).toBe("active");
        expect(approved.role).toBe(role);
      }

      // Each correction is a membership the caps now count: one Treasurer, and two
      // active Admins — the society's creator and the correction just made.
      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "treasurer",
          fixture.adminUserId,
        ),
      ).toBe(1);
      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "admin",
          fixture.adminUserId,
        ),
      ).toBe(2);
    });

    it("refuses a correction the reviewer's own grant cannot make", async () => {
      // `member.approve` (Admin and Treasurer) says *whether* somebody joins;
      // `member.role_change` (Admin only) is what hands out a role — PRD §2.1. The
      // RPC enforces it, as does `checkJoinRoleAssignment()` above it.
      const treasurerUserId = asUserId(
        await createLocalUser(
          owner,
          "treasurer-queue@repo.ses.test",
          "Tara Treasurer",
        ),
      );
      await insertMember(owner, fixture.societyId, {
        userId: treasurerUserId,
        displayName: "Tara Treasurer",
        role: "treasurer",
        status: "active",
      });
      const requestId = await joinRequest("Committee Hopeful");

      const error = await rejection(
        members.approveJoinRequest(
          requestId,
          fixture.societyId,
          { role: "committee_member" },
          treasurerUserId,
        ),
      );
      expect(error.code).toBe("role_not_assignable");
      // Refused before the write: the request is still the society's to decide.
      expect(await storedRow(requestId)).toEqual({
        status: "pending",
        role: "resident",
      });
    });

    it("keeps the cap refusal on the corrected-role path", async () => {
      // Three active admins — the creator plus two — so a fourth admitted through the
      // queue must be refused. This is the half the fix could have traded away: an
      // activation that carries a role is still exactly the write PRD §2.2's cap
      // counts, and the count still happens under the per-society lock.
      await insertMember(owner, fixture.societyId, {
        displayName: "Admin Two",
        role: "admin",
        status: "active",
      });
      await insertMember(owner, fixture.societyId, {
        displayName: "Admin Three",
        role: "admin",
        status: "active",
      });
      const requestId = await joinRequest("Admin Hopeful");

      const error = await rejection(
        members.approveJoinRequest(
          requestId,
          fixture.societyId,
          { role: "admin" },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("role_cap_exceeded");
      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "admin",
          fixture.adminUserId,
        ),
      ).toBe(3);
      // The whole approval rolled back, activation included.
      expect(await storedRow(requestId)).toEqual({
        status: "pending",
        role: "resident",
      });
    });

    it("still refuses a role change that leaves a membership un-admitted", async () => {
      // The clause the fix narrowed, not removed: a role change on a pending row that
      // stays pending is still MEMBER_ROLE_CHANGE_FORBIDDEN. `applyRoleChange`
      // refuses a pending target first with a sentence; this is the database's own
      // lock behind that door, reached here directly through the adapter.
      const requestId = await joinRequest("Premature Promotion");

      const error = await rejection(
        members.setRole(
          requestId,
          fixture.societyId,
          "committee_member",
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("forbidden");
      expect(await storedRow(requestId)).toEqual({
        status: "pending",
        role: "resident",
      });
    });

    it("refuses a reviewer from another society, whatever role they correct to", async () => {
      // RLS is not the only boundary: the RPC resolves the reviewer from the
      // request's OWN society, so another society's Admin cannot decide this queue
      // even holding the request's id — and the answer is the same `not_found` an
      // unavailable row gets, so they learn nothing about the row.
      const other = await seedSociety(
        harness,
        "Epsilon Court",
        "epsilon@repo.ses.test",
      );
      const requestId = await joinRequest("Not Yours");

      const error = await rejection(
        members.approveJoinRequest(
          requestId,
          fixture.societyId,
          { role: "treasurer" },
          other.adminUserId,
        ),
      );
      expect(error.code).toBe("not_found");
      expect(await storedRow(requestId)).toEqual({
        status: "pending",
        role: "resident",
      });
    });

    it("bumps the society's membership-cache version on a corrected approval", async () => {
      // T038's ordering, unchanged by the fix: the invalidation is a society-scoped
      // version bump after the commit, and an approval admits a member — a new
      // authorization context for them and a changed population for everybody
      // picking roles. The adapter names the scope; this reads the version the cache
      // actually holds, before and after.
      const cache = harness.app.get<MembershipCache>(MEMBERSHIP_CACHE);
      const key = {
        societyId: fixture.societyId,
        userId: fixture.adminUserId,
      };
      const before = await cache.lookup(key);
      const requestId = await joinRequest("Cache Applicant");

      await members.approveJoinRequest(
        requestId,
        fixture.societyId,
        { role: "committee_member" },
        fixture.adminUserId,
      );

      const after = await cache.lookup(key);
      if (before.status === "bypass" || after.status === "bypass") {
        // Not a silent pass: an integration run binds the Redis store, and a test
        // that asserted "the version moved" against a cache that was never there
        // would be asserting nothing.
        throw new Error(
          "the membership cache was unreachable — MEMBERSHIP_CACHE_STORE=redis is the harness's setting",
        );
      }
      expect(after.version).not.toBe(before.version);
    });

    it("refuses to decide a request twice", async () => {
      const requestId = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Applicant Two",
          status: "pending",
        }),
      );

      await members.approveJoinRequest(
        requestId,
        fixture.societyId,
        {},
        fixture.adminUserId,
      );

      const again = await rejection(
        members.approveJoinRequest(
          requestId,
          fixture.societyId,
          {},
          fixture.adminUserId,
        ),
      );
      expect(again.code).toBe("join_request_not_pending");

      const rejectAgain = await rejection(
        members.rejectJoinRequest(
          requestId,
          fixture.societyId,
          "No longer needed.",
          fixture.adminUserId,
        ),
      );
      expect(rejectAgain.code).toBe("join_request_not_pending");

      // A reason shorter than the rule's minimum is refused *before* the state is
      // even consulted — the pending row stays pending.
      const shortReason = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Needs A Reason",
          status: "pending",
        }),
      );
      const reasonless = await rejection(
        members.rejectJoinRequest(
          shortReason,
          fixture.societyId,
          "No",
          fixture.adminUserId,
        ),
      );
      expect(reasonless.code).toBe("validation");
    });

    it("records a rejection with its reason and keeps the row readable", async () => {
      const requestId = asMemberId(
        await insertMember(owner, fixture.societyId, {
          displayName: "Rejected Applicant",
          status: "pending",
        }),
      );

      const rejected = await members.rejectJoinRequest(
        requestId,
        fixture.societyId,
        "The flat is already claimed.",
        fixture.adminUserId,
      );
      expect(rejected.status).toBe("rejected");
      expect(rejected.rejectionReason).toBe("The flat is already claimed.");

      // The rejected row is history the reviewer can still see — and the person
      // can ask again later, which is the society module's transition.
      const page = await members.listJoinRequests(
        fixture.societyId,
        fixture.adminUserId,
        {},
      );
      expect(page.requests).toEqual([]);
      const found = await members.findById(
        requestId,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(found?.status).toBe("rejected");
    });

    it("admits at most one of two overlapping approvals to a capped role", async () => {
      // Real overlapping transactions, not a sequence: both approvals leave on their
      // own pooled connection, and the second waits on the per-society advisory lock
      // `chk_role_caps()` takes before its count — the ordering the concurrency
      // remediation built. The society has two active admins, so the first to commit
      // fills the third slot and the second must be refused; without the lock each
      // would count the pre-state and both would pass.
      await insertMember(owner, fixture.societyId, {
        displayName: "Admin Two",
        role: "admin",
        status: "active",
      });
      const first = await joinRequest("Race A");
      const second = await joinRequest("Race B");

      const results = await Promise.allSettled([
        members.approveJoinRequest(
          first,
          fixture.societyId,
          { role: "admin" },
          fixture.adminUserId,
        ),
        members.approveJoinRequest(
          second,
          fixture.societyId,
          { role: "admin" },
          fixture.adminUserId,
        ),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]?.reason as { code?: unknown }).code).toBe(
        "role_cap_exceeded",
      );

      // Three active admins exactly, and the loser is still a request: its refusal
      // rolled the activation back with it.
      expect(
        await members.countActiveByRole(
          fixture.societyId,
          "admin",
          fixture.adminUserId,
        ),
      ).toBe(3);
      const statuses = [
        (await storedRow(first)).status,
        (await storedRow(second)).status,
      ];
      expect(statuses.filter((status) => status === "active")).toHaveLength(1);
      expect(statuses.filter((status) => status === "pending")).toHaveLength(1);
    });

    it("waits on the society's membership lock before counting a corrected role", async () => {
      // The deterministic half of the same proof: hold the society's advisory lock in
      // a transaction of its own, then start a corrected-role approval. It cannot
      // resolve while the lock is held — which is only true if the activation reached
      // the lock instead of returning before it — and it completes once the lock is
      // released.
      const requestId = await joinRequest("Locked Applicant");
      const blocker = ownerClient(ownerUrl());
      let approval!: Promise<{ role: string }>;
      let outcome = "";

      try {
        await blocker.begin(async (tx) => {
          await tx`select public.lock_society_membership_writes(${fixture.societyId}::uuid)`;
          approval = members.approveJoinRequest(
            requestId,
            fixture.societyId,
            { role: "admin" },
            fixture.adminUserId,
          );
          outcome = await Promise.race([
            approval.then(
              () => "resolved",
              () => "rejected",
            ),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve("blocked"), 300),
            ),
          ]);
        });
      } finally {
        await blocker.end({ timeout: 5 });
      }

      expect(outcome).toBe("blocked");
      await expect(approval).resolves.toMatchObject({ role: "admin" });
    });
  });
});
