import type { ApartmentId, BuildingId, SocietyId, UserId } from "../shared/ids";
import type { SocietyMembership } from "../society/society";

import type {
  Apartment,
  CreateApartmentInput,
  UpdateApartmentInput,
} from "./apartment";
import type {
  Building,
  CreateBuildingInput,
  UpdateBuildingInput,
} from "./building";

/**
 * Building repository port (Clean Architecture: the domain declares what it
 * needs, infrastructure implements it — SAD §3.1).
 *
 * Two properties are inherited from `SocietyRepository`, and both are load-bearing:
 *
 *  - **every method takes `actor` explicitly**, so tenant scope can never come
 *    from ambient state (SAD §1.1: scope comes from the token and the membership,
 *    never from the request body);
 *  - **`societyId` is a separate argument from the building id**, because a
 *    building id alone does not say which tenant a caller is acting in. Passing
 *    both, and having the adapter verify the pair, is what makes a building from
 *    another society answer `not_found` rather than being reachable by id.
 *
 * Implementations MUST return `null`/throw `StructureError('not_found')` for a
 * building in a society the actor is not an active member of — never `forbidden`
 * with a distinguishable body, which would leak the existence of another tenant's
 * structure (PRD T041).
 */
export interface BuildingRepository {
  /** Every live building of `societyId`, in display order. */
  listBuildings(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly Building[]>;

  /** One live building of one society, `null` when the actor may not see it. */
  findBuilding(
    id: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Building | null>;

  create(
    societyId: SocietyId,
    input: CreateBuildingInput,
    actor: UserId,
  ): Promise<Building>;

  update(
    id: BuildingId,
    societyId: SocietyId,
    input: UpdateBuildingInput,
    actor: UserId,
  ): Promise<Building>;

  /** Soft delete (`deleted_at`), so apartments and history keep their parent. */
  remove(id: BuildingId, societyId: SocietyId, actor: UserId): Promise<void>;
}

/**
 * The caller's own membership in one society — the one tenancy read the structure
 * use cases need.
 *
 * ## Why a narrow port rather than the society module's repository
 *
 * `SocietyRepository.listSocietyMemberships` answers this, but it answers it by
 * returning a **roster**: every membership of the society, which the caller then
 * searches for their own row. For a 400-flat society that is 400 rows read to
 * learn one role, on every building request. The structure module needs the
 * caller's role and nothing else, so it declares exactly that — the same move
 * `SocietyAuthorizationReader` makes in the API, where a narrow read is expressed
 * as a port at the point of use.
 *
 * ## Who implements it, and why that is not the structure module
 *
 * The adapter is the **society** module's Postgres repository (`findMembership`),
 * because that is where a `members` row is translated into a `SocietyMembership`
 * — the role/status/occupancy navigation tables and the soft-delete filtering
 * live there and in one place only. A second implementation inside the building
 * module would be a third copy of that translation (the mobile Supabase adapter
 * being the second, and the one with a planned end of life), and the failure mode
 * of a drifted copy is silent: a role that maps to `guest` in one and `admin` in
 * the other.
 *
 * So the interface is declared here, in the module that *needs* it, and satisfied
 * by the module that already owns the data — a normal shape for a port. The API
 * wires the two together through `SocietiesModule`'s public surface, which is the
 * only way SAD §1.2 allows one module to reach another.
 *
 * ## Why it is not a `getRole()` returning a string
 *
 * A role alone cannot express *"there is no membership"* distinctly from *"the
 * membership is pending"*, and both of those must be refused with a different
 * status than an active member's insufficient role. Returning the membership
 * keeps that decision in the use case, where the rule is, rather than in the
 * adapter, where only the SQL is.
 */
export interface StructureMembershipReader {
  /**
   * The caller's membership in `societyId`, including a `pending` or `removed`
   * one, or `null` when the caller has no row there at all.
   *
   * Deliberately returns `removed` memberships rather than filtering them: the
   * caller must be told "you are not a member" (`not_found`) for a removed
   * membership exactly as for no row, and collapsing the two here would move that
   * rule into every adapter.
   */
  findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null>;
}

/**
 * Apartment repository port.
 *
 * The same two properties `BuildingRepository` inherits, and they matter more here
 * because this is the table members will attach to (PRD §3.2: a membership names
 * an apartment):
 *
 *  - **every method takes `actor` explicitly**, so tenant scope can never come from
 *    ambient state;
 *  - **`buildingId` is a separate argument from the apartment id** wherever both
 *    are known, because a flat is addressed inside a building — and a repository
 *    that took only an apartment id would have to discover the building, which is
 *    the join that makes a cross-building reference look like a plain read.
 *
 * Implementations MUST answer `null` / throw `StructureError('not_found')` for an
 * apartment in a society the actor is not an active member of, never
 * `forbidden` with a distinguishable body (PRD T041).
 */
export interface ApartmentRepository {
  /** Every live flat of `buildingId`, in floor then flat-number order. */
  listApartments(
    buildingId: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly Apartment[]>;

  /**
   * One live flat, `null` when the actor may not see it.
   *
   * No `buildingId`: the caller knows the flat's id from the route, and the row's
   * own `buildingId` is what a screen displays. Requiring the parent here would
   * make the read fail for a caller who has the right id but the wrong building,
   * which is a distinction the API turns into a `404` anyway — so the narrower
   * signature is the honest one, and the repository still scopes by society.
   */
  findApartment(
    id: ApartmentId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Apartment | null>;

  create(
    buildingId: BuildingId,
    societyId: SocietyId,
    input: CreateApartmentInput,
    actor: UserId,
  ): Promise<Apartment>;

  update(
    id: ApartmentId,
    societyId: SocietyId,
    input: UpdateApartmentInput,
    actor: UserId,
  ): Promise<Apartment>;

  /** Soft delete (`deleted_at`), so members, dues and readings keep their subject. */
  remove(id: ApartmentId, societyId: SocietyId, actor: UserId): Promise<void>;

  /**
   * How many live flats this building has.
   *
   * A count rather than a `hasAny()`, because the number is what the refusal can
   * be made useful with ("this building still has 12 flats"), and a boolean would
   * have to be turned back into one by a caller that wanted to say so. It is also
   * the query the *building* delete rule needs, which is why it lives on this port
   * rather than on `BuildingRepository`: the table being counted is this one, and a
   * building adapter counting apartments would be a repository reading a table it
   * does not own.
   *
   * Scoped by `societyId` and `actor` like every other method, so the count is the
   * count the caller may see — never a global one.
   */
  countForBuilding(
    buildingId: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<number>;
}
