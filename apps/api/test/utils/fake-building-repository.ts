import { randomUUID } from "node:crypto";

import {
  StructureError,
  asBuildingId,
  asSocietyId,
  compareBuildings,
} from "@ses/domain";
import type {
  Building,
  BuildingId,
  BuildingRepository,
  CreateBuildingInput,
  SocietyId,
  UpdateBuildingInput,
  UserId,
} from "@ses/domain";

/**
 * An in-memory `BuildingRepository` for HTTP-level tests.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only the *storage* and the *tenancy check* — the two things that need a
 * Postgres connection. Everything between the request and this object runs for
 * real: the global auth guard verifies a real signature, `SocietyGuard` resolves
 * the header, `PermissionGuard` asks the domain's matrix, the Zod pipe parses the
 * real contract schema, `StructureOperations` calls the real use case, and the
 * mapper parses its output against the same contract the mobile client does. A
 * fake at *this* boundary therefore still fails when a rule regresses; a fake at
 * the controller boundary would not.
 *
 * It reproduces the two properties the port promises and a use case is allowed to
 * rely on:
 *
 *  - a building is addressable only by the pair `(building id, society id)`, so a
 *    building belonging to another society is *unreachable*, not merely
 *    unauthorised — the assertion that matters for cross-tenant isolation;
 *  - `update` applies a patch field by field, so an absent key leaves the stored
 *    value untouched.
 *
 * It reproduces `uq_buildings_society_name` as well, because a unique index is a
 * storage-level fact rather than a rule — the same choice the society fake makes
 * for `members_society_user_key`. Note *which* constraint: uniqueness is among
 * **live** buildings, so a removed name is available again, and a fake that
 * enforced it over every row would fail the one test that proves it.
 *
 * It deliberately does **not** enforce the Admin role, the capability rules or the
 * floor-count range. Those are what the guard chain, the use cases and the domain's
 * value objects are under test for, and a fake that enforced them too would let a
 * broken one pass.
 *
 * It is **not** a substitute for the RLS canary: nothing here evaluates a policy,
 * so a mistake in the committed SQL is invisible to these tests. That is the point
 * of saying so out loud.
 */

export interface FakeBuildingRepository extends BuildingRepository {
  readonly state: {
    readonly buildings: Map<string, Building>;
    readonly calls: string[];
  };
  /** Inserts a building out of band, bypassing every rule. */
  seed(
    societyId: string,
    spec?: {
      readonly id?: string;
      readonly name?: string;
      readonly totalFloors?: number | null;
      readonly displayOrder?: number;
      readonly deleted?: boolean;
    },
  ): Building;
}

const NOW = "2026-09-24T10:00:00.000Z";

export function createFakeBuildingRepository(): FakeBuildingRepository {
  const buildings = new Map<string, Building>();
  const calls: string[] = [];
  let sequence = 0;

  function seed(
    societyId: string,
    spec: {
      readonly id?: string;
      readonly name?: string;
      readonly totalFloors?: number | null;
      readonly displayOrder?: number;
      readonly deleted?: boolean;
    } = {},
  ): Building {
    sequence += 1;
    const building: Building = {
      id: asBuildingId(spec.id ?? randomUUID()),
      societyId: asSocietyId(societyId),
      name: spec.name ?? `Block ${sequence}`,
      totalFloors: spec.totalFloors ?? null,
      displayOrder: spec.displayOrder ?? 0,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: spec.deleted === true ? NOW : null,
    };
    buildings.set(building.id, building);
    return building;
  }

  /**
   * The row a soft-deleted building would be: present in storage, absent from
   * every read. Reproduced rather than removed from the map because that is the
   * whole point of the delete being soft — a reader that forgot
   * `deleted_at IS NULL` has to be the thing that fails, not the fixture.
   */
  const live = (building: Building | undefined): Building | undefined =>
    building === undefined || building.deletedAt !== null
      ? undefined
      : building;

  /**
   * `uq_buildings_society_name`, over live rows only, with `exceptId` so an update
   * can keep its own name.
   */
  const assertNameFree = (
    societyId: SocietyId,
    name: string,
    exceptId?: string,
  ): void => {
    const taken = [...buildings.values()].some(
      (building) =>
        building.societyId === societyId &&
        building.deletedAt === null &&
        building.id !== exceptId &&
        building.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      throw new StructureError(
        "conflict",
        "A building with that name already exists in this society.",
      );
    }
  };

  return {
    state: { buildings, calls },
    seed,

    async listBuildings(societyId, _actor: UserId) {
      calls.push("listBuildings");
      return [...buildings.values()]
        .filter(
          (building) =>
            building.societyId === societyId && building.deletedAt === null,
        )
        .sort(compareBuildings);
    },

    async findBuilding(
      id: BuildingId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<Building | null> {
      calls.push("findBuilding");
      const building = live(buildings.get(id));
      if (building === undefined || building.societyId !== societyId) {
        return null;
      }
      return building;
    },

    async create(
      societyId: SocietyId,
      input: CreateBuildingInput,
      _actor: UserId,
    ): Promise<Building> {
      calls.push("create");
      assertNameFree(societyId, input.name);
      const building = seed(societyId, {
        name: input.name,
        totalFloors: input.totalFloors ?? null,
        displayOrder: input.displayOrder ?? 0,
      });
      return building;
    },

    async update(
      id: BuildingId,
      societyId: SocietyId,
      input: UpdateBuildingInput,
      _actor: UserId,
    ): Promise<Building> {
      calls.push("update");
      const current = live(buildings.get(id));
      if (current === undefined || current.societyId !== societyId) {
        throw new StructureError(
          "not_found",
          "That building is not available to you.",
        );
      }

      if (input.name !== undefined) {
        assertNameFree(societyId, input.name, id);
      }

      // Field by field: an absent key leaves the stored value untouched.
      const next: Building = {
        ...current,
        name: input.name ?? current.name,
        totalFloors:
          input.totalFloors === undefined
            ? current.totalFloors
            : input.totalFloors,
        displayOrder: input.displayOrder ?? current.displayOrder,
        updatedAt: NOW,
      };
      buildings.set(id, next);
      return next;
    },

    async remove(
      id: BuildingId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<void> {
      calls.push("remove");
      const current = live(buildings.get(id));
      if (current === undefined || current.societyId !== societyId) {
        throw new StructureError(
          "not_found",
          "That building is not available to you.",
        );
      }
      buildings.set(id, { ...current, deletedAt: NOW });
    },
  };
}
