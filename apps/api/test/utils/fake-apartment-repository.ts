import { randomUUID } from "node:crypto";

import {
  StructureError,
  asApartmentId,
  asBuildingId,
  asSocietyId,
  asWingId,
  compareApartments,
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

/**
 * An in-memory `ApartmentRepository` for HTTP-level tests.
 *
 * The same design as `fake-building-repository.ts`, and the same warning applies:
 * nothing here evaluates a policy, so a mistake in the committed SQL is invisible
 * to these tests. `scripts/db/rls-canary.sql` is what covers that.
 *
 * What is faked: the *storage*, the *tenancy check*, and the two database facts a
 * caller is allowed to rely on —
 *
 *  - `uq_apartments_building_number`: the flat number is unique among the
 *    **live** flats of one **building**, so a number used and then removed is free
 *    again, and the same number in a different building is a different flat. The
 *    violation is raised exactly as the adapter classifies it (a `conflict`
 *    carrying `field: 'apartmentNumber'`), because that classification is part of
 *    what the HTTP layer is under test for.
 *  - `update` distinguishes absent (`undefined` = unchanged) from `null` (= clear),
 *    which is the flat's defining rule and the one a careless fake — spreading the
 *    patch over the row — would erase while appearing to work.
 *
 * It deliberately does **not** enforce the Admin role, the capability rules or any
 * value range. Those are what the guard chain, the use cases and the domain's value
 * objects are under test for, and a fake that enforced them too would let a broken
 * one pass.
 */

export interface FakeApartmentRepository extends ApartmentRepository {
  readonly state: {
    readonly apartments: Map<string, Apartment>;
    readonly calls: string[];
  };
  /** Inserts a flat out of band, bypassing every rule. */
  seed(
    societyId: string,
    buildingId: string,
    spec?: {
      readonly id?: string;
      readonly apartmentNumber?: string;
      readonly floor?: number | null;
      readonly deleted?: boolean;
    },
  ): Apartment;
}

const NOW = "2026-09-24T10:00:00.000Z";

export function createFakeApartmentRepository(): FakeApartmentRepository {
  const apartments = new Map<string, Apartment>();
  const calls: string[] = [];
  let sequence = 0;

  function seed(
    societyId: string,
    buildingId: string,
    spec: {
      readonly id?: string;
      readonly apartmentNumber?: string;
      readonly floor?: number | null;
      readonly deleted?: boolean;
    } = {},
  ): Apartment {
    sequence += 1;
    const apartment: Apartment = {
      id: asApartmentId(spec.id ?? randomUUID()),
      societyId: asSocietyId(societyId),
      buildingId: asBuildingId(buildingId),
      wingId: null,
      apartmentNumber: spec.apartmentNumber ?? `A-${sequence}`,
      floor: spec.floor ?? null,
      bhk: null,
      carpetAreaSqft: null,
      builtupAreaSqft: null,
      parkingSlots: 0,
      shareUnits: 1,
      occupancyStatus: "vacant",
      isCommercial: false,
      isBillable: true,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: spec.deleted === true ? NOW : null,
    };
    apartments.set(apartment.id, apartment);
    return apartment;
  }

  /**
   * The row a soft-deleted flat would be: present in storage, absent from every
   * read. Reproduced rather than removed from the map because that is the whole
   * point of the delete being soft — a reader that forgot `deleted_at IS NULL` has
   * to be the thing that fails, not the fixture.
   */
  const live = (apartment: Apartment | undefined): Apartment | undefined =>
    apartment === undefined || apartment.deletedAt !== null
      ? undefined
      : apartment;

  /** `uq_apartments_building_number`, over live rows only, with `exceptId`. */
  const assertNumberFree = (
    societyId: SocietyId,
    buildingId: BuildingId,
    apartmentNumber: string,
    exceptId?: string,
  ): void => {
    const taken = [...apartments.values()].some(
      (apartment) =>
        apartment.societyId === societyId &&
        apartment.buildingId === buildingId &&
        apartment.deletedAt === null &&
        apartment.id !== exceptId &&
        apartment.apartmentNumber.toLowerCase() ===
          apartmentNumber.toLowerCase(),
    );
    if (taken) {
      throw new StructureError(
        "conflict",
        "A flat with that number already exists in this building.",
        { field: "apartmentNumber" },
      );
    }
  };

  return {
    state: { apartments, calls },
    seed,

    async listApartments(
      buildingId: BuildingId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<readonly Apartment[]> {
      calls.push("listApartments");
      return [...apartments.values()]
        .filter(
          (apartment) =>
            apartment.societyId === societyId &&
            apartment.buildingId === buildingId &&
            apartment.deletedAt === null,
        )
        .sort(compareApartments);
    },

    async findApartment(
      id: ApartmentId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<Apartment | null> {
      calls.push("findApartment");
      const apartment = live(apartments.get(id));
      if (apartment === undefined || apartment.societyId !== societyId) {
        return null;
      }
      return apartment;
    },

    async create(
      buildingId: BuildingId,
      societyId: SocietyId,
      input: CreateApartmentInput,
      _actor: UserId,
    ): Promise<Apartment> {
      calls.push("create");
      assertNumberFree(societyId, buildingId, input.apartmentNumber);

      const apartment = seed(societyId, buildingId, {
        apartmentNumber: input.apartmentNumber,
        floor: input.floor ?? null,
      });
      // The remaining fields come from the *input* rather than from `seed`'s
      // defaults, so a test asserting "the defaults the database would have applied"
      // is asserting them from the payload the use case actually sent.
      const stored: Apartment = {
        ...apartment,
        wingId: input.wingId == null ? null : asWingId(input.wingId),
        bhk: input.bhk ?? null,
        carpetAreaSqft: input.carpetAreaSqft ?? null,
        builtupAreaSqft: input.builtupAreaSqft ?? null,
        parkingSlots: input.parkingSlots ?? 0,
        shareUnits: input.shareUnits ?? 1,
        occupancyStatus: input.occupancyStatus ?? "vacant",
        isCommercial: input.isCommercial ?? false,
        isBillable: input.isBillable ?? true,
      };
      apartments.set(stored.id, stored);
      return stored;
    },

    async update(
      id: ApartmentId,
      societyId: SocietyId,
      input: UpdateApartmentInput,
      _actor: UserId,
    ): Promise<Apartment> {
      calls.push("update");
      const current = live(apartments.get(id));
      if (current === undefined || current.societyId !== societyId) {
        throw new StructureError(
          "not_found",
          "That flat is not available to you.",
        );
      }

      if (input.apartmentNumber !== undefined) {
        assertNumberFree(
          societyId,
          current.buildingId,
          input.apartmentNumber,
          id,
        );
      }

      // Field by field: an absent key leaves the stored value untouched, and an
      // explicit `null` clears it.
      const patched = <TValue>(
        sent: TValue | undefined,
        stored: TValue,
      ): TValue => (sent === undefined ? stored : sent);

      const next: Apartment = {
        ...current,
        apartmentNumber: patched(
          input.apartmentNumber,
          current.apartmentNumber,
        ),
        wingId:
          input.wingId === undefined
            ? current.wingId
            : input.wingId === null
              ? null
              : asWingId(input.wingId),
        floor: patched(input.floor, current.floor),
        bhk: patched(input.bhk, current.bhk),
        carpetAreaSqft: patched(input.carpetAreaSqft, current.carpetAreaSqft),
        builtupAreaSqft: patched(
          input.builtupAreaSqft,
          current.builtupAreaSqft,
        ),
        parkingSlots: patched(input.parkingSlots, current.parkingSlots),
        shareUnits: patched(input.shareUnits, current.shareUnits),
        occupancyStatus: patched(
          input.occupancyStatus,
          current.occupancyStatus,
        ),
        isCommercial: patched(input.isCommercial, current.isCommercial),
        isBillable: patched(input.isBillable, current.isBillable),
        updatedAt: NOW,
      };
      apartments.set(id, next);
      return next;
    },

    async remove(
      id: ApartmentId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<void> {
      calls.push("remove");
      const current = live(apartments.get(id));
      if (current === undefined || current.societyId !== societyId) {
        throw new StructureError(
          "not_found",
          "That flat is not available to you.",
        );
      }
      apartments.set(id, { ...current, deletedAt: NOW });
    },

    async countForBuilding(
      buildingId: BuildingId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<number> {
      calls.push("countForBuilding");
      return [...apartments.values()].filter(
        (apartment) =>
          apartment.societyId === societyId &&
          apartment.buildingId === buildingId &&
          apartment.deletedAt === null,
      ).length;
    },
  };
}
