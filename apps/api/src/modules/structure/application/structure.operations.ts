import { Inject, Injectable } from "@nestjs/common";
import {
  bulkCreateApartments,
  createApartment,
  createBuilding,
  deleteApartment,
  deleteBuilding,
  generateApartments,
  getApartment,
  getBuilding,
  listApartments,
  listBuildings,
  updateApartment,
  updateBuilding,
} from "@ses/application";
import type {
  ApartmentList,
  ApartmentView,
  BuildingList,
  BuildingView,
  BulkCreateApartmentsCommand,
  BulkCreateApartmentsResult,
  CreateApartmentCommand,
  CreateBuildingCommand,
  GenerateApartmentsCommand,
  GenerateApartmentsResult,
  StructureDeps,
  UpdateApartmentCommand,
  UpdateBuildingCommand,
} from "@ses/application";
import type {
  Apartment,
  ApartmentId,
  ApartmentRepository,
  Building,
  BuildingId,
  BuildingRepository,
  Result,
  SocietyId,
  StructureError,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../common/authorization/membership-reader";
import { toAppError } from "./structure-error.mapper";
import { APARTMENT_REPOSITORY, BUILDING_REPOSITORY } from "./structure.tokens";

/**
 * The API's view of the structure use cases — buildings and the flats inside them.
 *
 * **No business rules live here.** Every rule — the capability checks, the name
 * and floor-count value objects, "absent means unchanged", the 404-before-403
 * ordering — is already implemented in `@ses/application`, which the mobile app
 * calls too. This class does the two things that are genuinely specific to HTTP:
 *
 *  1. it supplies the dependencies (`BuildingRepository`, `ApartmentRepository`, and
 *     the membership read the capability evaluation needs) from the container
 *     rather than as values;
 *  2. it unwraps `Result` into a value or a thrown `AppError`, because a
 *     controller that had to branch on `ok` on every route would reintroduce the
 *     per-endpoint divergence the shared layer exists to prevent.
 *
 * The `(deps, actor, …) → Result` shape is what makes (1) trivial: the use cases
 * are pure functions, so there is nothing to construct per request and nothing to
 * reset between them.
 *
 * ## Why the membership reader is injected rather than the society's operations
 *
 * `SocietyOperations` exposes the profile a screen renders, which is a different
 * question from "what role does this caller hold here": that read returns the
 * society, the roster and the capabilities, and asking it for one role would make
 * every building request pay for a roster. `MEMBERSHIP_READER` is the narrow port
 * the use cases declare, and the provider behind it is still the one
 * implementation of a `members` row translation.
 */
@Injectable()
export class StructureOperations {
  constructor(
    @Inject(BUILDING_REPOSITORY)
    private readonly buildings: BuildingRepository,
    @Inject(APARTMENT_REPOSITORY)
    private readonly apartments: ApartmentRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: StructureMembershipReader,
  ) {}

  private get deps(): StructureDeps {
    return {
      buildings: this.buildings,
      apartments: this.apartments,
      memberships: this.memberships,
    };
  }

  async list(actor: UserId, societyId: SocietyId): Promise<BuildingList> {
    return unwrap(listBuildings(this.deps, actor, societyId));
  }

  async get(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
  ): Promise<BuildingView> {
    return unwrap(getBuilding(this.deps, actor, societyId, buildingId));
  }

  async create(
    actor: UserId,
    societyId: SocietyId,
    command: CreateBuildingCommand,
  ): Promise<Building> {
    return unwrap(createBuilding(this.deps, actor, societyId, command));
  }

  async update(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
    command: UpdateBuildingCommand,
  ): Promise<Building> {
    return unwrap(
      updateBuilding(this.deps, actor, societyId, buildingId, command),
    );
  }

  async remove(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
  ): Promise<void> {
    return unwrap(deleteBuilding(this.deps, actor, societyId, buildingId));
  }

  // ── flats ─────────────────────────────────────────────────────────────────

  async listApartments(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
  ): Promise<ApartmentList> {
    return unwrap(listApartments(this.deps, actor, societyId, buildingId));
  }

  async getApartment(
    actor: UserId,
    societyId: SocietyId,
    apartmentId: ApartmentId,
  ): Promise<ApartmentView> {
    return unwrap(getApartment(this.deps, actor, societyId, apartmentId));
  }

  async createApartment(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
    command: CreateApartmentCommand,
  ): Promise<Apartment> {
    return unwrap(
      createApartment(this.deps, actor, societyId, buildingId, command),
    );
  }

  async updateApartment(
    actor: UserId,
    societyId: SocietyId,
    apartmentId: ApartmentId,
    command: UpdateApartmentCommand,
  ): Promise<Apartment> {
    return unwrap(
      updateApartment(this.deps, actor, societyId, apartmentId, command),
    );
  }

  async removeApartment(
    actor: UserId,
    societyId: SocietyId,
    apartmentId: ApartmentId,
  ): Promise<void> {
    return unwrap(deleteApartment(this.deps, actor, societyId, apartmentId));
  }

  /**
   * T044: expand a numbering pattern into flats, previewing or committing.
   *
   * Like every method here it adds nothing but dependency injection and the
   * `Result` → exception conversion — the pattern grammar, the dry-run rule and
   * the skip-and-report behaviour all live in the use case the mobile client
   * shares.
   */
  async generateApartments(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
    command: GenerateApartmentsCommand,
  ): Promise<GenerateApartmentsResult> {
    return unwrap(
      generateApartments(this.deps, actor, societyId, buildingId, command),
    );
  }

  /**
   * T043: create many flats in one call, with a per-row report.
   *
   * The command carries its own `buildingId` (a paste is addressed to the
   * building it was pasted into, and the route already carries it as a path
   * parameter), so the use case is called with both — and the guard chain has
   * already verified the caller against the society the header named.
   */
  async bulkCreateApartments(
    actor: UserId,
    societyId: SocietyId,
    buildingId: BuildingId,
    command: BulkCreateApartmentsCommand,
  ): Promise<BulkCreateApartmentsResult> {
    return unwrap(
      bulkCreateApartments(this.deps, actor, societyId, buildingId, command),
    );
  }
}

/**
 * Awaits a use case and converts failure into the API's exception.
 *
 * `await` before branching, rather than `.then`, so a rejected promise (an adapter
 * throwing something the use case could not classify — the one case the use cases
 * let escape) propagates as itself and reaches the filter's `INTERNAL` path,
 * instead of being mistaken for a domain failure.
 */
async function unwrap<TValue>(
  pending: Promise<Result<TValue, StructureError>>,
): Promise<TValue> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
