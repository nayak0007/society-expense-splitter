import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseParticipantResolution,
  MemberId,
  OccupancyStatus,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { ParticipantResolverService } from "../../src/modules/expenses/application/participant-resolver.service";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
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
 * `ParticipantResolverService` against real PostgreSQL and real RLS — Roadmap T063.
 *
 * ## What only this suite can prove
 *
 * The domain suite owns the *rules* and the application suite owns the *composition*;
 * both run against values a test wrote down. Four claims need a real database, and they
 * are the whole reason this file exists:
 *
 *  1. **The reader's four statements are scoped to one society and to live rows.** The
 *     apartment, member, wing and building projections are asserted against rows written
 *     as the owner (RLS-exempt) on two societies: a member of Alpha resolves Alpha, a
 *     member of Omega resolves Omega, and neither list contains the other's flats. The
 *     row filters are asserted by *absence* — a soft-deleted flat, a removed member and
 *     a non-billable flat are all missing from a resolution that would otherwise reach
 *     them.
 *  2. **A shadow owner is a participant.** `members.user_id IS NULL` is Phase 3's
 *     "owner without an account" (PRD §3.2), and the PRD's routing sentence bills the
 *     flat's *owner membership*. Nothing in resolution asks for a user id, and this file
 *     is where that is checked against the column rather than against a fixture typed to
 *     promise it.
 *  3. **The vacancy switch is the society's row, not the request's.** `bill_vacant_flats`
 *     starts `true` (the column's default, through `society_snapshot()`), and flipping it
 *     as the owner changes what resolution bills — while a selector's `includeVacant`
 *     can only go the other way.
 *  4. **The PRD's owner-only routing is real end to end**: the seeded `Sinking Fund` row
 *     (`is_owner_only = true`, T062's trigger) makes a rented flat's charge land on the
 *     owner, with `assigned_reason = 'owner_only_category'` and the tenant recorded as
 *     the member it moved from — and a flat with no owner membership comes back as a
 *     flagged `unassigned` entry rather than disappearing.
 *
 * ## Why the fixtures are inserted *scrambled*
 *
 * Apartments are inserted out of order on purpose. Resolution's order is the domain's
 * (floor, then apartment number byte-wise, then id) and must not depend on the
 * database's row order; a fixture inserted in sorted order would pass against a reader
 * that simply returned whatever the heap gave it.
 *
 * Fixtures are written on the **owner** connection; every assertion runs through the
 * service, which goes through `UnitOfWork` as a real identity.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let resolver: ParticipantResolverService;
let categories: ExpenseCategoryRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  resolver = harness.app.get(ParticipantResolverService);
  categories = harness.app.get<ExpenseCategoryRepository>(
    EXPENSE_CATEGORY_REPOSITORY,
  );
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

interface FlatSpec {
  readonly buildingId: BuildingId;
  readonly wingId?: string | null;
  readonly number: string;
  readonly floor?: number | null;
  readonly occupancy?: OccupancyStatus;
  readonly bhk?: string | null;
  readonly carpetAreaSqft?: string | null;
  readonly builtupAreaSqft?: string | null;
  readonly parkingSlots?: number;
  readonly shareUnits?: string;
  readonly isBillable?: boolean;
}

/** One flat of one society, inserted as the owner. */
async function insertFlat(
  societyId: SocietyId,
  spec: FlatSpec,
): Promise<ApartmentId> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.apartments (
      society_id, building_id, wing_id, apartment_number, floor, bhk,
      carpet_area_sqft, builtup_area_sqft, parking_slots, share_units,
      occupancy_status, is_billable
    )
    values (
      ${societyId}::uuid,
      ${spec.buildingId}::uuid,
      ${spec.wingId ?? null}::uuid,
      ${spec.number},
      ${spec.floor ?? null}::smallint,
      ${spec.bhk ?? null}::numeric(3, 1),
      ${spec.carpetAreaSqft ?? null}::numeric(8, 2),
      ${spec.builtupAreaSqft ?? null}::numeric(8, 2),
      ${spec.parkingSlots ?? 0}::smallint,
      ${spec.shareUnits ?? "1"}::numeric(8, 3),
      ${spec.occupancy ?? "owner_occupied"}::public.occupancy_status,
      ${spec.isBillable ?? true}::boolean
    )
    returning id
  `;
  return row!.id as ApartmentId;
}

/** One wing of one building, inserted as the owner. */
async function insertWing(
  societyId: SocietyId,
  buildingId: BuildingId,
  name: string,
): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.wings (society_id, building_id, name)
    values (${societyId}::uuid, ${buildingId}::uuid, ${name})
    returning id
  `;
  return row!.id;
}

interface Fixture extends SocietyFixture {
  readonly north: BuildingId;
  readonly south: BuildingId;
  readonly wingA: string;
  readonly flats: {
    readonly N101: ApartmentId;
    readonly N102: ApartmentId;
    readonly N103: ApartmentId;
    readonly N104: ApartmentId;
    readonly N105: ApartmentId;
    readonly N106: ApartmentId;
    readonly S201: ApartmentId;
    readonly S202: ApartmentId;
    readonly S203: ApartmentId;
    readonly S204: ApartmentId;
  };
  readonly members: {
    /** N101's owner: a shadow member, `user_id IS NULL`. */
    readonly shadowOwner: MemberId;
    /** N102's owner — lives elsewhere; the tenant below is the occupant. */
    readonly ownerOfRented: MemberId;
    readonly tenantOfRented: MemberId;
    readonly ownerNotBillable: MemberId;
    readonly ownerUnderConstruction: MemberId;
    /** The rented flat with no owner membership at all. */
    readonly tenantWithoutOwner: MemberId;
    readonly ownerSouth: MemberId;
    readonly familySouth: MemberId;
    /** An owner whose membership was removed — must never be billed. */
    readonly removedOwner: MemberId;
    readonly ownerUnrecorded: MemberId;
    readonly familyOnly: MemberId;
    /** A resident of the other society, for the tenancy assertions. */
    readonly outsiderUserId: UserId;
    readonly otherSociety: SocietyFixture;
    readonly otherBuildingId: BuildingId;
    readonly otherFlatNumber: string;
  };
  readonly ownerOnlyCategoryId: ExpenseCategoryId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Alpha Court",
    "admin@alpha.ses.test",
  );
  const societyId = society.societyId;

  const north = await insertBuilding(owner, societyId, "North Block");
  const south = await insertBuilding(owner, societyId, "South Block");
  const wingA = await insertWing(societyId, north, "A");

  // Deliberately out of order — see the file header.
  const S202 = await insertFlat(societyId, {
    buildingId: south,
    number: "S202",
    floor: null,
    bhk: null,
    carpetAreaSqft: null,
    builtupAreaSqft: null,
  });
  const N105 = await insertFlat(societyId, {
    buildingId: north,
    number: "N105",
    floor: 3,
    occupancy: "under_construction",
    parkingSlots: 2,
    shareUnits: "2.5",
  });
  const N101 = await insertFlat(societyId, {
    buildingId: north,
    wingId: wingA,
    number: "N101",
    floor: 1,
    bhk: "2.0",
    carpetAreaSqft: "700.00",
    builtupAreaSqft: "875.00",
    parkingSlots: 1,
  });
  const S203 = await insertFlat(societyId, {
    buildingId: south,
    number: "S203",
    floor: 2,
  });
  const N102 = await insertFlat(societyId, {
    buildingId: north,
    wingId: wingA,
    number: "N102",
    floor: 1,
    occupancy: "rented",
    carpetAreaSqft: "800.00",
  });
  const S201 = await insertFlat(societyId, {
    buildingId: south,
    number: "S201",
    floor: 2,
  });
  const S204 = await insertFlat(societyId, {
    buildingId: south,
    number: "S204",
    floor: 2,
  });
  const N106 = await insertFlat(societyId, {
    buildingId: north,
    number: "N106",
    floor: 3,
    occupancy: "rented",
  });
  const N104 = await insertFlat(societyId, {
    buildingId: north,
    number: "N104",
    floor: 2,
    isBillable: false,
  });
  const N103 = await insertFlat(societyId, {
    buildingId: north,
    number: "N103",
    floor: 2,
    occupancy: "vacant",
  });

  const shadowOwner = (await insertMember(owner, societyId, {
    apartmentId: N101,
    occupancy: "owner_occupied",
    isPrimary: true,
    displayName: "Owner Without Account",
  })) as MemberId;
  const ownerOfRented = (await insertMember(owner, societyId, {
    userId: (await createLocalUser(
      owner,
      "owner-rented@alpha.ses.test",
      "Owner",
    )) as UserId,
    apartmentId: N102,
    occupancy: "vacant_owner",
    isPrimary: false,
    displayName: "Rent-out Owner",
  })) as MemberId;
  const tenantOfRented = (await insertMember(owner, societyId, {
    userId: (await createLocalUser(
      owner,
      "tenant@alpha.ses.test",
      "Tenant",
    )) as UserId,
    apartmentId: N102,
    occupancy: "tenant",
    isPrimary: true,
    displayName: "Tenant",
  })) as MemberId;
  const ownerNotBillable = (await insertMember(owner, societyId, {
    apartmentId: N104,
    occupancy: "owner_occupied",
    isPrimary: true,
  })) as MemberId;
  const ownerUnderConstruction = (await insertMember(owner, societyId, {
    apartmentId: N105,
    occupancy: "vacant_owner",
    isPrimary: true,
  })) as MemberId;
  const tenantWithoutOwner = (await insertMember(owner, societyId, {
    apartmentId: N106,
    occupancy: "tenant",
    isPrimary: true,
  })) as MemberId;
  const ownerSouth = (await insertMember(owner, societyId, {
    apartmentId: S201,
    occupancy: "owner_occupied",
    isPrimary: true,
  })) as MemberId;
  const familySouth = (await insertMember(owner, societyId, {
    apartmentId: S201,
    occupancy: "family_member",
    isPrimary: false,
  })) as MemberId;
  const removedOwner = (await insertMember(owner, societyId, {
    apartmentId: S204,
    occupancy: "owner_occupied",
    isPrimary: true,
    status: "removed",
  })) as MemberId;
  const ownerUnrecorded = (await insertMember(owner, societyId, {
    apartmentId: S202,
    occupancy: "owner_occupied",
    isPrimary: true,
  })) as MemberId;
  const familyOnly = (await insertMember(owner, societyId, {
    apartmentId: S203,
    occupancy: "family_member",
    isPrimary: false,
  })) as MemberId;

  const otherSociety = await seedSociety(
    harness,
    "Omega Court",
    "admin@omega.ses.test",
  );
  const otherBuildingId = await insertBuilding(
    owner,
    otherSociety.societyId,
    "Omega Block",
  );
  const otherFlatNumber = "N101";
  await insertFlat(otherSociety.societyId, {
    buildingId: otherBuildingId,
    number: otherFlatNumber,
    floor: 1,
  });

  const outsiderUserId = (await createLocalUser(
    owner,
    "outsider@alpha.ses.test",
    "Outsider",
  )) as UserId;

  const listed = await categories.listCategories(
    societyId,
    society.adminUserId,
  );
  const sinkingFund = listed.find(
    (category) => category.name === "Sinking Fund",
  );
  if (sinkingFund === undefined) {
    throw new Error("The seeded Sinking Fund category is missing.");
  }

  return {
    ...society,
    north,
    south,
    wingA,
    flats: { N101, N102, N103, N104, N105, N106, S201, S202, S203, S204 },
    members: {
      shadowOwner,
      ownerOfRented,
      tenantOfRented,
      ownerNotBillable,
      ownerUnderConstruction,
      tenantWithoutOwner,
      ownerSouth,
      familySouth,
      removedOwner,
      ownerUnrecorded,
      familyOnly,
      outsiderUserId,
      otherSociety,
      otherBuildingId,
      otherFlatNumber,
    },
    ownerOnlyCategoryId: sinkingFund.id,
  };
}

function numbers(resolution: ExpenseParticipantResolution): string[] {
  return resolution.participants.map((entry) => entry.apartmentNumber);
}

function unassignedNumbers(resolution: ExpenseParticipantResolution): string[] {
  return resolution.unassigned.map((entry) => entry.apartmentNumber);
}

/** Resolves as the fixture's own Admin — the caller every test shares. */
function resolveFor(
  fixture: Fixture,
  selector: unknown,
  options: { readonly categoryId?: ExpenseCategoryId } = {},
): Promise<ExpenseParticipantResolution> {
  return resolver.resolve(fixture.adminUserId, fixture.societyId, {
    selector,
    categoryId: options.categoryId ?? null,
  });
}

async function rejection(promise: Promise<unknown>): Promise<{
  readonly code?: unknown;
  readonly message?: unknown;
}> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { readonly code?: unknown; readonly message?: unknown };
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

describe("ParticipantResolverService", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("society-wide resolution", () => {
    it("gives one participant per flat, in flat order, and flags the rest", async () => {
      const resolution = await resolveFor(fixture, {});

      // Floor 1: N101 (its shadow owner), N102 (the tenant — it is `rented`). Floor 2:
      // S201 — N103 is vacant and S203/S204 cannot be addressed. Floor 3: N105
      // (under construction is *not* vacancy-exempt) and N106. S202 has no recorded
      // floor, so it sorts last.
      expect(numbers(resolution)).toEqual([
        "N101",
        "N102",
        "S201",
        "N105",
        "N106",
        "S202",
      ]);
      expect(unassignedNumbers(resolution)).toEqual(["N103", "S203", "S204"]);

      // One participant per flat, whichever member was chosen: N102 holds two live
      // memberships and produced one row, which is the "one flat billed twice" case
      // the PRD's routing sentence exists to prevent.
      expect(resolution.participants[0]?.memberId).toBe(
        fixture.members.shadowOwner,
      );
      expect(resolution.participants[1]?.memberId).toBe(
        fixture.members.tenantOfRented,
      );
      // The removed owner of S204 and the family-only S203 are unassignable — never
      // billed to a tombstoned membership or to a family member (PRD §3.3).
      expect(
        resolution.participants.some(
          (entry) =>
            entry.memberId === fixture.members.removedOwner ||
            entry.memberId === fixture.members.familySouth ||
            entry.memberId === fixture.members.familyOnly,
        ),
      ).toBe(false);
      expect(resolution.unassigned.map((entry) => entry.reason)).toEqual([
        "unassigned_no_member",
        "unassigned_no_member",
        "unassigned_no_member",
      ]);
      // N104 is `is_billable = false` and appears nowhere — not as a participant and
      // not as an unassigned entry.
      expect([
        ...numbers(resolution),
        ...unassignedNumbers(resolution),
      ]).not.toContain("N104");
    });

    it("carries the flat facts the six bases read, nulls included", async () => {
      const resolution = await resolveFor(fixture, {});

      const n101 = resolution.participants.find(
        (entry) => entry.apartmentNumber === "N101",
      );
      expect(n101).toMatchObject({
        floor: 1,
        bhk: 2,
        carpetAreaSqft: 700,
        builtupAreaSqft: 875,
        parkingSlots: 1,
        shareUnits: 1,
        // No category was named, so nothing moved and nothing is explained.
        assignedReason: null,
        routedFromMemberId: null,
      });

      // `numeric` and `smallint` round-trip exactly; a `share_units` of 2.5 is a real
      // stored value and arrives as one.
      const n105 = resolution.participants.find(
        (entry) => entry.apartmentNumber === "N105",
      );
      expect(n105).toMatchObject({
        floor: 3,
        parkingSlots: 2,
        shareUnits: 2.5,
      });

      // An unrecorded floor, area or BHK is `null` — the engine's own "missing
      // attribute" case — never `0`, which the database's checks would have refused.
      const s202 = resolution.participants.find(
        (entry) => entry.apartmentNumber === "S202",
      );
      expect(s202).toMatchObject({
        floor: null,
        bhk: null,
        carpetAreaSqft: null,
        builtupAreaSqft: null,
      });
    });

    it("gives a shadow owner a participant — no auth user required", async () => {
      const resolution = await resolveFor(fixture, {});

      const [shadow] = await owner<{ user_id: string | null }[]>`
        select user_id from public.members where id = ${fixture.members.shadowOwner}::uuid
      `;
      // The precondition, asserted rather than assumed: this owner has no account.
      expect(shadow?.user_id).toBeNull();

      expect(resolution.participants[0]).toMatchObject({
        memberId: fixture.members.shadowOwner,
        apartmentNumber: "N101",
      });
    });

    it("reads only the requested society — and gives a stranger its 404", async () => {
      const resolution = await resolveFor(fixture, {});
      // Omega Court holds a flat with the *same number*: if the reader leaked, this
      // list would carry it twice.
      expect(
        numbers(resolution).filter((number) => number === "N101"),
      ).toHaveLength(1);

      const omegaAdmin = fixture.members.otherSociety.adminUserId;
      const across = await rejection(
        resolver.resolve(omegaAdmin, fixture.societyId, { selector: {} }),
      );
      // Same answer a non-existent society gets, and an AppError rather than a domain
      // error: the service unwraps the use case's `Result`.
      expect(across.code).toBe("NOT_FOUND");

      const asOutsider = await rejection(
        resolver.resolve(fixture.members.outsiderUserId, fixture.societyId, {
          selector: {},
        }),
      );
      expect(asOutsider.code).toBe("NOT_FOUND");
    });
  });

  describe("the selector's dimensions", () => {
    it("filters by building, wing label, floor, occupancy and exclusion", async () => {
      const byBuilding = await resolveFor(fixture, {
        buildings: [fixture.south],
      });
      expect(numbers(byBuilding)).toEqual(["S201", "S202"]);
      expect(unassignedNumbers(byBuilding)).toEqual(["S203", "S204"]);

      // `wings: ["A"]` is a *label*; the reader maps it to a wing id against this
      // society's own wings — the one lookup the selector's vocabulary requires.
      const byWing = await resolveFor(fixture, { wings: ["A"] });
      expect(numbers(byWing)).toEqual(["N101", "N102"]);
      expect(unassignedNumbers(byWing)).toEqual([]);

      const byFloor = await resolveFor(fixture, { floors: [3] });
      expect(numbers(byFloor)).toEqual(["N105", "N106"]);

      // `occupancy` filters the *flat's* status: `rented` exists only in that enum,
      // and `family_member` — the membership's vocabulary — would match nothing.
      const rented = await resolveFor(fixture, { occupancy: ["rented"] });
      expect(numbers(rented)).toEqual(["N102", "N106"]);

      const underConstruction = await resolveFor(fixture, {
        occupancy: ["under_construction"],
      });
      expect(numbers(underConstruction)).toEqual(["N105"]);

      const excluded = await resolveFor(fixture, {
        excludeApartments: [fixture.flats.N102, fixture.flats.S203],
      });
      expect(numbers(excluded)).toEqual([
        "N101",
        "S201",
        "N105",
        "N106",
        "S202",
      ]);
      expect(unassignedNumbers(excluded)).toEqual(["N103", "S204"]);

      const combined = await resolveFor(fixture, {
        scope: "building",
        buildings: [fixture.north],
        floors: [1, 3],
        occupancy: ["owner_occupied", "under_construction"],
      });
      // N106 is rented and dropped; N101 and N105 remain; S-flats are out of scope.
      expect(numbers(combined)).toEqual(["N101", "N105"]);
    });

    it("omits a soft-deleted flat", async () => {
      await owner`
        update public.apartments set deleted_at = now()
         where id = ${fixture.flats.N103}::uuid
      `;

      const resolution = await resolveFor(fixture, {});

      expect(unassignedNumbers(resolution)).toEqual(["S203", "S204"]);
    });

    it("refuses a selector naming resources this society does not have", async () => {
      // Even though it is a well-formed uuid, a building this society does not own is
      // the same answer as one that does not exist — the no-existence-leak rule.
      for (const buildings of [
        ["00000000-0000-4000-8000-000000000000"],
        [fixture.members.otherBuildingId],
      ]) {
        const error = await rejection(
          resolveFor(fixture, { buildings: buildings as never }),
        );
        expect(error.code).toBe("NOT_FOUND");
      }

      const unknownWing = await rejection(
        resolveFor(fixture, { wings: ["Z"] }),
      );
      expect(unknownWing.code).toBe("NOT_FOUND");

      // Another society's flat is not excludable here, because it was never part of
      // this resolution — silently ignoring it would let a selector claim to exclude
      // something it never addressed.
      const other = await owner<{ id: string }[]>`
        select id from public.apartments
         where society_id = ${fixture.members.otherSociety.societyId}::uuid
      `;
      const unknownExclusion = await rejection(
        resolveFor(fixture, {
          excludeApartments: [other[0]!.id] as never,
        }),
      );
      expect(unknownExclusion.code).toBe("NOT_FOUND");
    });

    it("refuses a malformed selector before reading anything", async () => {
      const error = await rejection(
        resolveFor(fixture, { scope: "constellation" }),
      );

      // The wire's validation error, produced by the service's `Result` unwrap.
      expect(error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("vacancy, from the society's own row", () => {
    it("bills a vacant flat by default and stops when the setting is off", async () => {
      const before = await resolveFor(fixture, {});
      expect(unassignedNumbers(before)).toContain("N103");
      // A flat under construction is not a vacant flat: the PRD's switch is named for
      // vacancy, and its enum lists the two separately.
      expect(numbers(before)).toContain("N105");

      await owner`
        update public.society_settings set bill_vacant_flats = false
         where society_id = ${fixture.societyId}::uuid
      `;

      const after = await resolveFor(fixture, {});
      expect(unassignedNumbers(after)).not.toContain("N103");
      // Only the vacant flat went: the setting is not a general "skip empty flats".
      expect(unassignedNumbers(after)).toEqual(["S203", "S204"]);
    });

    it("lets a selector opt out, but never opt in past the setting", async () => {
      const optedOut = await resolveFor(fixture, { includeVacant: false });
      expect(unassignedNumbers(optedOut)).not.toContain("N103");

      await owner`
        update public.society_settings set bill_vacant_flats = false
         where society_id = ${fixture.societyId}::uuid
      `;

      // The setting is the floor: a society that does not bill vacant flats does not
      // bill them because a selector asked nicely.
      const optedIn = await resolveFor(fixture, { includeVacant: true });
      expect(unassignedNumbers(optedIn)).not.toContain("N103");
    });
  });

  describe("owner-only routing", () => {
    it("routes a tenant's share to the owner and records why, for the category", async () => {
      const resolution = await resolveFor(
        fixture,
        {},
        { categoryId: fixture.ownerOnlyCategoryId },
      );

      const n102 = resolution.participants.find(
        (entry) => entry.apartmentNumber === "N102",
      );
      expect(n102).toMatchObject({
        memberId: fixture.members.ownerOfRented,
        assignedReason: "owner_only_category",
        routedFromMemberId: fixture.members.tenantOfRented,
      });

      // An owner-occupied flat never had a tenant to move the charge from, so its row
      // carries no reason even under an owner-only category.
      const n101 = resolution.participants.find(
        (entry) => entry.apartmentNumber === "N101",
      );
      expect(n101).toMatchObject({
        memberId: fixture.members.shadowOwner,
        assignedReason: null,
        routedFromMemberId: null,
      });

      // The PRD's unassignable case: N106 is rented and has no owner membership, so
      // the due attaches to the flat and is flagged instead of dropped.
      expect(unassignedNumbers(resolution)).toEqual([
        "N103",
        "S203",
        "S204",
        "N106",
      ]);
      expect(
        resolution.unassigned.find((entry) => entry.apartmentNumber === "N106")
          ?.reason,
      ).toBe("unassigned_no_owner");
      // And a flat nobody can own (S203's only membership is a family member) is
      // flagged for the same reason.
      expect(
        resolution.unassigned.find((entry) => entry.apartmentNumber === "S203")
          ?.reason,
      ).toBe("unassigned_no_owner");
    });

    it("routes for a selector-level ownerOnly without claiming the category's reason", async () => {
      const resolution = await resolveFor(fixture, { ownerOnly: true });

      const n102 = resolution.participants.find(
        (entry) => entry.apartmentNumber === "N102",
      );
      // The same owner, and the move is still recorded — but no `assigned_reason`,
      // because no category rule moved it.
      expect(n102).toMatchObject({
        memberId: fixture.members.ownerOfRented,
        assignedReason: null,
        routedFromMemberId: fixture.members.tenantOfRented,
      });
      expect(numbers(resolution)).toEqual([
        "N101",
        "N102",
        "S201",
        "N105",
        "S202",
      ]);
      expect(unassignedNumbers(resolution)).toEqual([
        "N103",
        "S203",
        "S204",
        "N106",
      ]);
    });

    it("applies the category's flag to every flat, not only to the rented ones", async () => {
      // The seeded Sinking Fund is the trigger's own row — `is_owner_only = true` set
      // by T062's migration, not by this test.
      const [seeded] = await owner<{ is_owner_only: boolean }[]>`
        select is_owner_only from public.expense_categories
         where id = ${fixture.ownerOnlyCategoryId}::uuid
      `;
      expect(seeded?.is_owner_only).toBe(true);

      const resolution = await resolveFor(
        fixture,
        {},
        { categoryId: fixture.ownerOnlyCategoryId },
      );

      // Every participant is an owner membership, and the one rented flat is the only
      // row that carries the reason.
      expect(
        resolution.participants.map((entry) => [
          entry.apartmentNumber,
          entry.assignedReason,
        ]),
      ).toEqual([
        ["N101", null],
        ["N102", "owner_only_category"],
        ["S201", null],
        ["N105", null],
        ["S202", null],
      ]);
      // N106's tenant is left out entirely: owner-only does not bill the occupant.
      expect(
        resolution.participants.some(
          (entry) => entry.memberId === fixture.members.tenantWithoutOwner,
        ),
      ).toBe(false);
    });
  });

  describe("what resolution produces is what publishing stores", () => {
    it("writes the flagged entry as the flat-only split row the schema already allows", async () => {
      const resolution = await resolveFor(fixture, {});
      const flagged = resolution.unassigned.find(
        (entry) => entry.apartmentNumber === "N103",
      );
      expect(flagged).toBeDefined();

      const [expense] = await owner<{ id: string }[]>`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, created_by
        )
        values (
          ${fixture.societyId}::uuid, ${fixture.ownerOnlyCategoryId}::uuid,
          'Sinking fund call', 10000::bigint, current_date, 'equal', 'draft',
          ${fixture.adminMemberId}::uuid
        )
        returning id
      `;

      // `chk_expense_splits_participant` is `member_id IS NOT NULL OR apartment_id IS
      // NOT NULL`, and its comment names this case — so the flagged entry is a row the
      // publish path can write today, with no schema change.
      const [split] = await owner<{ assigned_reason: string | null }[]>`
        insert into public.expense_splits (
          society_id, expense_id, member_id, apartment_id, amount_paise,
          assigned_reason
        )
        values (
          ${fixture.societyId}::uuid, ${expense!.id}::uuid, null,
          ${flagged!.apartmentId}::uuid, 0::bigint, ${flagged!.reason}::varchar
        )
        returning assigned_reason
      `;
      expect(split?.assigned_reason).toBe("unassigned_no_member");
    });
  });
});
