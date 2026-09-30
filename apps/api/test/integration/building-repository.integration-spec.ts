import type { BuildingRepository, UserId } from "@ses/domain";
import type postgres from "postgres";

import { BUILDING_REPOSITORY } from "../../src/modules/structure/application/structure.tokens";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * `BuildingRepositoryPostgres` against real PostgreSQL and real RLS — the first
 * level of a society's physical structure, and the parent the flats hang off.
 *
 * This adapter is the module's plain-DML counterpart to `society`'s RPCs: the
 * admin check is a policy rather than a function, `update` is a single static
 * `coalesce` statement (nothing here can be *cleared*), and `remove` is the one
 * call that goes through `building_soft_delete()`. Each of those is asserted
 * through the repository, with the database's refusal read as the module's own
 * error — never as PostgreSQL's message.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let buildings: BuildingRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  buildings = harness.app.get<BuildingRepository>(BUILDING_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

interface Fixture extends SocietyFixture {
  readonly buildingId: string;
  /** An active ordinary member — a non-admin for the policy tests. */
  readonly residentUserId: UserId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(harness);
  const building = await buildings.create(
    society.societyId,
    { name: "A Wing", totalFloors: 4 },
    society.adminUserId,
  );
  const residentUserId = (await createLocalUser(
    owner,
    "resident@building.ses.test",
    "Resident",
  )) as UserId;
  await insertMember(owner, society.societyId, {
    userId: residentUserId,
    displayName: "Resident",
    phone: "+919876500401",
    role: "resident",
  });
  return { ...society, buildingId: building.id, residentUserId };
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

describe("BuildingRepositoryPostgres", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("reads", () => {
    it("lists live buildings in display order, then by name", async () => {
      await buildings.create(
        fixture.societyId,
        { name: "C Tower", displayOrder: 2 },
        fixture.adminUserId,
      );
      await buildings.create(
        fixture.societyId,
        { name: "B Tower", displayOrder: 0 },
        fixture.adminUserId,
      );
      await buildings.create(
        fixture.societyId,
        { name: "A Annex", displayOrder: 0 },
        fixture.adminUserId,
      );

      const rows = await buildings.listBuildings(
        fixture.societyId,
        fixture.adminUserId,
      );
      // display_order first; 0 ties broken by name; the fixture's "A Wing" has 0.
      expect(rows.map((row) => row.name)).toEqual([
        "A Annex",
        "A Wing",
        "B Tower",
        "C Tower",
      ]);
      expect(rows.find((row) => row.name === "A Wing")).toMatchObject({
        totalFloors: 4,
        displayOrder: 0,
        societyId: fixture.societyId,
        deletedAt: null,
      });
    });

    it("returns one building to a member, and null across societies or after removal", async () => {
      expect(
        await buildings.findBuilding(
          fixture.buildingId as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ name: "A Wing", totalFloors: 4 });

      // A member of one society cannot address another's building by id.
      const other = await seedSociety(
        harness,
        "Other Court",
        "other@building.ses.test",
      );
      expect(
        await buildings.findBuilding(
          fixture.buildingId as never,
          other.societyId,
          other.adminUserId,
        ),
      ).toBeNull();

      await buildings.remove(
        fixture.buildingId as never,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(
        await buildings.findBuilding(
          fixture.buildingId as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBeNull();
    });
  });

  describe("writes", () => {
    it("fills the column defaults and maps every sent field", async () => {
      const bare = await buildings.create(
        fixture.societyId,
        { name: "Bare Block" },
        fixture.adminUserId,
      );
      expect(bare).toMatchObject({
        name: "Bare Block",
        // `null`, not 0: "not counted" is not "no floors".
        totalFloors: null,
        displayOrder: 0,
      });

      const rich = await buildings.create(
        fixture.societyId,
        { name: "Rich Tower", totalFloors: 12, displayOrder: 7 },
        fixture.adminUserId,
      );
      expect(rich).toMatchObject({ totalFloors: 12, displayOrder: 7 });
      expect(
        await buildings.findBuilding(
          rich.id,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ name: "Rich Tower", totalFloors: 12 });
    });

    it("translates a duplicate name in the same society into a conflict, but allows it elsewhere", async () => {
      const error = await rejection(
        buildings.create(
          fixture.societyId,
          { name: "A Wing" },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");

      // The unique index is scoped to the society: the same name is fine in another.
      const other = await seedSociety(
        harness,
        "Other Court",
        "other@building.ses.test",
      );
      const elsewhere = await buildings.create(
        other.societyId,
        { name: "A Wing" },
        other.adminUserId,
      );
      expect(elsewhere.name).toBe("A Wing");
    });

    it("translates a floors bound violation into a validation error, not a driver error", async () => {
      const tooMany = await rejection(
        buildings.create(
          fixture.societyId,
          { name: "Sky Tower", totalFloors: 500 },
          fixture.adminUserId,
        ),
      );
      expect(tooMany.code).toBe("validation");

      const negative = await rejection(
        buildings.create(
          fixture.societyId,
          { name: "Sunken Tower", totalFloors: 0 },
          fixture.adminUserId,
        ),
      );
      expect(negative.code).toBe("validation");
    });

    it("refuses a building written by a member who is not an admin", async () => {
      const error = await rejection(
        buildings.create(
          fixture.societyId,
          { name: "Resident Block" },
          fixture.residentUserId,
        ),
      );
      expect(error.code).toBe("forbidden");

      const rows = await buildings.listBuildings(
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(rows.map((row) => row.name)).toEqual(["A Wing"]);
    });

    it("patches only the fields sent, and answers not_found for an unknown one", async () => {
      const updated = await buildings.update(
        fixture.buildingId as never,
        fixture.societyId,
        { name: "A Wing Renamed", totalFloors: 6 },
        fixture.adminUserId,
      );
      expect(updated.name).toBe("A Wing Renamed");
      expect(updated.totalFloors).toBe(6);
      // Absent fields are left alone (`coalesce`), never cleared.
      expect(updated.displayOrder).toBe(0);

      const missing = await rejection(
        buildings.update(
          "00000000-0000-4000-8000-000000000000" as never,
          fixture.societyId,
          { name: "Nowhere" },
          fixture.adminUserId,
        ),
      );
      expect(missing.code).toBe("not_found");
    });

    it("soft-deletes through the function, leaving the row for the flats that named it", async () => {
      await buildings.remove(
        fixture.buildingId as never,
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(
        await buildings.listBuildings(fixture.societyId, fixture.adminUserId),
      ).toEqual([]);
      const [row] = await owner<{ deleted_at: string | null }[]>`
        select deleted_at from public.buildings where id = ${fixture.buildingId}::uuid
      `;
      expect(row?.deleted_at).not.toBeNull();
    });

    it("answers not_found for a removal of an unknown building or by a non-admin", async () => {
      const unknown = await rejection(
        buildings.remove(
          "00000000-0000-4000-8000-000000000000" as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      );
      expect(unknown.code).toBe("not_found");

      const forbidden = await rejection(
        buildings.remove(
          fixture.buildingId as never,
          fixture.societyId,
          fixture.residentUserId,
        ),
      );
      expect(forbidden.code).toBe("forbidden");
    });
  });
});
