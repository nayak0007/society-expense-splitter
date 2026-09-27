import type { Result } from "../../shared/result";
import { asApartmentId, asBuildingId, asSocietyId } from "../../shared/ids";
import type { StructureError } from "../errors";
import {
  APARTMENT_NUMBER_MAX_LENGTH,
  AREA_MAX_SQFT,
  FLOOR_MAX,
  FLOOR_MIN,
  PARKING_SLOTS_MAX,
  compareApartments,
  type Apartment,
} from "../apartment";
import {
  createApartmentNumber,
  createArea,
  createAreaPair,
  createBhk,
  createFloor,
  createOccupancyStatus,
  createParkingSlots,
  createShareUnits,
  DEFAULT_SHARE_UNITS,
} from "../apartment-value-objects";

/**
 * Apartment value objects and the read-order comparator.
 *
 * These are the first line of defence the API, the mobile form and the SQL
 * `CHECK`s all mirror, so the assertions are about the *rules* rather than about
 * the strings: that `null` and `0` are different answers for a floor, that a zero
 * area is refused although the column allows it, that a configuration in quarter
 * steps is refused rather than rounded, and that the comparator agrees with the
 * database's `COLLATE "C"` index order.
 */

function expectOk<TValue>(result: Result<TValue, StructureError>): TValue {
  if (!result.ok) {
    throw new Error(`expected success, got "${result.error.code}"`);
  }
  return result.value;
}

function expectErr(result: Result<unknown, StructureError>): StructureError {
  if (result.ok) throw new Error("expected failure");
  return result.error;
}

/** The two things an assertion here is ever about: the code and the field. */
function failureOf(result: Result<unknown, StructureError>): {
  readonly code: string;
  readonly field: unknown;
} {
  const error = expectErr(result);
  return { code: error.code, field: error.details?.field };
}

function apartment(overrides: Partial<Apartment> = {}): Apartment {
  return {
    id: asApartmentId("a1"),
    societyId: asSocietyId("s1"),
    buildingId: asBuildingId("b1"),
    wingId: null,
    apartmentNumber: "101",
    floor: null,
    bhk: null,
    carpetAreaSqft: null,
    builtupAreaSqft: null,
    parkingSlots: 0,
    shareUnits: 1,
    occupancyStatus: "vacant",
    isCommercial: false,
    isBillable: true,
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("createApartmentNumber", () => {
  it("collapses pasted whitespace", () => {
    expect(expectOk(createApartmentNumber("  A-   101 "))).toBe("A- 101");
  });

  it("preserves case and separators, because a bill prints them", () => {
    expect(expectOk(createApartmentNumber("Shop-3/B"))).toBe("Shop-3/B");
    expect(expectOk(createApartmentNumber("a-101"))).toBe("a-101");
  });

  it("refuses blank and over-long labels, naming the field", () => {
    expect(failureOf(createApartmentNumber("   "))).toEqual({
      code: "validation",
      field: "apartmentNumber",
    });
    expect(
      failureOf(
        createApartmentNumber("x".repeat(APARTMENT_NUMBER_MAX_LENGTH + 1)),
      ).field,
    ).toBe("apartmentNumber");
  });

  it("refuses control characters rather than storing pasted junk", () => {
    expect(failureOf(createApartmentNumber("A\u0000\u001f1")).field).toBe(
      "apartmentNumber",
    );
  });
});

describe("createFloor", () => {
  it("distinguishes an unrecorded floor from the ground floor", () => {
    // The distinction this entity exists to keep: `null` is "nobody wrote it down"
    // and `0` is a real floor. Collapsing them would make a ground-floor flat
    // indistinguishable from an unlabelled one in every per-floor rollup.
    expect(expectOk(createFloor(null))).toBeNull();
    expect(expectOk(createFloor(undefined))).toBeNull();
    expect(expectOk(createFloor(0))).toBe(0);
  });

  it("accepts basements and refuses a typo past the bounds", () => {
    expect(expectOk(createFloor(-2))).toBe(-2);
    expect(expectOk(createFloor(FLOOR_MIN))).toBe(FLOOR_MIN);
    expect(failureOf(createFloor(FLOOR_MAX + 1)).field).toBe("floor");
    expect(failureOf(createFloor(1.5)).field).toBe("floor");
  });
});

describe("createBhk", () => {
  it("accepts half steps and refuses anything finer", () => {
    expect(expectOk(createBhk(1.5))).toBe(1.5);
    expect(expectOk(createBhk(2))).toBe(2);
    // Refused rather than rounded: rounding would put a number on a bill that
    // contradicts the form the user filled in.
    expect(failureOf(createBhk(1.25)).field).toBe("bhk");
  });

  it("refuses zero, which is not a configuration", () => {
    expect(failureOf(createBhk(0)).field).toBe("bhk");
  });
});

describe("createArea", () => {
  it("refuses zero although the column allows it", () => {
    // The reason is arithmetic, not aesthetic: every per-sqft split (PRD §4)
    // divides by this number, so a stored zero becomes a division by zero at
    // billing time — long after the form that could have caught it.
    expect(failureOf(createArea(0, "carpetAreaSqft")).field).toBe(
      "carpetAreaSqft",
    );
    expect(failureOf(createArea(-5, "builtupAreaSqft")).field).toBe(
      "builtupAreaSqft",
    );
    expect(
      failureOf(createArea(AREA_MAX_SQFT + 1, "carpetAreaSqft")).field,
    ).toBe("carpetAreaSqft");
  });

  it("keeps an unrecorded area as null", () => {
    expect(expectOk(createArea(null, "carpetAreaSqft"))).toBeNull();
    expect(expectOk(createArea(900.5, "carpetAreaSqft"))).toBe(900.5);
  });
});

describe("createAreaPair", () => {
  it("refuses a built-up area smaller than the carpet area, on that field", () => {
    const failure = failureOf(createAreaPair(1200, 900));

    expect(failure.code).toBe("validation");
    expect(failure.field).toBe("builtupAreaSqft");
  });

  it("treats two unrecorded areas as consistent", () => {
    expect(expectOk(createAreaPair(null, null))).toBe(true);
    expect(expectOk(createAreaPair(900, null))).toBe(true);
    expect(expectOk(createAreaPair(900, 900))).toBe(true);
  });
});

describe("the bounded counts", () => {
  it("defaults parking and share units to the column's own defaults", () => {
    expect(expectOk(createParkingSlots(undefined))).toBe(0);
    expect(expectOk(createShareUnits(undefined))).toBe(DEFAULT_SHARE_UNITS);
  });

  it("accepts zero for both, because exempt is a real state", () => {
    expect(expectOk(createParkingSlots(0))).toBe(0);
    expect(expectOk(createShareUnits(0))).toBe(0);
  });

  it("refuses a count past its bound, naming the field", () => {
    expect(failureOf(createParkingSlots(PARKING_SLOTS_MAX + 1)).field).toBe(
      "parkingSlots",
    );
    expect(failureOf(createShareUnits(-1)).field).toBe("shareUnits");
  });
});

describe("createOccupancyStatus", () => {
  it("defaults to vacant and accepts every label in the enum", () => {
    expect(expectOk(createOccupancyStatus(undefined))).toBe("vacant");
    expect(expectOk(createOccupancyStatus("owner_occupied"))).toBe(
      "owner_occupied",
    );
    expect(expectOk(createOccupancyStatus("under_construction"))).toBe(
      "under_construction",
    );
  });

  it("refuses an unrecognised label with the field named", () => {
    // Rather than casting: an unknown value reaching the column would fail as a
    // `22P02` the API's classifier can only report as `unknown`.
    expect(failureOf(createOccupancyStatus("haunted")).field).toBe(
      "occupancyStatus",
    );
  });
});

describe("compareApartments", () => {
  it("orders by floor, then by flat number in code-unit order", () => {
    const flats = [
      apartment({ apartmentNumber: "A-201", floor: 2 }),
      apartment({ apartmentNumber: "A-102", floor: 1 }),
      apartment({ apartmentNumber: "A-101", floor: 1 }),
    ];

    expect(
      [...flats].sort(compareApartments).map((flat) => flat.apartmentNumber),
    ).toEqual(["A-101", "A-102", "A-201"]);
  });

  it('sorts "10" before "2", matching the index\'s COLLATE "C"', () => {
    // The point of pinning both sides to byte order: `localeCompare` is
    // locale-dependent, so a client using it would show a renumbered flat in a
    // position the server then moves it out of.
    const flats = [
      apartment({ apartmentNumber: "10", floor: 1 }),
      apartment({ apartmentNumber: "2", floor: 1 }),
    ];

    expect(
      [...flats].sort(compareApartments).map((flat) => flat.apartmentNumber),
    ).toEqual(["10", "2"]);
  });

  it("sorts an unrecorded floor last rather than first", () => {
    const flats = [
      apartment({ apartmentNumber: "A-999", floor: null }),
      apartment({ apartmentNumber: "A-101", floor: 0 }),
    ];

    expect(
      [...flats].sort(compareApartments).map((flat) => flat.apartmentNumber),
    ).toEqual(["A-101", "A-999"]);
  });
});
