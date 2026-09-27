import { asBuildingId, asSocietyId, asUserId } from "@ses/domain";
import { MAX_PATTERN_APARTMENTS } from "@ses/domain";

import { bulkCreateApartments } from "../use-cases/bulk-create-apartments";
import { generateApartments } from "../use-cases/generate-apartments";
import type { StructureDeps } from "../use-cases/support";
import { FakeApartmentRepository } from "./support/fake-apartment-repository";
import {
  expectErr,
  expectOk,
  FakeBuildingRepository,
} from "./support/fake-building-repository";

/**
 * The two batch use cases (Roadmap T043 / T044), against the fakes.
 *
 * What is worth testing here, in order of value:
 *
 *  1. **The dry run writes nothing.** A preview that wrote would be the worst
 *     kind of bug — the undo is manual. Asserted on the repositories' call
 *     records, not on the absence of rows.
 *  2. **The skip-and-report rule is a *report*.** Existing numbers come back
 *     named, with counts that add up — never silently dropped.
 *  3. **The cap is refused before expansion**, and the batch reads that arrive
 *     before it are the only I/O a refusal performs.
 *  4. **A row is a flat with fewer things said about it** — the per-row fields
 *     of T043 resolve the same defaults the single-flat form resolves.
 */

const SOCIETY = "society-1";
const ADMIN = "user-admin";

function setup(): {
  readonly deps: StructureDeps;
  readonly repository: FakeBuildingRepository;
  readonly apartments: FakeApartmentRepository;
  readonly buildingId: string;
} {
  const repository = new FakeBuildingRepository();
  repository.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
  const apartments = new FakeApartmentRepository();
  const building = repository.seedBuilding(SOCIETY, { name: "Block A" });
  return {
    deps: { buildings: repository, apartments, memberships: repository },
    repository,
    apartments,
    buildingId: building.id,
  };
}

describe("generateApartments (T044)", () => {
  it("generates 64 flats across 2 wings x 8 floors x 4 units", async () => {
    const { deps, apartments, buildingId } = setup();

    const result = expectOk(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          pattern: "{wing}-{floor}{unit:02d}",
          floors: [1, 2, 3, 4, 5, 6, 7, 8],
          unitsPerFloor: 4,
          wings: [
            { id: null, label: "A" },
            { id: null, label: "B" },
          ],
          dryRun: false,
        },
      ),
    );

    expect(result.total).toBe(64);
    expect(result.createdCount).toBe(64);
    expect(result.skippedCount).toBe(0);
    expect(result.dryRun).toBe(false);
    // The acceptance's exact names, spot-checked at the boundaries of the order.
    expect(result.rows[0]).toMatchObject({
      apartmentNumber: "A-101",
      floor: 1,
      status: "created",
    });
    expect(result.rows[63]).toMatchObject({ apartmentNumber: "B-804" });
    expect(apartments.callCount("createMany")).toBe(1);
    expect(apartments.callCount("create")).toBe(64);
  });

  it("attaches the wing id and renders the ground floor as G", async () => {
    const { deps, apartments, buildingId } = setup();

    const result = expectOk(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          pattern: "{wing}{floor}{unit}",
          floors: [0, 1],
          unitsPerFloor: 2,
          wings: [{ id: "wing-1", label: "A" }],
          dryRun: false,
        },
      ),
    );

    expect(result.createdCount).toBe(4);
    // Floor 0 is `G` bare; floor 1 is `1`.
    expect(result.rows.map((row) => row.apartmentNumber)).toEqual([
      "AG1",
      "AG2",
      "A11",
      "A12",
    ]);
    expect(apartments.stored("apartment-1")?.wingId).toBe("wing-1");
    expect(apartments.stored("apartment-1")?.floor).toBe(0);
  });

  it("dry run writes nothing and still reports what would land", async () => {
    const { deps, apartments, buildingId } = setup();
    apartments.seedApartment(SOCIETY, buildingId, { apartmentNumber: "101" });

    const result = expectOk(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          pattern: "{floor}{unit:02d}",
          floors: [1],
          unitsPerFloor: 2,
          dryRun: true,
        },
      ),
    );

    expect(result.dryRun).toBe(true);
    expect(result.createdCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.rows.map((row) => row.status)).toEqual([
      "skipped",
      "created",
    ]);
    // The whole point of a preview: no write of any kind reached storage.
    expect(apartments.callCount("create")).toBe(0);
    expect(apartments.callCount("createMany")).toBe(0);
  });

  it("re-running skips existing numbers and reports them", async () => {
    const { deps, apartments, buildingId } = setup();
    const command = {
      pattern: "{floor}{unit:02d}",
      floors: [1, 2],
      unitsPerFloor: 2,
      dryRun: false,
    };

    const first = expectOk(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        command,
      ),
    );
    expect(first.createdCount).toBe(4);

    const second = expectOk(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        command,
      ),
    );
    expect(second.createdCount).toBe(0);
    expect(second.skippedCount).toBe(4);
    expect(second.rows.every((row) => row.status === "skipped")).toBe(true);
    // Nothing new was written on the re-run.
    expect(apartments.callCount("create")).toBe(4);
  });

  it("refuses a batch over the cap before expanding or reading", async () => {
    const { deps, apartments, repository, buildingId } = setup();

    const error = expectErr(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          pattern: "{floor}{unit:02d}",
          floors: Array.from({ length: 100 }, (_, index) => index + 1),
          unitsPerFloor: 200, // 100 x 200 = 20,000 > 2,000
          dryRun: false,
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("cap");
    // Refused on arithmetic: not one label built, not one read of the flats.
    expect(apartments.calls()).toEqual([]);
    expect(repository.calls()).toContain("findBuilding");
  });

  it("refuses a {wing} pattern without wings, naming the field", async () => {
    const { deps, buildingId } = setup();

    const error = expectErr(
      await generateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          pattern: "{wing}-{floor}{unit}",
          floors: [1],
          unitsPerFloor: 1,
          dryRun: true,
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("wings");
  });

  it("refuses a Treasurer", async () => {
    const repository = new FakeBuildingRepository();
    repository.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });
    const apartments = new FakeApartmentRepository();
    const building = repository.seedBuilding(SOCIETY, { name: "Block A" });
    const deps: StructureDeps = {
      buildings: repository,
      apartments,
      memberships: repository,
    };

    const error = expectErr(
      await generateApartments(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        asBuildingId(building.id),
        {
          pattern: "{floor}{unit}",
          floors: [1],
          unitsPerFloor: 1,
          dryRun: true,
        },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(apartments.calls()).toEqual([]);
  });
});

describe("bulkCreateApartments (T043)", () => {
  it("creates 64 rows in one call with the defaults resolved per row", async () => {
    const { deps, apartments, buildingId } = setup();

    const result = expectOk(
      await bulkCreateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          buildingId: asBuildingId(buildingId),
          rows: Array.from({ length: 64 }, (_, index) => ({
            apartmentNumber: `F-${index + 101}`,
          })),
        },
      ),
    );

    expect(result.total).toBe(64);
    expect(result.createdCount).toBe(64);
    expect(result.existingCount).toBe(0);
    expect(result.duplicateCount).toBe(0);
    expect(result.invalidCount).toBe(0);
    expect(result.created).toHaveLength(64);
    // The defaults the single-flat form resolves, resolved here too.
    expect(result.created[0]).toMatchObject({
      apartmentNumber: "F-101",
      parkingSlots: 0,
      shareUnits: 1,
      occupancyStatus: "vacant",
      isBillable: true,
    });
    expect(apartments.callCount("createMany")).toBe(1);
  });

  it("sets the per-row fields the single form can set", async () => {
    const { deps, apartments, buildingId } = setup();

    const result = expectOk(
      await bulkCreateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          buildingId: asBuildingId(buildingId),
          rows: [
            {
              apartmentNumber: "S-1",
              floor: 2,
              bhk: 3,
              carpetAreaSqft: 900,
              builtupAreaSqft: 1100,
              parkingSlots: 1,
              shareUnits: 2,
              occupancyStatus: "rented",
            },
          ],
        },
      ),
    );

    expect(result.created[0]).toMatchObject({
      apartmentNumber: "S-1",
      floor: 2,
      bhk: 3,
      carpetAreaSqft: 900,
      builtupAreaSqft: 1100,
      parkingSlots: 1,
      shareUnits: 2,
      occupancyStatus: "rented",
    });
    // The row reached the batch with everything the caller set.
    expect(apartments.createInputs().at(-1)).toMatchObject({ bhk: 3 });
  });

  it("reports exactly three duplicates and creates the rest", async () => {
    const { deps, apartments, buildingId } = setup();

    const rows = Array.from({ length: 67 }, (_, index) => ({
      apartmentNumber: `D-${index + 1}`,
    }));
    // Three in-file duplicates of rows that will also be created.
    rows.push({ apartmentNumber: "D-1" });
    rows.push({ apartmentNumber: "D-2" });
    rows.push({ apartmentNumber: "D-3" });

    const result = expectOk(
      await bulkCreateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          buildingId: asBuildingId(buildingId),
          rows,
        },
      ),
    );

    expect(result.total).toBe(70);
    expect(result.duplicateCount).toBe(3);
    expect(result.createdCount).toBe(67);
    expect(result.created).toHaveLength(67);
    expect(
      result.outcomes.filter((outcome) => outcome.status === "duplicate"),
    ).toEqual([
      { apartmentNumber: "D-1", status: "duplicate" },
      { apartmentNumber: "D-2", status: "duplicate" },
      { apartmentNumber: "D-3", status: "duplicate" },
    ]);
    expect(apartments.callCount("createMany")).toBe(1);
  });

  it("reports numbers a live flat already carries as existing", async () => {
    const { deps, apartments, buildingId } = setup();
    apartments.seedApartment(SOCIETY, buildingId, {
      apartmentNumber: "E-1",
    });

    const result = expectOk(
      await bulkCreateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          buildingId: asBuildingId(buildingId),
          rows: [{ apartmentNumber: "E-1" }, { apartmentNumber: "E-2" }],
        },
      ),
    );

    expect(result.existingCount).toBe(1);
    expect(result.createdCount).toBe(1);
    expect(result.outcomes).toEqual([
      { apartmentNumber: "E-1", status: "existing" },
      { apartmentNumber: "E-2", status: "created" },
    ]);
  });

  it("reports an invalid row with its field and creates the rest", async () => {
    const { deps, apartments, buildingId } = setup();

    const result = expectOk(
      await bulkCreateApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        {
          buildingId: asBuildingId(buildingId),
          rows: [
            { apartmentNumber: "V-1" },
            { apartmentNumber: "   " },
            { apartmentNumber: "V-2", carpetAreaSqft: 0 },
          ],
        },
      ),
    );

    expect(result.invalidCount).toBe(2);
    expect(result.createdCount).toBe(1);
    const invalid = result.outcomes.filter(
      (outcome) => outcome.status === "invalid",
    );
    expect(invalid[0]).toMatchObject({
      apartmentNumber: "   ",
      field: "apartmentNumber",
    });
    expect(invalid[1]).toMatchObject({
      apartmentNumber: "V-2",
      field: "carpetAreaSqft",
      message: expect.stringContaining("Carpet area"),
    });
    // The batch continues past a bad row: storage saw one create, not zero.
    expect(apartments.callCount("createMany")).toBe(1);
  });

  it("refuses an empty batch for a caller with no membership", async () => {
    const { buildingId } = setup();

    // The application layer's guard fires first for a non-member caller; the
    // 2,000-row bound is the wire contract's (tested at the API layer), so here
    // the meaningful assertion is the batch mechanics, not a duplicate bound.
    const repository = new FakeBuildingRepository();
    const apartments = new FakeApartmentRepository();
    const strangerDeps: StructureDeps = {
      buildings: repository,
      apartments,
      memberships: repository,
    };

    const error = expectErr(
      await bulkCreateApartments(
        strangerDeps,
        asUserId("user-nobody"),
        asSocietyId(SOCIETY),
        asBuildingId(buildingId),
        { buildingId: asBuildingId(buildingId), rows: [] },
      ),
    );
    // No membership → not_found before any row is looked at (PRD T041).
    expect(error.code).toBe("not_found");
    expect(apartments.calls()).toEqual([]);
  });

  it("refuses a Treasurer", async () => {
    const repository = new FakeBuildingRepository();
    repository.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });
    const apartments = new FakeApartmentRepository();
    const building = repository.seedBuilding(SOCIETY, { name: "Block A" });
    const deps: StructureDeps = {
      buildings: repository,
      apartments,
      memberships: repository,
    };

    const error = expectErr(
      await bulkCreateApartments(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        asBuildingId(building.id),
        {
          buildingId: asBuildingId(building.id),
          rows: [{ apartmentNumber: "T-1" }],
        },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(apartments.calls()).toEqual([]);
  });

  it("surfaces MAX_PATTERN_APARTMENTS as the shared cap constant", () => {
    // The bound the wire contract and the generator share is the domain's, so a
    // change to one cannot orphan the other.
    expect(MAX_PATTERN_APARTMENTS).toBe(2_000);
  });
});
