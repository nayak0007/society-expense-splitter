import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseId,
  MemberId,
  SocietyId,
  UserId,
  WingId,
} from "../shared/ids";
import type { MemberOccupancy } from "../member/member";
import type { Paise } from "../shared/money";
import type { Money, Weight } from "../shared/money.vo";
import type { PaymentSource } from "../shared/payment-sources";
import type { ApartmentBasis, SplitStrategy } from "../shared/split-vocabulary";
import type { OccupancyStatus } from "../structure/apartment";
import type { SocietyMembership } from "../society/society";

import type { Expense, ExpenseStatus } from "./expense.entity";
import type {
  CreateExpenseCategoryInput,
  ExpenseCategory,
  UpdateExpenseCategoryInput,
} from "./expense-category";
import type { ExpenseEvent } from "./events";
import type { AssignedReason } from "./split-reasons";

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

// ─────────────────────────────────────────────────────────────────────────────
// The expense draft record — Roadmap T065
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The expense form fields the aggregate deliberately does not own — T061's hand-off.
 *
 * `Expense.create()`'s docstring names these as T065's: "`vendorName`/`description`/
 * `paymentSource`/`paidByMemberId` (T065's create/update use cases own the form
 * domain)", and the split strategy/basis/config and selector live outside the
 * aggregate because their canonical vocabulary is `@ses/split-engine`'s, which
 * depends on this package — importing it here would invert the dependency.
 *
 * `splitConfig` and `participantSelector` are `unknown` on purpose: they are stored
 * `jsonb`, validated at the wire by the shared contracts and (for the selector) by
 * `createParticipantSelector` before they are written. A typed shape here would be a
 * second schema for values the domain does not interpret on this path.
 */
export interface ExpenseDraftFields {
  readonly description: string | null;
  readonly vendorName: string | null;
  readonly paymentSource: PaymentSource;
  readonly paidByMemberId: MemberId | null;
  readonly splitStrategy: SplitStrategy;
  readonly apartmentBasis: ApartmentBasis | null;
  readonly splitConfig: unknown;
  readonly participantSelector: unknown;
}

/**
 * One `expenses` row, in the expense module's own vocabulary — the projection the
 * T065 use cases read and return.
 *
 * A **projection, not a second `Expense`**: the aggregate stays the authority for the
 * lifecycle, the money and the four fields it owns, and this record pairs its values
 * with the form fields T061 assigned to the use cases. It is flat because reads need
 * one: reconstituting an aggregate requires a published row's split set to sum to its
 * amount (`Expense.reconstitute`), and the split table belongs to T066/T068 — a list
 * that joined it would be an N+1 for a fact no T065 screen shows.
 */
export interface ExpenseRecord extends ExpenseDraftFields {
  readonly id: ExpenseId;
  readonly societyId: SocietyId;
  readonly categoryId: ExpenseCategoryId;
  readonly title: string;
  readonly amount: Money;
  /** `YYYY-MM-DD` — a date, not an instant (the column is `date`). */
  readonly expenseDate: string;
  readonly createdBy: MemberId;
  readonly status: ExpenseStatus;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: MemberId | null;
  readonly voidReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What `create` writes: the aggregate plus the form fields, one draft. */
export interface CreateExpenseRecordInput {
  readonly expense: Expense;
  readonly fields: ExpenseDraftFields;
}

/**
 * What `update` writes: the **whole** post-edit row plus the version the caller
 * expected to find.
 *
 * `expense` carries the edited aggregate — its title, amount, date, category and
 * status are the values to write — and `fields` carries the merged form fields. The
 * update is one statement whose `WHERE` is `id + society_id + version =
 * expectedVersion + status IN ('draft', 'pending_approval')`: a read-then-compare
 * followed by an unconditional write is exactly the lost-update bug T065's acceptance
 * asks to prevent.
 */
export interface UpdateExpenseRecordInput {
  readonly expense: Expense;
  readonly fields: ExpenseDraftFields;
  readonly expectedVersion: number;
}

/** The stable sort tuple SAD §7.4 names: `{ expenseDate, id }`, newest first. */
export interface ExpenseCursor {
  readonly expenseDate: string;
  readonly id: ExpenseId;
}

/**
 * The filters SAD §7.5 declares, plus search and the cursor — nothing generic.
 *
 * Named parameters only: a client cannot express a predicate the schema does not
 * have. `buildingId`, `hasAttachments` and `cycleId` from the SAD's example are
 * deliberately absent because no column or table supports them yet — `expenses` has
 * no `building_id` (the PRD's building scope is stored inside `participant_selector`),
 * `cycle_id` was withheld by T060 until the cycles module exists, and attachments are
 * T071's. The contract's strict query schema refuses them by name rather than
 * ignoring them, which is what lets the gap be reported instead of silently widening
 * a list.
 */
export interface ExpenseListQuery {
  readonly categoryId?: ExpenseCategoryId | undefined;
  readonly status?: ExpenseStatus | undefined;
  /** Inclusive lower bound on `expense_date`. */
  readonly dateFrom?: string | undefined;
  /** Inclusive upper bound on `expense_date`. */
  readonly dateTo?: string | undefined;
  readonly amountPaiseMin?: Paise | undefined;
  readonly amountPaiseMax?: Paise | undefined;
  readonly createdBy?: MemberId | undefined;
  /** Full-text query over title, description and vendor (the GIN index's expression). */
  readonly search?: string | undefined;
  readonly cursor?: ExpenseCursor | undefined;
  /** Already clamped by the caller; the adapter never widens it. */
  readonly limit: number;
}

/** One page, plus the cursor for the next — `null` when this is the last page. */
export interface ExpensePage {
  readonly expenses: readonly ExpenseRecord[];
  readonly nextCursor: ExpenseCursor | null;
}

/**
 * Expense draft persistence — Roadmap T065's five operations and nothing else.
 *
 * ## Why this port exists now
 *
 * `ExpenseReferenceReader`'s docstring anticipated it: "When T065 lands its
 * repository, the token can be re-bound to it without the use case changing a line."
 * This is that repository. It is not a god-repository: `publish`, splits, dues,
 * balances and revisions are T066–T069's, and adding a method here before its task
 * would be the boundary violation those rows exist to prevent.
 *
 * ## The actor, again
 *
 * Every method takes `actor` explicitly, like every other port in this package, and
 * the implementation runs each statement inside `UnitOfWork` under that identity — so
 * RLS decides which rows exist, and a cross-society id is structurally absent rather
 * than filtered after the fact.
 *
 * ## Failure semantics are part of the contract
 *
 * `findById` answers `null`; `create` cannot fail on authorisation once the caller
 * has passed the guard chain (RLS refuses with `forbidden` when it does); `update`
 * throws `ExpenseError('version_mismatch')` carrying `currentVersion` when the row
 * moved, `not_found` when it is not there, and `invalid_transition` when it is no
 * longer editable; `deleteDraft` throws `not_found` / `forbidden` /
 * `invalid_transition` and never reports success for a row it did not remove.
 */
export interface ExpenseRepository {
  /** Insert one draft (or pending-approval) row and return what landed. */
  create(
    input: CreateExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecord>;

  /** One expense of one society, `null` when the actor may not see it. */
  findById(
    id: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseRecord | null>;

  /**
   * Write the whole post-edit row, optimistically locked on `expectedVersion`.
   *
   * Atomic in SQL: `WHERE id = ? AND society_id = ? AND version = ? AND status IN
   * ('draft', 'pending_approval')`. A caller that lost the race gets
   * `version_mismatch` with the row's **current** version, never a silent overwrite.
   */
  update(
    id: ExpenseId,
    societyId: SocietyId,
    expectedVersion: number,
    input: Omit<UpdateExpenseRecordInput, "expectedVersion">,
    actor: UserId,
  ): Promise<ExpenseRecord>;

  /** One page of the filtered list, newest first, with the next cursor. */
  list(
    societyId: SocietyId,
    query: ExpenseListQuery,
    actor: UserId,
  ): Promise<ExpensePage>;

  /**
   * Hard-delete one draft, creator only — the definer function T060 deferred.
   *
   * Not a soft delete and not a void: PRD §3.5 says "drafts can be hard-deleted by
   * their creator", the table has no delete columns, and `DELETE` is withheld at the
   * grant level — so this is the one path, enforced inside the database rather than
   * by the caller.
   */
  deleteDraft(
    id: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void>;
}

/**
 * The one `society_settings` fact the approval threshold needs — PRD §2.2's default
 * ₹10,000, `society_settings.approval_threshold_paise`.
 *
 * A port of its own rather than a widening of `ExpenseSocietyPolicy`: the two
 * readers are two questions with two owners-to-be (resolution reads vacancy policy;
 * the create/update use cases read the threshold), and widening the existing policy
 * shape would make every T063/T064 fake invent a field no resolution uses.
 */
export interface ExpenseApprovalPolicy {
  readonly settings: { readonly approvalThresholdPaise: Paise };
}

/**
 * The threshold read, satisfied **structurally** by the society module's
 * `SocietyRepositoryPostgres.findById` — the same borrow `ExpenseSocietyReader`
 * makes, so no adapter exists to drift and this module owns no SQL over
 * `society_settings`.
 *
 * `null` means "no such society, or no live membership for this caller": the two are
 * one answer for the reason the society snapshot already collapses them. A caller
 * that is an active member of the society can only reach the first case by the
 * society having been deleted between two reads.
 */
export interface ExpenseApprovalPolicyReader {
  findById(id: SocietyId, actor: UserId): Promise<ExpenseApprovalPolicy | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Publishing — Roadmap T066
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One allocation, as the publish path persists it — the `expense_splits` row's
 * writable content, in the domain's vocabulary.
 *
 * Five of its fields are the split engine's allocation verbatim (`memberId`,
 * `apartmentId`, `amount`, `weight`), because it **is** the engine's result: the
 * publish use case maps the result onto this shape and nothing here recomputes or
 * re-rounds anything (T066's acceptance: "persist exactly the allocations produced
 * by the authoritative publish calculation").
 *
 * The two fields the engine knows nothing about are the module's own:
 *
 *  - `percent` is the exact decimal string for the *percentage* strategy (its
 *    weight is basis points, hundredths of a percent, so `33.33%` is `"33.33"`),
 *    and `null` for every other strategy. It travels as text because the column is
 *    `numeric(7,4)` and a JS number would be the one float in the money's
 *    neighbourhood;
 *  - `snapshot` is PRD §7.3's "member name, flat no at publish time" — the fact
 *    that makes a rename not rewrite history. It is a value the *publish* caller
 *    supplies (from the roster as it is at publication), never one a later read
 *    reconstructs.
 *
 * `assignedReason` is `'owner_only_category'` exactly when resolution moved the
 * charge off the flat's occupant (T063) — the value `expense_splits.assigned_reason`
 * was added for.
 */
export interface PublishExpenseAllocation {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly amount: Money;
  readonly weight: Weight;
  /** `null` unless the effective strategy is `percentage`. */
  readonly percent: string | null;
  readonly assignedReason: AssignedReason | null;
  readonly snapshot: {
    readonly memberName: string;
    readonly apartmentNumber: string;
  };
}

/**
 * The facts that identify one publication attempt — what a retry has to repeat
 * exactly, and what a stored record is looked up by.
 *
 * Split out from `PublishExpenseRecordInput` because the *read* side needs it too:
 * `findPublication` answers whether this attempt already committed, and it must be
 * asked with the same three facts the write would use. Sharing the shape means a
 * caller cannot hash or key a lookup differently from the write it is looking for.
 */
export interface ExpensePublicationLookup {
  /** The version the caller believed it was publishing — the optimistic lock. */
  readonly expectedVersion: number;
  /** The `Idempotency-Key` header, opaque and already validated by the contract. */
  readonly idempotencyKey: string;
  /**
   * A hash of the request this key was used for. A second request with the same
   * key and a different hash is `idempotency_key_reuse`, never a replay.
   */
  readonly requestHash: string;
}

/** What `ExpenseSplitRepository.publish` writes, besides the transition itself. */
export interface PublishExpenseRecordInput extends ExpensePublicationLookup {
  readonly allocations: readonly PublishExpenseAllocation[];
}

/**
 * What one publication produced, read back from the rows it wrote.
 *
 * `summary` is measured over the **persisted** split rows — not over the computed
 * allocations — so a response can only describe what committed, and the
 * conservation fact a caller reads (`total`) is the database's own sum. `replayed`
 * is `true` when nothing was written at all: this response is the one an earlier
 * request with the same key produced.
 */
export interface ExpensePublication {
  readonly expense: ExpenseRecord;
  readonly summary: ExpenseSplitSummary;
  readonly replayed: boolean;
}

/** The PRD §8.3 `splitSummary`, with the conservation total alongside it. */
export interface ExpenseSplitSummary {
  readonly participantCount: number;
  readonly total: Money;
  readonly min: Money;
  readonly max: Money;
}

/**
 * The published-editable fields one recalculation may change — ADR-0009 §18.
 *
 * The type is the allow-list: `expenseDate`, `dueDate`, `categoryId`,
 * `paidByMemberId`, `paymentSource` and the lifecycle/approval fields are absent
 * by construction, and the contract + use case reject them explicitly rather
 * than dropping them. Only fields the caller actually sent are present; the
 * definer function merges them into the stored row.
 */
export interface ExpenseRecalculationFields {
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly vendorName?: string | null | undefined;
  readonly amountPaise?: bigint | undefined;
  readonly splitStrategy?: SplitStrategy | undefined;
  readonly apartmentBasis?: ApartmentBasis | null | undefined;
  readonly splitConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly participantSelector?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What `ExpenseSplitRepository.recalculate` writes — the plan plus the fields.
 *
 * No idempotency key: a published edit is an optimistic-locked PATCH keyed on
 * `expectedVersion` (T065's lock), and a retry with a stale version is refused
 * by the row lock rather than replayed. A lost response is recovered by the
 * client re-reading the expense, which the response's new version makes
 * unambiguous.
 */
export interface RecalculateExpenseRecordInput {
  /** The version the caller believed it was editing — the optimistic lock. */
  readonly expectedVersion: number;
  readonly fields: ExpenseRecalculationFields;
  readonly allocations: readonly PublishExpenseAllocation[];
  readonly changeNote?: string | null | undefined;
}

/**
 * The summary of one committed recalculation, measured from the rows it wrote.
 *
 * `totalDelta` is **signed**: a decrease is negative, an increase positive, and
 * a title-only edit is zero. `blockedByPaidSplits` is `0` on every commit that
 * succeeded — its presence is the PRD §3.5.3 field, and a non-zero value is
 * impossible because a blocked revision raises instead of returning.
 */
export interface ExpenseRecalculationSummary {
  readonly duesUpdated: number;
  readonly duesSuperseded: number;
  readonly duesCreated: number;
  readonly totalDelta: Money;
  readonly affectedMembers: number;
  readonly blockedByPaidSplits: number;
}

/** What one committed recalculation produced: the row it updated and its diff. */
export interface ExpenseRecalculation {
  readonly expense: ExpenseRecord;
  readonly summary: ExpenseRecalculationSummary;
}

/**
 * What `ExpenseSplitRepository.voidExpense` writes — T069's request, ADR-0010.
 *
 * Two facts and no more: the version the caller believed it was voiding (the
 * optimistic lock, required for the reason `RecalculateExpenseRecordInput`
 * records — a lock the caller can omit is not a lock) and the reason, already
 * trimmed and validated by `Expense.void_()`/the contract and re-validated
 * inside the definer function. No idempotency key: void has no retry record, and
 * a second attempt meets a terminal `void` expense with `invalid_transition`
 * rather than being replayed as a success.
 */
export interface VoidExpenseRecordInput {
  readonly expectedVersion: number;
  /** ≥ 10 characters after trimming, no control characters (PRD §3.5). */
  readonly reason: string;
}

/**
 * The summary of one committed void, measured from the rows it wrote.
 *
 * `creditsIssued` is the total `paid_paise` the void converted into
 * `member_balances.advance_paise` (ADR-0010 Decision 2) — a magnitude, not a
 * new obligation, and deliberately not a payment row: T069 creates the credit,
 * T079 later consumes it. `affectedMembers` counts the members whose balance
 * moved at all, including an unpaid due's `total_due` move.
 */
export interface ExpenseVoidSummary {
  readonly duesSuperseded: number;
  readonly creditsIssued: Money;
  readonly affectedMembers: number;
}

/** What one committed void produced: the row it stamped and its summary. */
export interface ExpenseVoid {
  readonly expense: ExpenseRecord;
  readonly summary: ExpenseVoidSummary;
}

/**
 * The publishing write path — Roadmap T066's `split.repository.ts`.
 *
 * ## One method, because it is one transaction
 *
 * `publish` performs the whole publication: it resolves nothing (the caller hands it
 * allocations), computes nothing (there is no arithmetic here), and writes the two
 * things that must not be separable — the expense's splits and its transition to
 * `published`. The implementation runs them inside a single `UnitOfWork`
 * transaction, with the `expense_publish()` definer function owning the transition
 * (the lifecycle stamps are not client-writable) and the API writing the
 * idempotency record in the same transaction, so a replay can only exist if the
 * bill does.
 *
 * ## Replay is decided here, not by the caller
 *
 * A matching record is answered with the stored publication and `replayed: true`
 * **without touching the expense**, which is what makes a retry safe rather than
 * merely idempotent: it does not depend on the lifecycle to refuse a second write.
 * A record whose `requestHash` differs is `idempotency_key_reuse` (409) — the key
 * names a different operation and replaying it would be a lie.
 *
 * ## Failure semantics are part of the contract
 *
 * `not_found` for an expense outside the caller's society (PRD T041); `forbidden`
 * when the caller's role cannot publish (the database's own `expense.publish`
 * check, reachable when this port is called outside the HTTP guard chain);
 * `version_mismatch` carrying the row's **current** version when it moved;
 * `invalid_transition` for a published or void expense; `split_mismatch` when the
 * allocations do not sum to the amount (the definer function's check and, at
 * COMMIT, `chk_split_total()`'s). Nothing about SQLSTATE or the driver escapes this
 * boundary.
 */
export interface ExpenseSplitRepository {
  /**
   * The publication a previous attempt with this key committed, or `null`.
   *
   * Read **before** recomputing, so a retry is answered from what already happened
   * rather than from what the current roster would produce: an idempotent replay
   * must not be able to fail for a reason the original request never met. A stored
   * record under the same key but for a different request is
   * `idempotency_key_reuse` (409) here, exactly as it is on the write path.
   */
  findPublication(
    input: ExpensePublicationLookup,
    actor: UserId,
  ): Promise<ExpensePublication | null>;

  /**
   * The whole publication, atomically, or a replay of one that already happened.
   * The transaction and its ordering are the implementation's; see the docstring.
   */
  publish(
    id: ExpenseId,
    societyId: SocietyId,
    input: PublishExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpensePublication>;

  /**
   * Revise one published expense, atomically — T068's write path, ADR-0009.
   *
   * The implementation runs the whole revision in the `expense_recalculate()`
   * definer transaction: BEFORE revision snapshot, retained dues/splits updated
   * in place, removed dues superseded (never deleted), added dues created,
   * exact balance deltas, `oldest_due_date` recomputed, and exactly one
   * `expense_revisions` row. Failure semantics are part of the contract:
   * `not_found` for an expense outside the caller's society; `forbidden` when
   * the caller's role cannot publish; `invalid_transition` when the row is not
   * `published`; `version_mismatch` carrying the row's current version;
   * `split_mismatch` when the plan does not sum to the amount; and
   * `paid_obligation` when a new obligation is below an already-verified
   * payment — the whole revision is refused and the caller is instructed to
   * issue a credit adjustment instead.
   */
  recalculate(
    id: ExpenseId,
    societyId: SocietyId,
    input: RecalculateExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecalculation>;

  /**
   * Void one published expense, atomically — T069's write path, ADR-0010.
   *
   * The implementation runs the whole reversal in the `expense_void()` definer
   * transaction: every current principal due superseded **without deleting
   * anything** (its id, amount, `paid_paise` and split link survive, and
   * `expense_splits` is not touched), exact `member_balances` deltas
   * (`total_due -= A`, `total_paid -= P`, `advance += P`, `outstanding -= A`),
   * `oldest_due_date` recomputed from the authoritative open dues, and the
   * expense stamped `status = 'void'` / `voided_at` / `voided_by` / `void_reason`
   * with its version bumped by the shared trigger. No `expense_revisions` row is
   * written: a void is not an edit.
   *
   * Failure semantics are part of the contract: `not_found` for an expense
   * outside the caller's society; `forbidden` when the caller's role cannot void;
   * `invalid_transition` when the row is not `published` (including a second
   * void); `version_mismatch` carrying the row's current version; `validation`
   * for a reason the domain refuses; and `void_due_state_unsupported` when a
   * current obligation of the expense is in a state voiding has no accounting
   * rule for — the whole void is refused and nothing is written.
   */
  voidExpense(
    id: ExpenseId,
    societyId: SocietyId,
    input: VoidExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseVoid>;
}

/**
 * One stored `expense_revisions` row — PRD §3.5.3's tap-through history.
 *
 * `version` is the pre-edit version and `snapshot` the BEFORE state the revision
 * replaced (ADR-0009 §17): the allocation-driving configuration of the expense
 * plus its authoritative splits. The snapshot travels as opaque records because
 * the history is what the row says — a client renders the same fields the live
 * expense carries, and a shape the API cannot represent should fail at the
 * boundary rather than be silently re-modelled into a different history.
 */
export interface ExpenseRevisionRecord {
  readonly id: string;
  readonly expenseId: ExpenseId;
  readonly version: number;
  readonly snapshot: {
    readonly expense: Readonly<Record<string, unknown>>;
    readonly splits: readonly Readonly<Record<string, unknown>>[];
  };
  readonly changedBy: MemberId;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

/**
 * The revision history read — T068's `revision.repository.ts`.
 *
 * A read-only port: revisions are append-only (SAD §8.1 revokes UPDATE and
 * DELETE), so the only operation is "the history of one expense". Visibility is
 * the database's (`expense_revisions_select_member` → `can_view_expenses`), so a
 * caller outside the society reads nothing; the use case answers `not_found` for
 * a foreign id before this is reached.
 */
export interface ExpenseRevisionRepository {
  /** Oldest first, so the history reads forward from the published state. */
  listForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseRevisionRecord[]>;
}

/**
 * The member display names the publish snapshot records — PRD §7.3's "member name …
 * at publish time".
 *
 * A port of its own because it is a question no other read answers: T063's
 * resolution returns *who* each charge is addressed to and never their name (the
 * engine has no use for it), and the snapshot is the one place a name is a
 * financial fact rather than a label. The implementation is this module's
 * participant adapter — the only thing in the module that already reads `members` —
 * and it performs **one bounded query** over the ids it is given, never one per
 * participant.
 *
 * A member missing from the answer is not an error here: names exist for every
 * active membership the database can hold (`members.display_name` is `NOT NULL`
 * with a non-blank `CHECK`), so a gap is a corrupt read and the caller decides what
 * to make of it. Returning what was found keeps "the roster changed underneath us"
 * distinguishable from "the read failed".
 */
export interface ExpenseMemberNameReader {
  listMemberNames(
    societyId: SocietyId,
    memberIds: readonly MemberId[],
    actor: UserId,
  ): Promise<ReadonlyMap<MemberId, string>>;
}

/**
 * Where a raised expense event goes — SAD §3.2's dispatch half.
 *
 * ## Why this port exists now, before its consumer
 *
 * T061's entity raises events and deliberately cannot dispatch them: dispatching
 * inside a transaction is the exact failure SAD §3.2 names — a push about a bill
 * whose transaction then rolls back. T066 is the first task whose acceptance
 * requires the *ordering* ("domain events enqueued and dispatched **after**
 * commit", "a failed notification never rolls back the bill"), and that ordering is
 * a property of the calling code, so it needs a seam a test can observe.
 *
 * The binding shipped today is an in-process publisher that records the event on
 * the application log; T107 replaces it with the orchestrator's queue. What must not
 * change is the contract: it is called **after** the publishing transaction has
 * returned successfully, for the *fresh* publication only (a replay announces
 * nothing — the first call already did), and its failure is caught by the use case
 * and reported rather than propagated, because a notification that cannot be sent
 * must never un-publish a bill.
 */
export interface ExpenseEventPublisher {
  /** Dispatch events after commit. Must not be called before the transaction ends. */
  dispatch(events: readonly ExpenseEvent[]): Promise<void>;
}
