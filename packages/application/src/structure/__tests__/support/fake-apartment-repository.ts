import {
  asApartmentId,
  asBuildingId,
  asSocietyId,
  asWingId,
  compareApartments,
  structureError,
} from "@ses/domain";
import type {
  Apartment,
  ApartmentId,
  ApartmentRepository,
  BuildingId,
  CreateApartmentInput,
  SocietyId,
  UpdateApartmentInput,
  UserId,
} from "@ses/domain";

import { TEST_NOW } from "./fake-building-repository";

/**
 * A hand-written fake of `ApartmentRepository`.
 *
 * Same contract as `FakeBuildingRepository`, and it is worth stating what it
 * deliberately does **not** do:
 *
 *  - it does not enforce uniqueness of `apartmentNumber` within a building. That
 *    fact lives in a partial unique index and reaches the caller as a classified
 *    `conflict` from the adapter; a fake that enforced it here would let the
 *    *adapter's* classification — the thing the API tests cover — go untested while
 *    appearing green.
 *  - it does not enforce any value range. The value objects are what is under test;
 *    a fake that also validated would let a use case that skipped validation pass.
 *
 * It does reproduce the properties a use case is allowed to rely on:
 *  - an apartment is addressable only by the pair `(id, societyId)`, so one in
 *    another society is unreachable rather than unauthorised (PRD T041);
 *  - `update` distinguishes absent (`undefined` = unchanged) from `null` (= clear),
 *    which is the single rule that makes the patch API honest — spreading the patch
 *    would erase this distinction and turn `{ floor: null }` into a no-op that the
 *    tests would not catch;
 *  - reads and counts see live rows only, and `remove` is a soft delete.
 *
 * Every call is recorded, so a test can assert the cheap and useful thing:
 * validation happens before I/O.
 */

export type ApartmentRepositoryMethod =
  | "listApartments"
  | "findApartment"
  | "create"
  | "update"
  | "remove"
  | "countForBuilding";

export class FakeApartmentRepository implements ApartmentRepository {
  private readonly apartments = new Map<ApartmentId, Apartment>();
  private readonly created: CreateApartmentInput[] = [];
  private readonly updated: UpdateApartmentInput[] = [];
  private readonly recorded: ApartmentRepositoryMethod[] = [];
  private readonly failures = new Map<ApartmentRepositoryMethod, unknown>();
  private sequence = 0;

  // ── test-support surface ────────────────────────────────────────────────

  /**
   * Insert a flat directly, bypassing every rule — so a building-delete test can
   * arrange "this building still has flats" without driving the create use case.
   */
  seedApartment(
    societyId: string,
    buildingId: string,
    spec: {
      readonly id?: string;
      readonly apartmentNumber?: string;
      readonly floor?: number | null;
      readonly shareUnits?: number;
      readonly deleted?: boolean;
    } = {},
  ): Apartment {
    this.sequence += 1;
    const apartment = makeApartment({
      id: asApartmentId(spec.id ?? `apartment-${this.sequence}`),
      societyId: asSocietyId(societyId),
      buildingId: asBuildingId(buildingId),
      apartmentNumber: spec.apartmentNumber ?? `A-${this.sequence}`,
      floor: spec.floor ?? null,
      shareUnits: spec.shareUnits ?? 1,
      deletedAt: spec.deleted === true ? TEST_NOW : null,
    });
    this.apartments.set(apartment.id, apartment);
    return apartment;
  }

  calls(): readonly ApartmentRepositoryMethod[] {
    return [...this.recorded];
  }

  callCount(method: ApartmentRepositoryMethod): number {
    return this.recorded.filter((entry) => entry === method).length;
  }

  /** Make the next call of `method` reject — used to test error conversion. */
  failNext(method: ApartmentRepositoryMethod, error: unknown): void {
    this.failures.set(method, error);
  }

  createInputs(): readonly CreateApartmentInput[] {
    return [...this.created];
  }

  /** Every update patch handed over — the *patch*, never the merged row. */
  updatePatches(): readonly UpdateApartmentInput[] {
    return [...this.updated];
  }

  stored(id: string): Apartment | undefined {
    return this.apartments.get(asApartmentId(id));
  }

  /** Live flats only, as every read path sees them. */
  private live(id: ApartmentId): Apartment | undefined {
    const apartment = this.apartments.get(id);
    return apartment === undefined || apartment.deletedAt !== null
      ? undefined
      : apartment;
  }

  // ── ApartmentRepository ─────────────────────────────────────────────────

  async listApartments(
    buildingId: BuildingId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<readonly Apartment[]> {
    this.record("listApartments");
    this.throwIfQueued("listApartments");
    return [...this.apartments.values()]
      .filter(
        (apartment) =>
          apartment.societyId === societyId &&
          apartment.buildingId === buildingId &&
          apartment.deletedAt === null,
      )
      .sort(compareApartments);
  }

  async findApartment(
    id: ApartmentId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Apartment | null> {
    this.record("findApartment");
    this.throwIfQueued("findApartment");
    const apartment = this.live(id);
    if (apartment === undefined || apartment.societyId !== societyId) {
      return null;
    }
    return apartment;
  }

  async create(
    buildingId: BuildingId,
    societyId: SocietyId,
    input: CreateApartmentInput,
    _actor: UserId,
  ): Promise<Apartment> {
    this.record("create");
    this.created.push(input);
    this.throwIfQueued("create");

    const apartment = makeApartment({
      id: asApartmentId(`apartment-${++this.sequence}`),
      societyId,
      buildingId,
      apartmentNumber: input.apartmentNumber,
      wingId: input.wingId == null ? null : asWingId(input.wingId),
      floor: input.floor ?? null,
      bhk: input.bhk ?? null,
      carpetAreaSqft: input.carpetAreaSqft ?? null,
      builtupAreaSqft: input.builtupAreaSqft ?? null,
      // The column defaults, applied here as the adapter does when the use case
      // sends nothing — see the note in `createApartment` about not redefining them.
      parkingSlots: input.parkingSlots ?? 0,
      shareUnits: input.shareUnits ?? 1,
      occupancyStatus: input.occupancyStatus ?? "vacant",
      isCommercial: input.isCommercial ?? false,
      isBillable: input.isBillable ?? true,
    });
    this.apartments.set(apartment.id, apartment);
    return apartment;
  }

  async update(
    id: ApartmentId,
    societyId: SocietyId,
    input: UpdateApartmentInput,
    _actor: UserId,
  ): Promise<Apartment> {
    this.record("update");
    this.updated.push(input);
    this.throwIfQueued("update");

    const current = this.live(id);
    if (current === undefined || current.societyId !== societyId) {
      throw structureError("not_found", "That flat is not available to you.");
    }

    // One helper for the whole patch, because spelling this six times is how one
    // field ends up cleared instead of left alone.
    const patched = <TValue>(
      sent: TValue | undefined,
      stored: TValue,
    ): TValue => (sent === undefined ? stored : sent);

    const next: Apartment = {
      ...current,
      apartmentNumber: patched(input.apartmentNumber, current.apartmentNumber),
      // Spelled out rather than folded into `patched`: the input's wing is a plain
      // `string`, the stored one a branded `WingId`, and the three-way branch is the
      // same undefined/null/value rule the helper applies everywhere else.
      wingId:
        input.wingId === undefined
          ? current.wingId
          : input.wingId === null
            ? null
            : asWingId(input.wingId),
      floor: patched(input.floor, current.floor),
      bhk: patched(input.bhk, current.bhk),
      carpetAreaSqft: patched(input.carpetAreaSqft, current.carpetAreaSqft),
      builtupAreaSqft: patched(input.builtupAreaSqft, current.builtupAreaSqft),
      parkingSlots: patched(input.parkingSlots, current.parkingSlots),
      shareUnits: patched(input.shareUnits, current.shareUnits),
      occupancyStatus: patched(input.occupancyStatus, current.occupancyStatus),
      isCommercial: patched(input.isCommercial, current.isCommercial),
      isBillable: patched(input.isBillable, current.isBillable),
      updatedAt: TEST_NOW,
    };
    this.apartments.set(id, next);
    return next;
  }

  async remove(
    id: ApartmentId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<void> {
    this.record("remove");
    this.throwIfQueued("remove");
    const current = this.live(id);
    if (current === undefined || current.societyId !== societyId) {
      throw structureError("not_found", "That flat is not available to you.");
    }
    this.apartments.set(id, { ...current, deletedAt: TEST_NOW });
  }

  async countForBuilding(
    buildingId: BuildingId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<number> {
    this.record("countForBuilding");
    this.throwIfQueued("countForBuilding");
    return [...this.apartments.values()].filter(
      (apartment) =>
        apartment.societyId === societyId &&
        apartment.buildingId === buildingId &&
        apartment.deletedAt === null,
    ).length;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private record(method: ApartmentRepositoryMethod): void {
    this.recorded.push(method);
  }

  private throwIfQueued(method: ApartmentRepositoryMethod): void {
    const failure = this.failures.get(method);
    if (failure === undefined) return;
    this.failures.delete(method);
    throw failure;
  }
}

export function makeApartment(overrides: Partial<Apartment> = {}): Apartment {
  return {
    id: asApartmentId("apartment-1"),
    societyId: asSocietyId("society-1"),
    buildingId: asBuildingId("building-1"),
    wingId: null,
    apartmentNumber: "A-101",
    floor: 1,
    bhk: 2,
    carpetAreaSqft: 900,
    builtupAreaSqft: 1100,
    parkingSlots: 0,
    shareUnits: 1,
    occupancyStatus: "vacant",
    isCommercial: false,
    isBillable: true,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    deletedAt: null,
    ...overrides,
  };
}
