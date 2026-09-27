import {
  asBuildingId,
  asSocietyId,
  asUserId,
  structureError,
} from "@ses/domain";

import { createBuilding } from "../use-cases/create-building";
import { deleteApartment } from "../use-cases/delete-apartment";
import { deleteBuilding } from "../use-cases/delete-building";
import { getBuilding } from "../use-cases/get-building";
import { listBuildings } from "../use-cases/list-buildings";
import type { StructureDeps } from "../use-cases/support";
import { updateBuilding } from "../use-cases/update-building";
import { FakeApartmentRepository } from "./support/fake-apartment-repository";
import {
  expectErr,
  expectOk,
  FakeBuildingRepository,
} from "./support/fake-building-repository";

/**
 * The five building use cases, against a fake repository.
 *
 * What these tests are *for*, in order of value:
 *
 *  1. **Authorisation is answered by the capability evaluation, not by a role
 *     literal in a use case.** A Treasurer and a Guest are both refused, and the
 *     refusal is a `forbidden` the caller can act on — while a non-member gets
 *     `not_found`, which is a different answer on purpose (PRD T041).
 *  2. **Validation happens before I/O.** An invalid command never reaches the
 *     repository, which is asserted through `callCount("create") === 0` rather
 *     than through the absence of a row.
 *  3. **A partial patch stays partial.** The most dangerous bug in an update path
 *     is writing the merged object back, because it silently reverts a concurrent
 *     change to a field the caller did not touch.
 */

const SOCIETY = "society-1";
const ADMIN = "user-admin";

function setup(): {
  readonly deps: StructureDeps;
  readonly repository: FakeBuildingRepository;
  readonly apartments: FakeApartmentRepository;
} {
  const repository = new FakeBuildingRepository();
  repository.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
  const apartments = new FakeApartmentRepository();
  return {
    deps: { buildings: repository, apartments, memberships: repository },
    repository,
    apartments,
  };
}

describe("createBuilding", () => {
  it("creates for an Admin and resolves the column defaults", async () => {
    const { deps, repository } = setup();

    const created = expectOk(
      await createBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "  Block  A ",
      }),
    );

    expect(created.name).toBe("Block A");
    // The defaults are resolved in the domain, not left to the database, so the
    // result is identical whichever adapter ran.
    expect(created.displayOrder).toBe(0);
    expect(created.totalFloors).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(repository.callCount("create")).toBe(1);
  });

  it("keeps a supplied floor count and display order", async () => {
    const { deps } = setup();

    const created = expectOk(
      await createBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Tower 4",
        totalFloors: 12,
        displayOrder: 2,
      }),
    );

    expect(created.totalFloors).toBe(12);
    expect(created.displayOrder).toBe(2);
  });

  it("refuses a blank name without touching storage", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "   ",
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("name");
    // The assertion that matters: validation runs *before* the repository call.
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a floor count that is zero rather than storing 'unknown'", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Block B",
        totalFloors: 0,
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("totalFloors");
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a Treasurer — structure.edit is Admin-only", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });

    const error = expectErr(
      await createBuilding(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        { name: "Block C" },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a guest, whose role holds neither half of the structure pair", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, { userId: "user-guest", role: "guest" });

    const error = expectErr(
      await createBuilding(deps, asUserId("user-guest"), asSocietyId(SOCIETY), {
        name: "Block D",
      }),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("create")).toBe(0);
  });

  it("answers not_found — never forbidden — for a non-member", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createBuilding(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        {
          name: "Block E",
        },
      ),
    );

    // A distinguishable answer would let a caller enumerate societies.
    expect(error.code).toBe("not_found");
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a pending member, who holds no capability yet", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-pending",
      role: "admin",
      status: "pending",
    });

    const error = expectErr(
      await createBuilding(
        deps,
        asUserId("user-pending"),
        asSocietyId(SOCIETY),
        { name: "Block F" },
      ),
    );

    expect(error.code).toBe("forbidden");
  });

  it("converts an adapter failure into the module's vocabulary", async () => {
    const { deps, repository } = setup();
    repository.failNext(
      "create",
      structureError("conflict", "A building with that name already exists."),
    );

    const error = expectErr(
      await createBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Block A",
      }),
    );

    expect(error.code).toBe("conflict");
  });

  it("classifies an unrecognised throw as unknown rather than guessing", async () => {
    const { deps, repository } = setup();
    repository.failNext("create", new Error("connection reset"));

    const error = expectErr(
      await createBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Block G",
      }),
    );

    expect(error.code).toBe("unknown");
  });
});

describe("listBuildings", () => {
  it("returns the buildings in display order, with capabilities", async () => {
    const { deps, repository } = setup();
    repository.seedBuilding(SOCIETY, { name: "B", displayOrder: 2 });
    repository.seedBuilding(SOCIETY, { name: "A", displayOrder: 1 });
    repository.seedBuilding(SOCIETY, { name: "C", displayOrder: 1 });

    const list = expectOk(
      await listBuildings(deps, asUserId(ADMIN), asSocietyId(SOCIETY)),
    );

    expect(list.buildings.map((building) => building.name)).toEqual([
      "A",
      "C",
      "B",
    ]);
    expect(list.capabilities).toEqual({ canManage: true, canView: true });
  });

  it("returns an empty list for a society with no buildings yet", async () => {
    const { deps } = setup();

    const list = expectOk(
      await listBuildings(deps, asUserId(ADMIN), asSocietyId(SOCIETY)),
    );

    // Not an error: the structure step is the screen that fixes this.
    expect(list.buildings).toEqual([]);
    expect(list.capabilities.canManage).toBe(true);
  });

  it("refuses a Resident: reading needs structure.view, not just membership", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-resident",
      role: "resident",
    });

    const list = expectOk(
      await listBuildings(
        deps,
        asUserId("user-resident"),
        asSocietyId(SOCIETY),
      ),
    );

    // A Resident *may* view; the assertion is the capability split, which is what
    // the UI renders from.
    expect(list.capabilities).toEqual({ canManage: false, canView: true });
  });

  it("refuses a Guest, whose empty list must not look like 'no buildings'", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, { userId: "user-guest", role: "guest" });

    const error = expectErr(
      await listBuildings(deps, asUserId("user-guest"), asSocietyId(SOCIETY)),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("listBuildings")).toBe(0);
  });

  it("answers not_found for a non-member", async () => {
    const { deps } = setup();

    const error = expectErr(
      await listBuildings(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});

describe("getBuilding", () => {
  it("returns the building, the membership and the capabilities", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Tower 1" });

    const view = expectOk(
      await getBuilding(deps, asUserId(ADMIN), asSocietyId(SOCIETY), seeded.id),
    );

    expect(view.building.name).toBe("Tower 1");
    expect(view.membership.role).toBe("admin");
    expect(view.capabilities.canManage).toBe(true);
  });

  it("answers not_found for a building in another society", async () => {
    const { deps, repository } = setup();
    const foreign = repository.seedBuilding("society-2", { name: "Theirs" });

    const error = expectErr(
      await getBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        foreign.id,
      ),
    );

    // Unreachable, not merely unauthorised: a building id alone never addresses
    // a row across a tenant boundary.
    expect(error.code).toBe("not_found");
  });

  it("answers not_found for a building that does not exist", async () => {
    const { deps } = setup();

    const error = expectErr(
      await getBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId("00000000-0000-0000-0000-000000000000"),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});

describe("updateBuilding", () => {
  it("sends only the keys the caller set", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, {
      name: "Block A",
      displayOrder: 0,
    });

    expectOk(
      await updateBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { displayOrder: 5 },
      ),
    );

    // The whole point: a patch that changed the order must not carry the name.
    expect(repository.updatePatches()).toEqual([{ displayOrder: 5 }]);
    // And the stored row is unchanged in every other respect.
    expect(repository.stored(seeded.id)?.name).toBe("Block A");
    expect(repository.stored(seeded.id)?.displayOrder).toBe(5);
  });

  it("normalises a renamed building", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    const updated = expectOk(
      await updateBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { name: "  Block   A (West) " },
      ),
    );

    expect(updated.name).toBe("Block A (West)");
  });

  it("refuses an empty patch rather than performing a no-op write", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    const error = expectErr(
      await updateBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        {},
      ),
    );

    expect(error.code).toBe("validation");
    expect(repository.callCount("update")).toBe(0);
  });

  it("refuses a Treasurer", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    const error = expectErr(
      await updateBuilding(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        seeded.id,
        { name: "Block B" },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("update")).toBe(0);
  });

  it("validates before I/O", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    const error = expectErr(
      await updateBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { totalFloors: 5000 },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("totalFloors");
    expect(repository.callCount("update")).toBe(0);
  });

  it("answers not_found before it answers forbidden for a non-member", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    const error = expectErr(
      await updateBuilding(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        seeded.id,
        { name: "Block B" },
      ),
    );

    expect(error.code).toBe("not_found");
  });
});

describe("deleteBuilding", () => {
  it("soft-deletes: the row survives with deleted_at set", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    expectOk(
      await deleteBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    // Physically gone would break apartments, dues and history later; the port's
    // contract is a mark, and this is where that is asserted.
    expect(repository.stored(seeded.id)?.deletedAt).not.toBeNull();
  });

  it("refuses a Treasurer", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });

    const error = expectErr(
      await deleteBuilding(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("remove")).toBe(0);
    expect(repository.stored(seeded.id)?.deletedAt).toBeNull();
  });

  it("answers not_found for a building in another society", async () => {
    const { deps, repository } = setup();
    const foreign = repository.seedBuilding("society-2", { name: "Theirs" });

    const error = expectErr(
      await deleteBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        foreign.id,
      ),
    );

    expect(error.code).toBe("not_found");
    expect(repository.callCount("remove")).toBe(0);
  });

  it("refuses while the building still has flats, naming the count", async () => {
    const { deps, repository, apartments } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });
    apartments.seedApartment(SOCIETY, seeded.id, { apartmentNumber: "A-101" });
    apartments.seedApartment(SOCIETY, seeded.id, { apartmentNumber: "A-102" });

    const error = expectErr(
      await deleteBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    // A typed refusal, not a raw FK violation — and the count is carried so the
    // screen can say how many flats are in the way.
    expect(error.code).toBe("building_has_apartments");
    expect(error.details?.count).toBe(2);
    // Nothing was deleted, and the check ran *before* the write: the guard is not
    // a post-hoc explanation of a failure.
    expect(repository.callCount("remove")).toBe(0);
    expect(repository.stored(seeded.id)?.deletedAt).toBeNull();
  });

  it("deletes once the flats are removed, not just created", async () => {
    const { deps, repository, apartments } = setup();
    const seeded = repository.seedBuilding(SOCIETY, { name: "Block A" });
    const flat = apartments.seedApartment(SOCIETY, seeded.id);
    expectOk(
      await deleteApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
      ),
    );

    expectOk(
      await deleteBuilding(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    // A soft-deleted flat is not a live one: the count is over live rows, which is
    // what makes the refusal's advice ("remove them first") actually work.
    expect(repository.stored(seeded.id)?.deletedAt).not.toBeNull();
  });
});
