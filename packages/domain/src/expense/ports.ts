import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  MemberId,
  SocietyId,
  UserId,
  WingId,
} from "../shared/ids";
import type { MemberOccupancy } from "../member/member";
import type { OccupancyStatus } from "../structure/apartment";
import type { SocietyMembership } from "../society/society";

import type {
  CreateExpenseCategoryInput,
  ExpenseCategory,
  UpdateExpenseCategoryInput,
} from "./expense-category";

/**
 * Expense-category repository port (Clean Architecture: the domain declares what it
 * needs, infrastructure implements it — SAD §3.1).
 *
 * Two properties are inherited from `BuildingRepository` and both are load-bearing:
 *
 *  - **every method takes `actor` explicitly**, so tenant scope can never come from
 *    ambient state (SAD §1.1: scope comes from the token and the membership, never
 *    from the request body);
 *  - **`societyId` is a separate argument from the category id**, because a category
 *    id alone does not say which tenant a caller is acting in. Passing both, and
 *    having the adapter verify the pair, is what makes a category from another
 *    society answer `not_found` rather than being addressable by id.
 *
 * Implementations MUST return `null`/throw `ExpenseError('not_found')` for a
 * category in a society the actor is not an active member of — never `forbidden`
 * with a distinguishable body, which would leak the existence of another tenant's
 * vocabulary (PRD T041).
 */
export interface ExpenseCategoryRepository {
  /**
   * Every live category of `societyId`, in display order.
   *
   * ## Active and inactive alike, and that is deliberate
   *
   * The list carries deactivated categories because the screen that manages them is
   * the only place one can be brought back: an active-only list would make
   * deactivation a one-way door with no UI able to undo it. It is also the honest
   * answer to "what is this society's expense vocabulary" — a category historical
   * expenses are filed under still has to render its name, and a report that
   * resolved it from a different source would be a second vocabulary.
   *
   * Nothing is lost by it: `isActive` travels on every row, and the *expense* form
   * (T065) filters on it — that is the picker's rule, not this read's.
   *
   * ## No pagination, no search, no filter
   *
   * The set is bounded by what a society can usefully maintain — nineteen seeded plus
   * however many it adds — and the PRD specifies neither pagination nor search for it
   * (contrast the expense list, PRD §714, which specifies both). A cursor here would
   * be a contract the product has not asked for, imposed on the one screen that reads
   * every row anyway.
   */
  listCategories(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseCategory[]>;

  /** One live category of one society, `null` when the actor may not see it. */
  findCategory(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCategory | null>;

  /**
   * The live category of `societyId` carrying exactly `name`, or `null`.
   *
   * ## Why this read exists as well as the unique index
   *
   * Not as the uniqueness rule — the index
   * (`uq_expense_categories_society_name … WHERE deleted_at IS NULL`) is, and a
   * concurrent creator between this read and the insert is caught by it and
   * translated to the same `conflict`. This read exists so the *ordinary* duplicate
   * answers without an exception round trip, which is what lets the refusal carry
   * `field: "name"` from the module's own vocabulary rather than from a classifier
   * reading a constraint name.
   *
   * `exceptId` is how a rename keeps its own name: the index's predicate excludes
   * the row being updated, so this read has to as well, or every unrelated edit of a
   * category whose name is unchanged would answer `conflict`.
   *
   * The comparison is **exact string**, matching the index. In particular the
   * implementation must not lower-case either side: this read's job is to agree with
   * the index, and a case-insensitive comparison here would refuse a create the
   * database would have accepted — a rule with nothing behind it, which is worse
   * than the wart it hides.
   */
  findByName(
    name: string,
    societyId: SocietyId,
    actor: UserId,
    exceptId?: ExpenseCategoryId,
  ): Promise<ExpenseCategory | null>;

  create(
    societyId: SocietyId,
    input: CreateExpenseCategoryInput,
    actor: UserId,
  ): Promise<ExpenseCategory>;

  update(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    input: UpdateExpenseCategoryInput,
    actor: UserId,
  ): Promise<ExpenseCategory>;

  /**
   * Soft delete (`deleted_at`), so the expenses filed under this category keep their
   * subject — and the name becomes available again, because the uniqueness index is
   * partial on live rows.
   *
   * The adapter's obligation includes the **reference check**: `expenses.category_id`
   * is `NOT NULL` with a composite foreign key and no cascade, and `expenses` has no
   * `deleted_at` at all (SAD §8.1 — "never deleted, voided instead"), so a category
   * any expense has ever used must refuse with `ExpenseError('category_has_expenses')`
   * rather than allowing a write that would orphan a row. Nothing may be deleted
   * here: `DELETE` is not granted on the table.
   */
  remove(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void>;
}

/**
 * How many expenses reference one category — the one tenancy read the *delete* rule
 * needs, and it is a question about `expenses` rather than about
 * `expense_categories`.
 *
 * ## Why a port of its own rather than a method on the category repository
 *
 * The same reasoning `ApartmentRepository.countForBuilding` records in this
 * codebase: the table being counted is `expenses`, so the port that owns *that* table
 * is where the count belongs. Putting it on `ExpenseCategoryRepository` would make
 * the category adapter grow a query about a table it does not own, and would tie
 * every future implementation of the category port to a schema the category module
 * does not define.
 *
 * ## Why it is declared here, and who will implement it
 *
 * Today the expenses module has no persistence — T061 deliberately kept the
 * aggregate pure, and T065/T066 own the expense write path — so this port is declared
 * at its point of use and satisfied by this module's adapter, which is the only thing
 * that can read `expenses` until then. When T065 lands its repository, the token can
 * be re-bound to it without the use case changing a line: that is the whole point of
 * declaring the narrow read rather than reaching for a table.
 *
 * A count rather than a `hasAny()`, because the number is what the refusal can be
 * made useful with ("this category is used by 3 expenses") — the same argument
 * `countForBuilding` makes. It is **advisory**: nothing branches on it beyond the
 * message, and the database's own `P0001/CATEGORY_HAS_EXPENSES` is what refuses a
 * write that raced past this read.
 *
 * Scoped by `societyId` and `actor` like every other method, so the count can only
 * ever be of expenses the caller may see.
 */
export interface ExpenseReferenceReader {
  countForCategory(
    categoryId: ExpenseCategoryId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<number>;
}

/**
 * The caller's own membership in one society — the one tenancy read the category use
 * cases need, and the exact counterpart of `StructureMembershipReader`.
 *
 * ## Why the domain declares it twice rather than one module importing the other's
 *
 * `StructureMembershipReader` has this shape already, and importing it here would be
 * the cheaper line — but it would make the expenses module depend on the *structure*
 * module's public surface for a fact that has nothing to do with buildings, which is
 * precisely the cross-feature edge SAD §18.2 forbids ("no cross-feature imports").
 * The domain is one package, so nothing would fail to compile; the cost is that
 * reviewing an expense change means reading a building file.
 *
 * The duplication is nine lines and it is *structural* rather than textual: nobody
 * implements either interface by hand. Both are satisfied by the societies module's
 * Postgres repository through the API's single `MEMBERSHIP_READER` token, so a second
 * implementation cannot exist to drift — which is the only thing that would make
 * duplicating a port dangerous.
 *
 * ## Why it returns the membership and not a role
 *
 * A role alone cannot express "there is no membership" distinctly from "the
 * membership is pending", and both must be refused differently from an active
 * member's insufficient role. Returning the membership keeps that decision in the use
 * case, where the rule is, rather than in the adapter, where only the SQL is.
 */
export interface ExpenseMembershipReader {
  /**
   * The caller's membership in `societyId`, including a `pending` or `removed` one, or
   * `null` when the caller has no row there at all.
   *
   * Deliberately returns removed memberships rather than filtering them — see
   * `StructureMembershipReader`.
   */
  findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null>;
}

/**
 * One live flat, as participant resolution sees it — Roadmap T063.
 *
 * A **projection**, not a second `Apartment` entity: the six facts the split bases read
 * (`floor`, the two areas, `bhk`, `parkingSlots`, and `shareUnits` for a shares split),
 * plus the four columns resolution filters on (`buildingId`, `wingId`,
 * `occupancyStatus`, `isBillable`). The audit columns and `deletedAt` are absent
 * because the reader returns live rows only — a resolution that could see a deleted
 * flat would have to filter it, and *where* that filter lives is the question this
 * projection answers: in the reader, once.
 *
 * `OccupancyStatus` is the domain's own union rather than a second spelling of
 * `owner_occupied | rented | vacant | under_construction`, so the selector's
 * validation and the column's values cannot drift.
 */
export interface ParticipantApartment {
  readonly id: ApartmentId;
  readonly buildingId: BuildingId;
  readonly wingId: WingId | null;
  readonly apartmentNumber: string;
  readonly floor: number | null;
  readonly bhk: number | null;
  readonly carpetAreaSqft: number | null;
  readonly builtupAreaSqft: number | null;
  readonly parkingSlots: number;
  readonly shareUnits: number;
  readonly occupancyStatus: OccupancyStatus;
  readonly isBillable: boolean;
}

/**
 * One **active** membership attached to a flat — who a charge may be addressed to.
 *
 * `apartmentId` is non-nullable here although the column is nullable: a member with no
 * flat (an admin recorded before a flat was assigned, or a society-level officer) is
 * not a billing participant, so the reader leaves them out and this projection says so
 * in its type.
 *
 * `status` is absent for the same reason the flat's `deletedAt` is: the reader returns
 * active memberships only. A `pending` member is not somebody a society may bill —
 * they have not been admitted — and a flat whose only member is pending therefore
 * resolves as flagged-unassigned rather than as a charge to a stranger. That is a fact
 * the integration suite asserts against real RLS, because it is the reader's SQL and
 * not the domain's rule.
 */
export interface ParticipantMember {
  readonly id: MemberId;
  readonly apartmentId: ApartmentId;
  readonly occupancy: MemberOccupancy;
  readonly isPrimary: boolean;
}

/**
 * One wing of the society, so a selector's `wings: ["A"]` can be resolved to ids.
 *
 * The PRD's selector names wings by **label** and `apartments.wing_id` is a uuid, so
 * somebody has to map the two. Nothing in the API module reads the `wings` table today
 * (the structure module exposes `wingId` on a flat and the generator accepts wing
 * labels as input, but no read returns a wing's name), which is why the mapping is part
 * of this reader rather than a call into an existing one.
 */
export interface ParticipantWing {
  readonly id: WingId;
  readonly buildingId: BuildingId;
  readonly name: string;
}

/** The whole society, as one resolution needs it. */
export interface SocietyParticipantDirectory {
  /** Live flats, unfiltered: the selector decides eligibility, not the reader. */
  readonly apartments: readonly ParticipantApartment[];
  /** Active memberships attached to a flat. */
  readonly members: readonly ParticipantMember[];
  readonly wings: readonly ParticipantWing[];
  /**
   * Live buildings, ids only.
   *
   * They are here for one rule: a selector that names a building this society does not
   * have must be refused rather than silently matching nothing (which would bill the
   * whole society when the treasurer meant one building). A building with no flats yet
   * is still a building, so this cannot be derived from `apartments`.
   */
  readonly buildings: readonly BuildingId[];
}

/**
 * The society's billing roster, read in one transaction under the caller's RLS
 * identity — the focused read port T063 declares.
 *
 * ## Why a focused port rather than the existing directory reads
 *
 * Resolution needs *every* eligible flat with its members, and the established ports
 * answer that question awkwardly in three different ways:
 *
 *  - `ApartmentRepository.listApartments` is addressed **per building**, so a
 *    society-wide resolution is one query per building — the fan-out
 *    `ImportFlatReaderService` accepts for a one-time import, on a path a preview
 *    endpoint (T064) calls while a treasurer drags a slider;
 *  - `MemberRepository.list` is the **directory**: paginated
 *    (`MAX_MEMBER_PAGE_LIMIT` 200), consent-filtered, and shaped for a screen that
 *    scrolls — reading the roster to bill it would be a loop over pages whose last
 *    page is what decides whether the resolution is complete;
 *  - nothing reads `wings` at all (see `ParticipantWing`).
 *
 * What the port guarantees instead is the shape a resolution needs: **bounded,
 * set-based reads** — one query per table, whatever the society's size — scoped by
 * `societyId` **and** run as the caller, so another tenant's rows are structurally
 * absent rather than filtered afterwards (the PRD T041 rule).
 *
 * It performs no writes and no arithmetic: the reader returns facts, and
 * `resolveExpenseParticipants` decides who is billed.
 */
export interface ExpenseParticipantReader {
  listSocietyParticipants(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyParticipantDirectory>;
}

/**
 * The one piece of a society's policy participant resolution reads: whether empty flats
 * are billed (`society_settings.bill_vacant_flats`, PRD §3.3).
 *
 * A named shape with one field rather than `SocietySettings`, which says exactly what
 * this module depends on: a resolution cannot silently start reading a society's billing
 * day or its late-fee rule, and a fake does not have to invent fifteen fields to answer
 * one question.
 */
export interface ExpenseSocietyPolicy {
  readonly settings: { readonly billVacantFlats: boolean };
}

/**
 * The society-policy read, satisfied by the society module's own repository.
 *
 * Narrow rather than a `SocietyRepository` dependency, and satisfied **structurally** by
 * `SocietyRepositoryPostgres.findById` — the same move `ImportApartmentReader` and
 * `StructureMembershipReader` make: the interface is declared in the module that needs
 * it, the implementation stays in the module that owns the table, and there is no second
 * reader of `society_settings` to drift. The expenses module does not accept the switch
 * from a request either: a society's policy about billing empty flats is not something a
 * client gets to assert.
 *
 * `null` means "no such society, or no live membership for this caller" — the two are
 * deliberately one answer (`society_snapshot()` already collapses them), and a caller
 * that is a member of the society can only reach the first case by the society having
 * been deleted between two reads.
 */
export interface ExpenseSocietyReader {
  findById(id: SocietyId, actor: UserId): Promise<ExpenseSocietyPolicy | null>;
}
