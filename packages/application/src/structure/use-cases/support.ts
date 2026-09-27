import {
  asStructureError,
  err,
  evaluateStructureCapabilities,
  ok,
  structureError,
} from "@ses/domain";
import type {
  Apartment,
  ApartmentId,
  ApartmentRepository,
  Building,
  BuildingId,
  BuildingRepository,
  Result,
  SocietyId,
  SocietyMembership,
  StructureCapabilities,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";

/**
 * Use-case dependencies.
 *
 * Explicit and injected, never imported as singletons — the same property the
 * society module's `SocietyDeps` has and for the same reason: it is what makes a
 * use case a pure function of `(deps, actor, …)` and lets a unit test pass a
 * five-line fake. No DI container, no module mocking, no `jest.mock`.
 *
 * Three dependencies rather than one, because the answers come from different
 * questions and are enforced by different mechanisms: `memberships` answers "what
 * may this caller do here" (mirrored by the API's guard chain and by RLS), while
 * `buildings` and `apartments` answer "what is stored here" (mirrored by RLS
 * alone). A single port returning all of it would tie a role lookup to a structure
 * query for no gain.
 *
 * ## Why the *building* use cases depend on `apartments`
 *
 * Because a building's removal rule is a question about its children — "does this
 * building still contain flats?" — and the table being counted is `apartments`. The
 * alternative shapes are both worse: a `BuildingRepository.hasApartments()` would
 * make the building adapter read a table it does not own, and a fourth narrow port
 * would be a second way to ask one question. So the dependency is declared openly
 * and the count arrives on the port that owns the table.
 */
export interface StructureDeps {
  readonly buildings: BuildingRepository;
  readonly apartments: ApartmentRepository;
  readonly memberships: StructureMembershipReader;
}

/** Everything a use case needs to decide about one society and one caller. */
export interface StructureContext {
  /**
   * The caller's own membership. `active` is *not* guaranteed — a pending or
   * removed member reaches here so that the capability evaluation, which is the
   * single place that rule lives, decides what happens rather than the load step
   * pre-empting it with a different answer.
   */
  readonly membership: SocietyMembership;
  readonly capabilities: StructureCapabilities;
}

/**
 * Loads the caller's relationship to a society, or fails with `not_found`.
 *
 * `not_found` — never `forbidden` — when there is no membership at all: PRD T041
 * requires that a non-member cannot tell another tenant's society apart from a
 * non-existent id, and the same rule is enforced again by RLS underneath so the
 * answer is identical whichever layer refuses.
 *
 * A `removed` membership is deliberately folded into the same answer. The caller
 * once belonged and no longer does; there is no state they can act in, and
 * telling them "you were removed" from an endpoint that has nothing to do with
 * membership would be a second, weaker answer to a question the society module
 * already answers properly.
 */
export async function loadStructureContext(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<StructureContext, ReturnType<typeof asStructureError>>> {
  try {
    const membership = await deps.memberships.findMembership(societyId, actor);

    if (membership === null || membership.status === "removed") {
      return err(
        structureError("not_found", "That society is not available to you."),
      );
    }

    return ok({
      membership,
      capabilities: evaluateStructureCapabilities(membership),
    });
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}

/**
 * Turns a capability into a result. The message comes from the caller, which
 * knows which action it was attempting — so "Only a society Admin can change the
 * society structure" is attached to a write and "cannot view its structure" to a
 * read, from one evaluation of one matrix.
 */
export function requireStructureCapability(
  capabilities: StructureCapabilities,
  capability: keyof StructureCapabilities,
  reason: string,
): Result<true, ReturnType<typeof asStructureError>> {
  return capabilities[capability]
    ? ok(true)
    : err(structureError("forbidden", reason));
}

/** A loaded society context plus one building inside it. */
export interface BuildingContext extends StructureContext {
  readonly building: Building;
}

/**
 * Loads the caller's context and one building, or fails.
 *
 * The building lookup is scoped by `societyId` **and** by the caller, and a
 * building that exists but belongs to another society is reported as
 * `not_found` rather than as a permission problem — the same reason the society
 * module does: a distinguishable answer lets a caller enumerate structure they
 * cannot see.
 *
 * `deleted` buildings are absent rather than rejected, because the repository
 * filters them (`WHERE deleted_at IS NULL`): there is no state in which a
 * removed building is addressable, so there is none to report specially.
 */
export async function loadBuildingContext(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
): Promise<Result<BuildingContext, ReturnType<typeof asStructureError>>> {
  const loaded = await loadStructureContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  try {
    const building = await deps.buildings.findBuilding(
      buildingId,
      societyId,
      actor,
    );
    if (building === null) {
      return err(
        structureError("not_found", "That building is not available to you."),
      );
    }
    return ok({ ...loaded.value, building });
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}

/** A loaded society context plus one apartment inside it. */
export interface ApartmentContext extends StructureContext {
  readonly apartment: Apartment;
}

/**
 * Loads the caller's context and one apartment, or fails.
 *
 * The same shape as `loadBuildingContext` and for the same reasons: scoped by
 * `societyId` **and** by the caller, with an apartment in another society reported
 * as `not_found` rather than as a permission problem, because a distinguishable
 * answer lets a caller enumerate the structure they cannot see.
 *
 * ## Why the apartment is loaded even for writes that "only" patch one field
 *
 * Because the rules need the current state. `updateApartment` validates a change
 * against the values that will survive it — the carpet/built-up ordering is a fact
 * about the *pair*, so a patch that sets only one of them has to be checked against
 * the other one as stored. Reading the row first is what makes that possible
 * without a second query, and it is also what makes "this apartment is not yours"
 * answer `not_found` before any rule mentions a field.
 */
export async function loadApartmentContext(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  apartmentId: ApartmentId,
): Promise<Result<ApartmentContext, ReturnType<typeof asStructureError>>> {
  const loaded = await loadStructureContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  try {
    const apartment = await deps.apartments.findApartment(
      apartmentId,
      societyId,
      actor,
    );
    if (apartment === null) {
      return err(
        structureError("not_found", "That flat is not available to you."),
      );
    }
    return ok({ ...loaded.value, apartment });
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
