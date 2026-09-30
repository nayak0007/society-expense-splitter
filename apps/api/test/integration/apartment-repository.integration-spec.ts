import type {
  ApartmentRepository,
  BuildingId,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { APARTMENT_REPOSITORY } from "../../src/modules/structure/application/structure.tokens";

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
 * `ApartmentRepositoryPostgres` against real PostgreSQL and real RLS — the flat
 * every membership, bill and reading will hang off.
 *
 * Three things this adapter decides that a fake cannot show: the two assembled
 * statements (`create`/`update` build their column list from the fields actually
 * sent, so an absent field takes the *column* default and `null` clears), the
 * savepoint-per-row batch that absorbs a duplicate label without losing the rest
 * of the batch, and the error classifier that turns a real unique violation into
 * the module's `conflict`. All three are asserted here through the repository.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let apartments: ApartmentRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  apartments = harness.app.get<ApartmentRepository>(APARTMENT_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

interface Fixture extends SocietyFixture {
  readonly buildingId: BuildingId;
  readonly flat101: string;
  /** An active ordinary member — a non-admin for the policy tests. */
  readonly residentUserId: UserId;
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

  const residentUserId = (await createLocalUser(
    owner,
    "resident@apartment.ses.test",
    "Resident",
  )) as UserId;
  await insertMember(owner, society.societyId, {
    userId: residentUserId,
    displayName: "Resident",
    phone: "+919876500201",
    role: "resident",
    apartmentId: flat101 as never,
  });

  return { ...society, buildingId, flat101, residentUserId };
}

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

async function apartmentCount(societyId: SocietyId): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count from public.apartments
     where society_id = ${societyId}::uuid
  `;
  return Number(row?.count ?? "0");
}

describe("ApartmentRepositoryPostgres", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("reads", () => {
    it("lists live flats by floor then number, dropping the soft-deleted", async () => {
      const created = await apartments.createMany(
        fixture.buildingId,
        fixture.societyId,
        [
          { apartmentNumber: "102", floor: 2 },
          { apartmentNumber: "G-2", floor: 0 },
          { apartmentNumber: "X", floor: null },
          { apartmentNumber: "103", floor: 2 },
        ],
        fixture.adminUserId,
      );
      expect(created.duplicateLabelsSkipped).toEqual([]);

      const rows = await apartments.listApartments(
        fixture.buildingId,
        fixture.societyId,
        fixture.adminUserId,
      );
      // Floor 0, 1 (the fixture's 101), 2 (in code-unit number order), then the
      // unrecorded floor last.
      expect(rows.map((row) => row.apartmentNumber)).toEqual([
        "G-2",
        "101",
        "102",
        "103",
        "X",
      ]);

      await apartments.remove(
        created.created[0]!.id,
        fixture.societyId,
        fixture.adminUserId,
      );
      const afterRemoval = await apartments.listApartments(
        fixture.buildingId,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(afterRemoval.map((row) => row.apartmentNumber)).toEqual([
        "G-2",
        "101",
        "103",
        "X",
      ]);
    });

    it("returns one flat to a member and null across tenants or after removal", async () => {
      const flat = await apartments.findApartment(
        fixture.flat101 as never,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(flat).toMatchObject({
        apartmentNumber: "101",
        floor: 1,
        buildingId: fixture.buildingId,
        occupancyStatus: "vacant",
        isBillable: true,
        isCommercial: false,
        parkingSlots: 0,
        shareUnits: 1,
        deletedAt: null,
      });

      // Another society's id, even with the right flat id, is `null`.
      const otherSocetiy = await seedSociety(
        harness,
        "Other Court",
        "other@apartment.ses.test",
      );
      expect(
        await apartments.findApartment(
          fixture.flat101 as never,
          otherSocetiy.societyId,
          otherSocetiy.adminUserId,
        ),
      ).toBeNull();

      await apartments.remove(
        fixture.flat101 as never,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(
        await apartments.findApartment(
          fixture.flat101 as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBeNull();
    });

    it("counts only the building's live flats, scoped to the caller's society", async () => {
      expect(
        await apartments.countForBuilding(
          fixture.buildingId,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBe(1);

      const created = await apartments.create(
        fixture.buildingId,
        fixture.societyId,
        { apartmentNumber: "102" },
        fixture.adminUserId,
      );
      expect(
        await apartments.countForBuilding(
          fixture.buildingId,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBe(2);

      await apartments.remove(
        created.id,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(
        await apartments.countForBuilding(
          fixture.buildingId,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBe(1);
    });
  });

  describe("writes", () => {
    it("fills the column defaults for an absent field and maps every sent field", async () => {
      const bare = await apartments.create(
        fixture.buildingId,
        fixture.societyId,
        { apartmentNumber: "201" },
        fixture.adminUserId,
      );
      // Omitted fields take the *column* default, not a second definition here.
      expect(bare).toMatchObject({
        apartmentNumber: "201",
        wingId: null,
        floor: null,
        bhk: null,
        carpetAreaSqft: null,
        builtupAreaSqft: null,
        parkingSlots: 0,
        shareUnits: 1,
        occupancyStatus: "vacant",
        isCommercial: false,
        isBillable: true,
      });

      const rich = await apartments.create(
        fixture.buildingId,
        fixture.societyId,
        {
          apartmentNumber: "202",
          floor: 2,
          bhk: 3.5,
          carpetAreaSqft: 1180.5,
          builtupAreaSqft: 1450,
          parkingSlots: 2,
          shareUnits: 1.5,
          occupancyStatus: "rented",
          isCommercial: true,
          isBillable: false,
        },
        fixture.adminUserId,
      );
      expect(rich).toMatchObject({
        floor: 2,
        bhk: 3.5,
        carpetAreaSqft: 1180.5,
        builtupAreaSqft: 1450,
        parkingSlots: 2,
        shareUnits: 1.5,
        occupancyStatus: "rented",
        isCommercial: true,
        isBillable: false,
      });

      // Persisted through the same mapping on a reread.
      expect(
        await apartments.findApartment(
          rich.id,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ apartmentNumber: "202", occupancyStatus: "rented" });
    });

    it("translates a duplicate flat number into a conflict, not a driver error", async () => {
      const error = await rejection(
        apartments.create(
          fixture.buildingId,
          fixture.societyId,
          { apartmentNumber: "101" },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");
      expect(error.details).toMatchObject({ field: "apartmentNumber" });

      // The same number in a different building is fine.
      const otherBuilding = await insertBuilding(
        owner,
        fixture.societyId,
        "B Wing",
      );
      const moved = await apartments.create(
        otherBuilding,
        fixture.societyId,
        { apartmentNumber: "101" },
        fixture.adminUserId,
      );
      expect(moved.apartmentNumber).toBe("101");
      expect(await apartmentCount(fixture.societyId)).toBe(2);
    });

    it("refuses a flat created by a member who is not an admin", async () => {
      const error = await rejection(
        apartments.create(
          fixture.buildingId,
          fixture.societyId,
          { apartmentNumber: "301" },
          fixture.residentUserId,
        ),
      );
      // The policy's `WITH CHECK` raises, and the classifier reads it as a write
      // refusal — one rule, enforced where it cannot be bypassed.
      expect(error.code).toBe("forbidden");
      expect(await apartmentCount(fixture.societyId)).toBe(1);
    });

    it("patches only the fields sent, treats null as clear, and refuses an empty patch", async () => {
      const updated = await apartments.update(
        fixture.flat101 as never,
        fixture.societyId,
        { apartmentNumber: "101-A", floor: null, bhk: 2 },
        fixture.adminUserId,
      );
      expect(updated.apartmentNumber).toBe("101-A");
      expect(updated.floor).toBeNull();
      expect(updated.bhk).toBe(2);

      const nothing = await rejection(
        apartments.update(
          fixture.flat101 as never,
          fixture.societyId,
          {},
          fixture.adminUserId,
        ),
      );
      expect(nothing.code).toBe("validation");

      const missing = await rejection(
        apartments.update(
          "00000000-0000-4000-8000-000000000000" as never,
          fixture.societyId,
          { apartmentNumber: "nope" },
          fixture.adminUserId,
        ),
      );
      expect(missing.code).toBe("not_found");
    });

    it("soft-deletes a flat, leaving it out of every read", async () => {
      await apartments.remove(
        fixture.flat101 as never,
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(
        await apartments.findApartment(
          fixture.flat101 as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBeNull();
      expect(
        await apartments.listApartments(
          fixture.buildingId,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toEqual([]);
      // Soft, not gone: the row is still there for members, dues and readings.
      expect(await apartmentCount(fixture.societyId)).toBe(1);
      const [row] = await owner<{ deleted_at: string | null }[]>`
        select deleted_at from public.apartments where id = ${fixture.flat101}::uuid
      `;
      expect(row?.deleted_at).not.toBeNull();
    });

    it("refuses a soft delete by a member who is not an admin", async () => {
      const error = await rejection(
        apartments.remove(
          fixture.flat101 as never,
          fixture.societyId,
          fixture.residentUserId,
        ),
      );
      expect(error.code).toBe("forbidden");
      expect(
        await apartments.findApartment(
          fixture.flat101 as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).not.toBeNull();
    });
  });

  describe("createMany", () => {
    it("creates a batch and reports the labels a live flat already carries", async () => {
      const result = await apartments.createMany(
        fixture.buildingId,
        fixture.societyId,
        [{ apartmentNumber: "101" }, { apartmentNumber: "102" }],
        fixture.adminUserId,
      );

      expect(result.created.map((flat) => flat.apartmentNumber)).toEqual([
        "102",
      ]);
      expect(result.duplicateLabelsSkipped).toEqual(["101"]);
    });

    it("skips a label repeated inside the batch without losing the rows after it", async () => {
      const result = await apartments.createMany(
        fixture.buildingId,
        fixture.societyId,
        [
          { apartmentNumber: "201" },
          { apartmentNumber: "201" },
          { apartmentNumber: "202" },
        ],
        fixture.adminUserId,
      );

      expect(result.created.map((flat) => flat.apartmentNumber)).toEqual([
        "201",
        "202",
      ]);
      expect(result.duplicateLabelsSkipped).toEqual(["201"]);
      expect(await apartmentCount(fixture.societyId)).toBe(3);
    });

    it("rolls the whole batch back when a row fails for a reason that is not a duplicate", async () => {
      await expect(
        apartments.createMany(
          fixture.buildingId,
          fixture.societyId,
          [
            { apartmentNumber: "301" },
            // `numeric(8,3)` cannot hold this: a real failure, not a duplicate, so
            // it takes the transaction — and every row with it — down.
            { apartmentNumber: "302", shareUnits: 1_000_000_000 },
          ],
          fixture.adminUserId,
        ),
      ).rejects.toBeDefined();

      // Nothing partial survived: only the fixture's own flat.
      expect(await apartmentCount(fixture.societyId)).toBe(1);
    });
  });
});
