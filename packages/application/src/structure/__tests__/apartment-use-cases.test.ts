import {
  asApartmentId,
  asBuildingId,
  asSocietyId,
  asUserId,
} from "@ses/domain";

import { createApartment } from "../use-cases/create-apartment";
import { deleteApartment } from "../use-cases/delete-apartment";
import { getApartment } from "../use-cases/get-apartment";
import { listApartments } from "../use-cases/list-apartments";
import type { StructureDeps } from "../use-cases/support";
import { updateApartment } from "../use-cases/update-apartment";
import { FakeApartmentRepository } from "./support/fake-apartment-repository";
import {
  expectErr,
  expectOk,
  FakeBuildingRepository,
} from "./support/fake-building-repository";

/**
 * The five apartment use cases, against fakes.
 *
 * What these tests are *for*, in order of value:
 *
 *  1. **The `undefined` / `null` distinction on a patch.** This is the one rule
 *     apartments have that buildings do not: `floor: undefined` means "leave it
 *     alone" and `floor: null` means "no longer recorded". A patch API that
 *     collapsed them would make a recorded area impossible to retract, so it is
 *     asserted through the *patch the repository received* rather than through the
 *     returned row — the difference is invisible in the result.
 *  2. **The cross-field rule is checked against what survives the patch.** A patch
 *     that sets only the carpet area has to be validated against the built-up area
 *     as stored, which is the reason the use case reads the flat before it writes.
 *  3. **Authorisation comes from the capability evaluation**, so a Treasurer is
 *     refused a write, a Guest is refused even a read, and a non-member gets
 *     `not_found` — a different answer on purpose (PRD T041).
 *  4. **Validation happens before I/O**: an invalid command never reaches storage.
 */

const SOCIETY = "society-1";
const ADMIN = "user-admin";

function setup(): {
  readonly deps: StructureDeps;
  readonly repository: FakeBuildingRepository;
  readonly apartments: FakeApartmentRepository;
  readonly buildingId: ReturnType<typeof asBuildingId>;
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

describe("createApartment", () => {
  it("creates for an Admin and resolves the column defaults", async () => {
    const { deps, buildingId } = setup();

    const created = expectOk(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "  A-101 ",
        },
      ),
    );

    expect(created.apartmentNumber).toBe("A-101");
    expect(created.buildingId).toBe(buildingId);
    expect(created.societyId).toBe(SOCIETY);
    // Defaults resolved in the domain, so the entity is the same whichever
    // adapter ran — a test asserting a flat's slots must not depend on that.
    expect(created.parkingSlots).toBe(0);
    expect(created.shareUnits).toBe(1);
    expect(created.occupancyStatus).toBe("vacant");
    expect(created.isCommercial).toBe(false);
    expect(created.isBillable).toBe(true);
    expect(created.floor).toBeNull();
    expect(created.deletedAt).toBeNull();
  });

  it("keeps every supplied field", async () => {
    const { deps, buildingId } = setup();

    const created = expectOk(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "B-1204",
          floor: 12,
          bhk: 2.5,
          carpetAreaSqft: 1200,
          builtupAreaSqft: 1450,
          parkingSlots: 2,
          shareUnits: 1.5,
          occupancyStatus: "rented",
          isCommercial: true,
          isBillable: false,
        },
      ),
    );

    expect(created).toMatchObject({
      apartmentNumber: "B-1204",
      floor: 12,
      bhk: 2.5,
      carpetAreaSqft: 1200,
      builtupAreaSqft: 1450,
      parkingSlots: 2,
      shareUnits: 1.5,
      occupancyStatus: "rented",
      isCommercial: true,
      isBillable: false,
    });
  });

  it("refuses a blank flat number without touching storage", async () => {
    const { deps, apartments, buildingId } = setup();

    const error = expectErr(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "   ",
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("apartmentNumber");
    expect(apartments.callCount("create")).toBe(0);
  });

  it("refuses a zero area, which would divide by zero at billing time", async () => {
    const { deps, apartments, buildingId } = setup();

    const error = expectErr(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "A-1",
          carpetAreaSqft: 0,
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("carpetAreaSqft");
    expect(apartments.callCount("create")).toBe(0);
  });

  it("refuses a built-up area smaller than the carpet area", async () => {
    const { deps, apartments, buildingId } = setup();

    const error = expectErr(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "A-1",
          carpetAreaSqft: 1200,
          builtupAreaSqft: 900,
        },
      ),
    );

    expect(error.code).toBe("validation");
    // Attached to the field that is wrong, so a form can highlight it.
    expect(error.details?.field).toBe("builtupAreaSqft");
    expect(apartments.callCount("create")).toBe(0);
  });

  it("refuses a configuration that is not a half step", async () => {
    const { deps, apartments, buildingId } = setup();

    const error = expectErr(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "A-1",
          bhk: 1.25,
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("bhk");
    expect(apartments.callCount("create")).toBe(0);
  });

  it("refuses an occupancy status outside the enum", async () => {
    const { deps, apartments, buildingId } = setup();

    const error = expectErr(
      await createApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        buildingId,
        {
          apartmentNumber: "A-1",
          // The value object takes `string` on purpose: an unrecognised value from
          // the wire must be a field error, not a `22P02` the classifier calls
          // `unknown`.
          occupancyStatus: "haunted" as never,
        },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("occupancyStatus");
    expect(apartments.callCount("create")).toBe(0);
  });

  it("refuses a Treasurer — structure.edit is Admin-only", async () => {
    const { deps, repository, apartments, buildingId } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });

    const error = expectErr(
      await createApartment(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        buildingId,
        { apartmentNumber: "A-1" },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(apartments.callCount("create")).toBe(0);
  });

  it("answers not_found for a caller with no membership", async () => {
    const { deps, apartments, buildingId } = setup();

    const error = expectErr(
      await createApartment(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        buildingId,
        { apartmentNumber: "A-1" },
      ),
    );

    // not_found, never forbidden: a non-member must not be able to tell another
    // tenant's society from a non-existent one (PRD T041).
    expect(error.code).toBe("not_found");
    expect(apartments.callCount("create")).toBe(0);
  });
});

describe("updateApartment", () => {
  it("sends only the field that was sent — an absent key leaves the rest alone", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1", {
      apartmentNumber: "A-101",
      floor: 1,
    });

    const updated = expectOk(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
        {
          apartmentNumber: "A-102",
        },
      ),
    );

    expect(updated.apartmentNumber).toBe("A-102");
    // The stored floor is untouched, and the *patch* proves it: a patch carrying
    // `floor: undefined` would be a different object that an adapter could read as
    // "clear this column".
    const patch = apartments.updatePatches()[0];
    expect(patch).toEqual({ apartmentNumber: "A-102" });
    expect(Object.keys(patch ?? {})).not.toContain("floor");
    expect(updated.floor).toBe(1);
  });

  it("clears a field with an explicit null", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1", { floor: 3 });

    const updated = expectOk(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
        {
          floor: null,
        },
      ),
    );

    expect(updated.floor).toBeNull();
    expect(apartments.updatePatches()[0]).toEqual({ floor: null });
  });

  it("checks the area ordering against what will survive the patch", async () => {
    const { deps, apartments } = setup();
    // Stored (the fake's fixture): carpet 900, built-up 1100. Patching only the
    // carpet to 1500 must be refused against the *stored* built-up area — the fact
    // the command alone cannot see, and the reason the flat is read before the rule
    // runs.
    const flat = apartments.seedApartment(SOCIETY, "building-1");

    const refused = expectErr(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
        {
          carpetAreaSqft: 1500,
        },
      ),
    );

    expect(refused.code).toBe("validation");
    expect(refused.details?.field).toBe("builtupAreaSqft");
    expect(apartments.callCount("update")).toBe(0);

    // The same patch below the stored built-up area is accepted, and the built-up
    // area is left exactly as it was: the patch never mentioned it.
    const ok = expectOk(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
        {
          carpetAreaSqft: 1000,
        },
      ),
    );
    expect(ok.carpetAreaSqft).toBe(1000);
    expect(ok.builtupAreaSqft).toBe(1100);
  });

  it("rejects an empty patch rather than writing the row back to itself", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1");

    const error = expectErr(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
        {},
      ),
    );

    expect(error.code).toBe("validation");
    // The db-visible consequence of not doing this: an UPDATE that changes nothing
    // but bumps `updated_at`, which is a change no user made.
    expect(apartments.callCount("update")).toBe(0);
  });

  it("answers not_found for a flat in another society, before any field is read", async () => {
    const { deps, apartments } = setup();
    const foreign = apartments.seedApartment("society-2", "building-1");

    const error = expectErr(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        foreign.id,
        {
          apartmentNumber: "X-1",
        },
      ),
    );

    expect(error.code).toBe("not_found");
    expect(apartments.callCount("update")).toBe(0);
  });

  it("answers not_found for a flat that was already removed", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1", {
      deleted: true,
    });

    const error = expectErr(
      await updateApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
        {
          apartmentNumber: "X-1",
        },
      ),
    );

    expect(error.code).toBe("not_found");
  });

  it("refuses a Treasurer", async () => {
    const { deps, repository, apartments } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });
    const flat = apartments.seedApartment(SOCIETY, "building-1");

    const error = expectErr(
      await updateApartment(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        flat.id,
        { apartmentNumber: "X-1" },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(apartments.callCount("update")).toBe(0);
  });
});

describe("deleteApartment", () => {
  it("soft-deletes: the row survives with deleted_at set", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1");

    expectOk(
      await deleteApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        flat.id,
      ),
    );

    // Physically gone would break members, dues and meter readings later; the
    // port's contract is a mark, and this is where that is asserted.
    expect(apartments.stored(flat.id)?.deletedAt).not.toBeNull();
    // …and it is invisible to every read afterwards.
    expect(
      await apartments.findApartment(
        flat.id,
        asSocietyId(SOCIETY),
        asUserId(ADMIN),
      ),
    ).toBeNull();
  });

  it("refuses a Guest", async () => {
    const { deps, repository, apartments } = setup();
    repository.seedMembership(SOCIETY, { userId: "user-guest", role: "guest" });
    const flat = apartments.seedApartment(SOCIETY, "building-1");

    const error = expectErr(
      await deleteApartment(
        deps,
        asUserId("user-guest"),
        asSocietyId(SOCIETY),
        flat.id,
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(apartments.callCount("remove")).toBe(0);
  });
});

describe("getApartment", () => {
  it("returns the flat and the capabilities derived from the membership", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1", {
      apartmentNumber: "A-101",
    });

    const view = expectOk(
      await getApartment(deps, asUserId(ADMIN), asSocietyId(SOCIETY), flat.id),
    );

    expect(view.apartment.id).toBe(flat.id);
    expect(view.capabilities).toEqual({ canManage: true, canView: true });
  });

  it("answers not_found for a caller with no membership", async () => {
    const { deps, apartments } = setup();
    const flat = apartments.seedApartment(SOCIETY, "building-1");

    const error = expectErr(
      await getApartment(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        flat.id,
      ),
    );

    expect(error.code).toBe("not_found");
  });

  it("answers not_found for an apartment id that does not exist", async () => {
    const { deps } = setup();

    const error = expectErr(
      await getApartment(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asApartmentId("00000000-0000-4000-8000-000000000000"),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});

describe("listApartments", () => {
  it("returns one building's flats in floor then number order", async () => {
    const { deps, apartments, repository } = setup();
    const other = repository.seedBuilding(SOCIETY, { name: "Block B" });
    // Seeded out of order on purpose.
    apartments.seedApartment(SOCIETY, "building-1", {
      apartmentNumber: "A-201",
      floor: 2,
    });
    apartments.seedApartment(SOCIETY, "building-1", {
      apartmentNumber: "A-102",
      floor: 1,
    });
    apartments.seedApartment(SOCIETY, "building-1", {
      apartmentNumber: "A-101",
      floor: 1,
    });
    apartments.seedApartment(SOCIETY, other.id, {
      apartmentNumber: "B-101",
      floor: 1,
    });

    const list = expectOk(
      await listApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asBuildingId("building-1"),
      ),
    );

    expect(list.apartments.map((flat) => flat.apartmentNumber)).toEqual([
      "A-101",
      "A-102",
      "A-201",
    ]);
  });

  it("returns an empty list with canManage — a new building is not an error", async () => {
    const { deps, repository } = setup();
    const empty = repository.seedBuilding(SOCIETY, { name: "Block C" });

    const list = expectOk(
      await listApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        empty.id,
      ),
    );

    expect(list.apartments).toEqual([]);
    expect(list.capabilities.canManage).toBe(true);
  });

  it("refuses a Guest rather than handing back an empty list", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, { userId: "user-guest", role: "guest" });

    const error = expectErr(
      await listApartments(
        deps,
        asUserId("user-guest"),
        asSocietyId(SOCIETY),
        asBuildingId("building-1"),
      ),
    );

    // "None yet" and "not for you" must not be the same screen.
    expect(error.code).toBe("forbidden");
  });

  it("answers not_found for a caller with no membership", async () => {
    const { deps } = setup();

    const error = expectErr(
      await listApartments(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        asBuildingId("building-1"),
      ),
    );

    expect(error.code).toBe("not_found");
  });

  it("answers not_found for a building in another society, rather than an empty list", async () => {
    const { deps, repository } = setup();
    const foreign = repository.seedBuilding("society-2", { name: "Theirs" });

    const error = expectErr(
      await listApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        foreign.id,
      ),
    );

    // The building is loaded, not just the caller's membership: an id from another
    // society must be indistinguishable from one that does not exist (PRD T041),
    // and `[]` would have been a distinguishable answer — "that building, no
    // flats" — for structure the caller cannot see.
    expect(error.code).toBe("not_found");
  });

  it("answers not_found for a building that was removed", async () => {
    const { deps, repository } = setup();
    const removed = repository.seedBuilding(SOCIETY, {
      id: "building-removed",
      name: "Gone",
    });
    // Soft-deleted, as `deleteBuilding` would leave it — and the repository is what
    // filters it (`WHERE deleted_at IS NULL`), so the use case does not need a rule
    // of its own for a removed parent.
    await repository.remove(removed.id, asSocietyId(SOCIETY), asUserId(ADMIN));

    const error = expectErr(
      await listApartments(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        removed.id,
      ),
    );

    expect(error.code).toBe("not_found");
  });
});
