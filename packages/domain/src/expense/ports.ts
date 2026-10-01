import type { ExpenseCategoryId, SocietyId, UserId } from "../shared/ids";
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
   * (T063) filters on it — that is the picker's rule, not this read's.
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
 * aggregate pure, and T063 owns the expense write path — so this port is declared at
 * its point of use and satisfied by this module's adapter, which is the only thing
 * that can read `expenses` until then. When T063 lands its repository, the token can
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
