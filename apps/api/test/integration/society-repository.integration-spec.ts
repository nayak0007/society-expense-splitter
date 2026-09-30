import { paise } from "@ses/domain";
import type {
  ApartmentId,
  SocietyRepository,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { SOCIETY_REPOSITORY } from "../../src/modules/societies/application/society.tokens";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertApartment,
  insertBuilding,
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * `SocietyRepositoryPostgres` against real PostgreSQL and real RLS — the storage
 * behaviour the guards, the switcher and the join flow all read through.
 *
 * The repository is the tenant boundary: `society_snapshot()` is asked under the
 * caller's own transaction identity, so "not a member", "deleted" and "never
 * existed" are one answer (`null`) and a stranger's probe cannot enumerate
 * societies. These tests assert that answer, the RPC-owned write invariants
 * (`society_create` seeding the creator's Admin membership, the slug, the join
 * code), the join-code reads, and the join/leave state machine — through the real
 * adapter only. Where the database decides, the assertion is the *translated*
 * domain error, never PostgreSQL's wording.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
// One instance satisfies both the society port and the structure module's narrow
// membership read; the adapter is what `SOCIETY_REPOSITORY` resolves to.
let societies: SocietyRepository & StructureMembershipReader;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  societies = harness.app.get<SocietyRepository & StructureMembershipReader>(
    SOCIETY_REPOSITORY,
  );
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

interface Fixture extends SocietyFixture {
  readonly buildingId: Awaited<ReturnType<typeof insertBuilding>>;
  readonly flat101: ApartmentId;
  readonly flat102: ApartmentId;
  /** An active ordinary member of the society, with an account. */
  readonly neighbourUserId: UserId;
  readonly neighbourMemberId: string;
  /** A signed-in user with no membership anywhere. */
  readonly strangerUserId: UserId;
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

  const neighbourUserId = (await createLocalUser(
    owner,
    "neighbour@repo.ses.test",
    "Neighbour",
  )) as UserId;
  const neighbourMemberId = await insertMember(owner, society.societyId, {
    userId: neighbourUserId,
    displayName: "Neighbour",
    phone: "+919876500101",
    role: "resident",
    apartmentId: flat102,
  });

  const strangerUserId = (await createLocalUser(
    owner,
    "stranger@repo.ses.test",
    "Stranger",
  )) as UserId;

  return {
    ...society,
    buildingId,
    flat101,
    flat102,
    neighbourUserId,
    neighbourMemberId,
    strangerUserId,
  };
}

/** The rejection's `code`/`details` (domain vocabulary), or a failure if it resolved. */
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

describe("SocietyRepositoryPostgres", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("reads", () => {
    it("returns the caller's own memberships and hides a removed one", async () => {
      const mine = await societies.listMemberships(fixture.adminUserId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        societyId: fixture.societyId,
        role: "admin",
        status: "active",
      });

      // A stranger has no memberships, not an error.
      expect(await societies.listMemberships(fixture.strangerUserId)).toEqual(
        [],
      );

      // Once the caller leaves, the row is `removed` and drops out of the switcher.
      await societies.leave(fixture.societyId, fixture.neighbourUserId);
      expect(await societies.listMemberships(fixture.neighbourUserId)).toEqual(
        [],
      );
    });

    it("shows an active member the whole roster but drops shadow rows", async () => {
      await insertMember(owner, fixture.societyId, {
        displayName: "Shadow Owner",
        phone: "+919876500102",
      });

      const roster = await societies.listSocietyMemberships(
        fixture.societyId,
        fixture.adminUserId,
      );

      // The creator's own Admin row plus the neighbour — never the shadow member,
      // which the domain cannot represent (a membership needs a `UserId`).
      expect(roster.map((row) => row.userId).sort()).toEqual(
        [
          fixture.adminUserId as string,
          fixture.neighbourUserId as string,
        ].sort(),
      );
      expect(roster.map((row) => row.role).sort()).toEqual([
        "admin",
        "resident",
      ]);
    });

    it("answers not_found for a non-member and for a removed membership, never an empty roster", async () => {
      const outsider = await rejection(
        societies.listSocietyMemberships(
          fixture.societyId,
          fixture.strangerUserId,
        ),
      );
      // `not_found`, not an empty array: an empty list would confirm the society exists.
      expect(outsider.code).toBe("not_found");

      await societies.leave(fixture.societyId, fixture.neighbourUserId);
      const removed = await rejection(
        societies.listSocietyMemberships(
          fixture.societyId,
          fixture.neighbourUserId,
        ),
      );
      expect(removed.code).toBe("not_found");
    });

    it("returns the caller's own membership row in any live status, and null for a stranger", async () => {
      const mine = await societies.findMembership(
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(mine).toMatchObject({ role: "admin", status: "active" });
      expect(mine?.occupancyType).toBe("owner");

      // A pending row is returned, not filtered — the caller has to tell "not a
      // member" from "a member whose role is insufficient".
      const applicantUserId = (await createLocalUser(
        owner,
        "applicant@repo.ses.test",
        "Applicant",
      )) as UserId;
      await insertMember(owner, fixture.societyId, {
        userId: applicantUserId,
        displayName: "Applicant",
        status: "pending",
      });
      const pending = await societies.findMembership(
        fixture.societyId,
        applicantUserId,
      );
      expect(pending?.status).toBe("pending");

      expect(
        await societies.findMembership(
          fixture.societyId,
          fixture.strangerUserId,
        ),
      ).toBeNull();
    });

    it("returns the whole society to a member, and null across tenants", async () => {
      const society = await societies.findById(
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(society).toMatchObject({
        id: fixture.societyId,
        name: "Alpha Court",
        city: "Pune",
        state: "MH",
        country: "IN",
        currency: "INR",
        plan: "free",
        createdBy: fixture.adminUserId,
        deletedAt: null,
      });
      // The settings the create wizard collected survive the round trip.
      expect(society?.settings.billingDay).toBe(1);
      expect(society?.settings.dueDay).toBe(10);
      expect(society?.settings.approvalThresholdPaise).toBe(paise(1_000_000n));
      // Two memberships exist (the creator's Admin and the neighbour); the shadow
      // member inserted below is not counted either.
      expect(society?.memberCount).toBe(2);
      expect(society?.slug.length).toBeGreaterThan(0);
      expect(society?.joinCode).toBe(fixture.joinCode);

      expect(
        await societies.findById(fixture.societyId, fixture.strangerUserId),
      ).toBeNull();
    });

    it("answers the public join preview for a live code, and null for anything else", async () => {
      const preview = await societies.findJoinPreview(fixture.joinCode);
      expect(preview).toMatchObject({
        id: fixture.societyId,
        name: "Alpha Court",
        city: "Pune",
        type: "apartment",
      });
      expect(preview?.memberCount).toBe(2);

      // The code is normalised before the lookup, so a lower-case spelling works.
      expect(
        await societies.findJoinPreview(fixture.joinCode.toLowerCase()),
      ).not.toBeNull();

      expect(await societies.findJoinPreview("ZZZZZZ")).toBeNull();
      // A blank code is answered without a query at all.
      expect(await societies.findJoinPreview("   ")).toBeNull();
    });

    it("lists the code's live flats for the join screen, filtered by search", async () => {
      const options = await societies.joinOptions(
        fixture.joinCode,
        {},
        fixture.strangerUserId,
      );

      expect(options.societyId).toBe(fixture.societyId);
      expect(options.flats.map((flat) => flat.number)).toEqual(["101", "102"]);
      expect(options.flats[0]).toMatchObject({
        buildingName: "A Wing",
        floor: 1,
      });
      expect(options.total).toBe(2);
      expect(options.truncated).toBe(false);

      const narrowed = await societies.joinOptions(
        fixture.joinCode,
        { query: "101" },
        fixture.strangerUserId,
      );
      expect(narrowed.flats.map((flat) => flat.number)).toEqual(["101"]);
      expect(narrowed.total).toBe(1);

      // A soft-deleted flat is no longer offered — the flat a society is retiring
      // must not appear in the join screen's picker.
      await owner`
        update public.apartments set deleted_at = now()
         where id = ${fixture.flat102}::uuid
      `;
      const afterRemoval = await societies.joinOptions(
        fixture.joinCode,
        {},
        fixture.strangerUserId,
      );
      expect(afterRemoval.flats.map((flat) => flat.number)).toEqual(["101"]);
      expect(afterRemoval.total).toBe(1);
    });

    it("refuses an unknown join code, and a blank one before touching the database", async () => {
      const unknown = await rejection(
        societies.joinOptions("ZZZZZZ", {}, fixture.strangerUserId),
      );
      expect(unknown.code).toBe("join_code_invalid");

      const blank = await rejection(
        societies.joinOptions("   ", {}, fixture.strangerUserId),
      );
      expect(blank.code).toBe("join_code_invalid");
    });
  });

  describe("writes", () => {
    it("seeds the settings and the creator's Admin membership in one create", async () => {
      const creatorUserId = (await createLocalUser(
        owner,
        "creator@repo.ses.test",
        "Creator",
      )) as UserId;

      const { society, membership } = await societies.create(
        {
          name: "Beta Heights",
          type: "villa",
          city: "Nashik",
          state: "MH",
          billingDay: 5,
          dueDay: 15,
          approvalThresholdPaise: paise(2_500_000n),
        },
        creatorUserId,
      );

      expect(society.name).toBe("Beta Heights");
      expect(society.type).toBe("villa");
      expect(society.plan).toBe("free");
      expect(society.settings.graceDays).toBeGreaterThan(0);
      expect(society.settings.billVacantFlats).toBe(true);
      expect(society.memberCount).toBe(1);

      expect(membership).toMatchObject({
        societyId: society.id,
        userId: creatorUserId,
        role: "admin",
        status: "active",
      });
      // The row is real: the creator can read the society they just made.
      expect(
        await societies.findById(society.id, creatorUserId),
      ).not.toBeNull();
    });

    it("patches the society and its settings, and clears an optional field", async () => {
      const updated = await societies.update(
        fixture.societyId,
        {
          name: "Alpha Court Renamed",
          registrationNumber: "MH/PNQ/1234",
          graceDays: 7,
        },
        fixture.adminUserId,
      );

      expect(updated.name).toBe("Alpha Court Renamed");
      expect(updated.registrationNumber).toBe("MH/PNQ/1234");
      expect(updated.settings.graceDays).toBe(7);

      // A present-but-`undefined` key is how the domain says "clear this one":
      // the patch keeps the key and the payload writes an explicit `null`.
      const cleared = await societies.update(
        fixture.societyId,
        { registrationNumber: undefined },
        fixture.adminUserId,
      );
      expect(cleared.registrationNumber).toBeNull();
      // The untouched fields stay.
      expect(updated.settings.billingDay).toBe(1);

      // Persisted, not just echoed.
      const reread = await societies.findById(
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(reread?.name).toBe("Alpha Court Renamed");
    });

    it("mints a different join code on rotation, and the old one stops resolving", async () => {
      const rotated = await societies.regenerateJoinCode(
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(rotated.joinCode).not.toBe(fixture.joinCode);
      expect(rotated.joinCode.length).toBeGreaterThan(0);
      expect(await societies.findJoinPreview(fixture.joinCode)).toBeNull();
      expect(await societies.findJoinPreview(rotated.joinCode)).not.toBeNull();
    });

    it("soft-deletes: the society leaves every read and its code stops resolving", async () => {
      await societies.remove(fixture.societyId, fixture.adminUserId);

      expect(
        await societies.findById(fixture.societyId, fixture.adminUserId),
      ).toBeNull();
      expect(await societies.findJoinPreview(fixture.joinCode)).toBeNull();
      // Every membership is marked removed, so the switcher drops the society too.
      expect(await societies.listMemberships(fixture.adminUserId)).toEqual([]);
    });
  });

  describe("join and leave", () => {
    it("records a pending request carrying the flat and the note", async () => {
      const joined = await societies.join(
        {
          code: fixture.joinCode,
          occupancyType: "tenant",
          apartmentId: fixture.flat101,
          note: "First floor, moving in next month.",
        },
        fixture.strangerUserId,
      );

      expect(joined).toMatchObject({
        societyId: fixture.societyId,
        userId: fixture.strangerUserId,
        role: "resident",
        status: "pending",
        occupancyType: "tenant",
      });

      // The flat and note landed on the row the Admin will review.
      const [row] = await owner<
        { apartment_id: string; request_note: string }[]
      >`
        select apartment_id, request_note from public.members
         where id = ${joined.id}::uuid
      `;
      expect(row?.apartment_id).toBe(fixture.flat101);
      expect(row?.request_note).toBe("First floor, moving in next month.");
    });

    it("refuses a second request, and an existing member, as already_member", async () => {
      await societies.join(
        {
          code: fixture.joinCode,
          occupancyType: "owner",
          apartmentId: null,
          note: null,
        },
        fixture.strangerUserId,
      );

      const again = await rejection(
        societies.join(
          {
            code: fixture.joinCode,
            occupancyType: "owner",
            apartmentId: null,
            note: null,
          },
          fixture.strangerUserId,
        ),
      );
      expect(again.code).toBe("already_member");

      const member = await rejection(
        societies.join(
          {
            code: fixture.joinCode,
            occupancyType: "owner",
            apartmentId: null,
            note: null,
          },
          fixture.neighbourUserId,
        ),
      );
      expect(member.code).toBe("already_member");
    });

    it("re-asks for a rejected request and for a removed membership", async () => {
      // A rejected applicant asking again moves the same row back to pending.
      const rejectedUserId = (await createLocalUser(
        owner,
        "rejected@repo.ses.test",
        "Rejected",
      )) as UserId;
      const rejectedMemberId = await insertMember(owner, fixture.societyId, {
        userId: rejectedUserId,
        displayName: "Rejected",
        status: "rejected",
        rejectionReason: "That flat was already claimed.",
      });
      const reasked = await societies.join(
        {
          code: fixture.joinCode,
          occupancyType: "owner",
          apartmentId: fixture.flat101,
          note: "Corrected my flat.",
        },
        rejectedUserId,
      );
      expect(reasked.id).toBe(rejectedMemberId);
      expect(reasked.status).toBe("pending");

      // So does a member who left (removed): the same row, not a second one.
      await societies.leave(fixture.societyId, fixture.neighbourUserId);
      const rejoined = await societies.join(
        {
          code: fixture.joinCode,
          occupancyType: "tenant",
          apartmentId: fixture.flat102,
          note: null,
        },
        fixture.neighbourUserId,
      );
      expect(rejoined.id).toBe(fixture.neighbourMemberId);
      expect(rejoined.status).toBe("pending");

      const [remaining] = await owner<{ count: string }[]>`
        select count(*)::text as count from public.members
      `;
      // Admin + the two re-asked rows: no duplicate membership was created.
      expect(Number(remaining?.count)).toBe(3);
    });

    it("refuses a flat that is not a live flat of the society", async () => {
      const otherSociety = await seedSociety(
        harness,
        "Other Court",
        "other-admin@repo.ses.test",
      );
      const otherBuilding = await insertBuilding(
        owner,
        otherSociety.societyId,
        "B Wing",
      );
      const foreignFlat = await insertApartment(
        owner,
        otherSociety.societyId,
        otherBuilding,
        "201",
        1,
      );

      const refused = await rejection(
        societies.join(
          {
            code: fixture.joinCode,
            occupancyType: "owner",
            apartmentId: foreignFlat,
            note: null,
          },
          fixture.strangerUserId,
        ),
      );
      expect(refused.code).toBe("validation");
      expect(refused.details).toMatchObject({ field: "apartmentId" });
    });

    it("refuses a join when a shadow occupant already holds the caller's number", async () => {
      const shadowUserId = (await createLocalUser(
        owner,
        "shadow@repo.ses.test",
        "Shadow Person",
      )) as UserId;
      await owner`
        update public.profiles set phone = ${"+919876500777"}
         where id = ${shadowUserId}::uuid
      `;
      await insertMember(owner, fixture.societyId, {
        displayName: "Recorded Occupant",
        phone: "+919876500777",
      });

      const refused = await rejection(
        societies.join(
          {
            code: fixture.joinCode,
            occupancyType: "owner",
            apartmentId: null,
            note: null,
          },
          shadowUserId,
        ),
      );
      expect(refused.code).toBe("already_member");
      expect(refused.details).toMatchObject({ field: "phone" });
    });

    it("lets a member leave, refuses a second leave, and keeps the last admin", async () => {
      await societies.leave(fixture.societyId, fixture.neighbourUserId);
      expect(
        await societies.findMembership(
          fixture.societyId,
          fixture.neighbourUserId,
        ),
      ).toMatchObject({ status: "removed" });

      const twice = await rejection(
        societies.leave(fixture.societyId, fixture.neighbourUserId),
      );
      expect(twice.code).toBe("not_found");

      // The society can never be left without an active admin.
      const soleAdmin = await rejection(
        societies.leave(fixture.societyId, fixture.adminUserId),
      );
      expect(soleAdmin.code).toBe("sole_admin");
    });
  });
});
