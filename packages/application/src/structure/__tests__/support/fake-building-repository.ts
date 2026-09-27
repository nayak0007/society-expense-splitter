import {
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
  compareBuildings,
  structureError,
} from "@ses/domain";
import type {
  Building,
  BuildingId,
  BuildingRepository,
  CreateBuildingInput,
  MemberRole,
  MembershipStatus,
  OccupancyType,
  Result,
  SocietyId,
  SocietyMembership,
  StructureError,
  StructureMembershipReader,
  UpdateBuildingInput,
  UserId,
} from "@ses/domain";

/**
 * A hand-written fake of the two ports the structure use cases depend on.
 *
 * WHY A FAKE AND NOT `jest.mock`: the ports *are* the seam, so a test asserts
 * against the real call surface (`calls()`, `createInputs()`) instead of a mocked
 * module's internals. No module registry, no hoisting rules, no
 * `mockResolvedValue` chains.
 *
 * It implements **only** the storage-level facts the ports document, and
 * deliberately not the domain rules. `canManage` is what the use cases under test
 * exist to enforce; a fake that enforced it too would let a broken use case pass.
 * The two things it does reproduce are the ones the ports *promise*, and which a
 * use case is allowed to rely on:
 *
 *  - a caller with no live membership gets `null` / `not_found`, never
 *    `forbidden` — the 404-before-403 rule (PRD T041);
 *  - `update` applies a patch field by field, so an absent key leaves the stored
 *    value untouched. That is the property most worth testing and the one a
 *    careless fake gets wrong by spreading the patch over the current row.
 *
 * Every call is recorded, which is how a test proves the cheap and useful thing:
 * validation happens *before* I/O — an invalid command never reaches storage.
 */

export type RepositoryMethod =
  | "listBuildings"
  | "findBuilding"
  | "create"
  | "update"
  | "remove"
  | "findMembership";

/** Fixed, human-readable instant so timestamps in assertions are readable. */
export const TEST_NOW = "2026-09-24T10:00:00.000Z";

export interface SeedMember {
  readonly userId: string;
  readonly role: MemberRole;
  readonly status?: MembershipStatus;
  readonly occupancyType?: OccupancyType;
}

export class FakeBuildingRepository
  implements BuildingRepository, StructureMembershipReader
{
  private readonly memberships: SocietyMembership[] = [];
  private readonly buildings = new Map<BuildingId, Building>();
  private readonly created: CreateBuildingInput[] = [];
  private readonly updated: UpdateBuildingInput[] = [];
  private readonly recorded: RepositoryMethod[] = [];
  private readonly failures = new Map<RepositoryMethod, unknown>();
  private sequence = 0;

  // ── test-support surface ────────────────────────────────────────────────

  /** Insert an active member of `societyId`, bypassing every rule. */
  seedMembership(
    societyId: string,
    member: SeedMember = { userId: "user-admin", role: "admin" },
  ): SocietyMembership {
    const membership: SocietyMembership = {
      id: asMemberId(`${societyId}-member-${this.memberships.length + 1}`),
      societyId: asSocietyId(societyId),
      userId: asUserId(member.userId),
      role: member.role,
      status: member.status ?? "active",
      occupancyType: member.occupancyType ?? "owner",
      joinedAt: TEST_NOW,
    };
    this.memberships.push(membership);
    return membership;
  }

  /** Insert a building directly, as `update`/`find` fixtures. */
  seedBuilding(
    societyId: string,
    spec: {
      readonly id?: string;
      readonly name?: string;
      readonly totalFloors?: number | null;
      readonly displayOrder?: number;
    } = {},
  ): Building {
    const building = makeBuilding({
      id: asBuildingId(spec.id ?? `building-${++this.sequence}`),
      societyId: asSocietyId(societyId),
      name: spec.name ?? `Block ${this.sequence}`,
      totalFloors: spec.totalFloors ?? null,
      displayOrder: spec.displayOrder ?? 0,
    });
    this.buildings.set(building.id, building);
    return building;
  }

  calls(): readonly RepositoryMethod[] {
    return [...this.recorded];
  }

  callCount(method: RepositoryMethod): number {
    return this.recorded.filter((entry) => entry === method).length;
  }

  /** Make the next call of `method` reject — used to test error conversion. */
  failNext(method: RepositoryMethod, error: unknown): void {
    this.failures.set(method, error);
  }

  /** Every create payload handed over, so a test can assert the exact input. */
  createInputs(): readonly CreateBuildingInput[] {
    return [...this.created];
  }

  /** Every update patch handed over — the *patch*, never the merged row. */
  updatePatches(): readonly UpdateBuildingInput[] {
    return [...this.updated];
  }

  /** What is actually stored, so an assertion reads storage rather than a return. */
  stored(id: string): Building | undefined {
    return this.buildings.get(asBuildingId(id));
  }

  // ── BuildingRepository ──────────────────────────────────────────────────

  async listBuildings(
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<readonly Building[]> {
    this.record("listBuildings");
    this.throwIfQueued("listBuildings");
    return [...this.buildings.values()]
      .filter((building) => building.societyId === societyId)
      .sort(compareBuildings);
  }

  async findBuilding(
    id: BuildingId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Building | null> {
    this.record("findBuilding");
    this.throwIfQueued("findBuilding");
    const building = this.buildings.get(id);
    // Scoped by society as well as by id: a building that exists in another
    // society must be unreachable, not merely unauthorised. A soft-deleted one is
    // absent too, which is the port's documented contract (the real adapter's
    // `WHERE deleted_at IS NULL`) and the reason a removed building is `not_found`
    // rather than a special case a use case has to know about.
    if (
      building === undefined ||
      building.societyId !== societyId ||
      building.deletedAt !== null
    ) {
      return null;
    }
    return building;
  }

  async create(
    societyId: SocietyId,
    input: CreateBuildingInput,
    _actor: UserId,
  ): Promise<Building> {
    this.record("create");
    this.created.push(input);
    this.throwIfQueued("create");

    const building = makeBuilding({
      id: asBuildingId(`building-${++this.sequence}`),
      societyId,
      name: input.name,
      totalFloors: input.totalFloors ?? null,
      displayOrder: input.displayOrder ?? 0,
    });
    this.buildings.set(building.id, building);
    return building;
  }

  async update(
    id: BuildingId,
    societyId: SocietyId,
    input: UpdateBuildingInput,
    _actor: UserId,
  ): Promise<Building> {
    this.record("update");
    this.updated.push(input);
    this.throwIfQueued("update");

    const current = this.buildings.get(id);
    if (current === undefined || current.societyId !== societyId) {
      throw structureError("not_found", "Building not found.");
    }

    // Field by field: an absent key leaves the stored value untouched. Spreading
    // the patch would turn `{ displayOrder: 1 }` into a rename to `undefined`.
    const next: Building = {
      ...current,
      name: input.name ?? current.name,
      totalFloors:
        input.totalFloors === undefined
          ? current.totalFloors
          : input.totalFloors,
      displayOrder: input.displayOrder ?? current.displayOrder,
      updatedAt: TEST_NOW,
    };
    this.buildings.set(id, next);
    return next;
  }

  async remove(
    id: BuildingId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<void> {
    this.record("remove");
    this.throwIfQueued("remove");
    const current = this.buildings.get(id);
    if (current === undefined || current.societyId !== societyId) {
      throw structureError("not_found", "Building not found.");
    }
    // Soft delete, as the port documents: the row is marked, not destroyed.
    this.buildings.set(id, { ...current, deletedAt: TEST_NOW });
  }

  // ── StructureMembershipReader ───────────────────────────────────────────

  async findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null> {
    this.record("findMembership");
    this.throwIfQueued("findMembership");
    return (
      this.memberships.find(
        (membership) =>
          membership.societyId === societyId && membership.userId === actor,
      ) ?? null
    );
  }

  // ── internals ──────────────────────────────────────────────────────────

  private record(method: RepositoryMethod): void {
    this.recorded.push(method);
  }

  private throwIfQueued(method: RepositoryMethod): void {
    const failure = this.failures.get(method);
    if (failure === undefined) return;
    this.failures.delete(method);
    throw failure;
  }
}

export function makeBuilding(overrides: Partial<Building> = {}): Building {
  return {
    id: asBuildingId("building-1"),
    societyId: asSocietyId("society-1"),
    name: "Block A",
    totalFloors: null,
    displayOrder: 0,
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    deletedAt: null,
    ...overrides,
  };
}

/** Narrowing helpers, so an assertion says what it means. */
export function expectOk<TValue>(
  result: Result<TValue, StructureError>,
): TValue {
  if (!result.ok) {
    throw new Error(
      `Expected success, but it failed with "${result.error.code}": ${result.error.message}`,
    );
  }
  return result.value;
}

export function expectErr<TValue>(
  result: Result<TValue, StructureError>,
): StructureError {
  if (result.ok) {
    throw new Error("Expected failure, but the operation succeeded.");
  }
  return result.error;
}
