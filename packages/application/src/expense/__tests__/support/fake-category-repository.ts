import {
  asExpenseCategoryId,
  asMemberId,
  asSocietyId,
  asUserId,
  compareExpenseCategories,
  expenseError,
} from "@ses/domain";
import type {
  CreateExpenseCategoryInput,
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseMembershipReader,
  ExpenseReferenceReader,
  MemberRole,
  MembershipStatus,
  OccupancyType,
  Result,
  SocietyId,
  SocietyMembership,
  UpdateExpenseCategoryInput,
  UserId,
} from "@ses/domain";

/**
 * A hand-written fake of the three ports the category use cases depend on.
 *
 * WHY A FAKE AND NOT `jest.mock`: the ports *are* the seam, so a test asserts against
 * the real call surface (`calls()`, `updatePatches()`) instead of a mocked module's
 * internals. No module registry, no hoisting rules, no `mockResolvedValue` chains.
 *
 * It implements **only** the storage-level facts the ports document, and deliberately
 * not the domain rules. `canManage` is what the use cases under test exist to enforce; a
 * fake that enforced it too would let a broken use case pass. The four things it does
 * reproduce are the ones a port *promises*, and which a use case is therefore allowed to
 * rely on:
 *
 *  - a caller with no live membership gets `null` / `not_found`, never `forbidden` — the
 *    404-before-403 rule (PRD T041);
 *  - a category is addressable only by the pair `(id, societyId)`, so a row in another
 *    society is *unreachable* rather than merely unauthorised — the cross-tenant
 *    assertion that matters;
 *  - `findByName` compares the stored text **exactly**, over **live rows of one
 *    society**, excluding the row being updated — which is precisely the partial unique
 *    index's predicate. A fake that lower-cased would pass a test the database would
 *    fail, which is the one way this fake could actively mislead;
 *  - `update` applies a patch field by field, so an absent key leaves the stored value
 *    untouched and an explicit `null` clears a nullable column. Spreading the patch
 *    would turn `{ isActive: false }` into a rename to `undefined`.
 *
 * It is **not** a substitute for the RLS canary or the integration suite: nothing here
 * evaluates a policy, so a mistake in the committed SQL is invisible to these tests.
 */

export type RepositoryMethod =
  | "listCategories"
  | "findCategory"
  | "findByName"
  | "create"
  | "update"
  | "remove"
  | "countForCategory"
  | "findMembership";

/** Fixed, human-readable instant so timestamps in assertions are readable. */
export const TEST_NOW = "2026-09-24T10:00:00.000Z";

export interface SeedMember {
  readonly userId: string;
  readonly role: MemberRole;
  readonly status?: MembershipStatus;
  readonly occupancyType?: OccupancyType;
}

export class FakeExpenseCategoryRepository
  implements
    ExpenseCategoryRepository,
    ExpenseReferenceReader,
    ExpenseMembershipReader
{
  private readonly memberships: SocietyMembership[] = [];
  private readonly categories = new Map<ExpenseCategoryId, ExpenseCategory>();
  /** category id → how many expenses reference it. */
  private readonly references = new Map<string, number>();
  private readonly created: CreateExpenseCategoryInput[] = [];
  private readonly updated: UpdateExpenseCategoryInput[] = [];
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

  /** Insert a category directly, as `update`/`find` fixtures. */
  seedCategory(
    societyId: string,
    spec: {
      readonly id?: string;
      readonly name?: string;
      readonly displayOrder?: number;
      readonly isActive?: boolean;
      readonly deleted?: boolean;
      readonly defaultSplitStrategy?: ExpenseCategory["defaultSplitStrategy"];
      readonly defaultApartmentBasis?: ExpenseCategory["defaultApartmentBasis"];
    } = {},
  ): ExpenseCategory {
    this.sequence += 1;
    const category: ExpenseCategory = {
      id: asExpenseCategoryId(spec.id ?? `category-${this.sequence}`),
      societyId: asSocietyId(societyId),
      name: spec.name ?? `Category ${this.sequence}`,
      icon: null,
      color: null,
      defaultSplitStrategy: spec.defaultSplitStrategy ?? "equal",
      defaultApartmentBasis: spec.defaultApartmentBasis ?? null,
      isOwnerOnly: false,
      isCapital: false,
      gstApplicable: false,
      isActive: spec.isActive ?? true,
      displayOrder: spec.displayOrder ?? 0,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      deletedAt: spec.deleted === true ? TEST_NOW : null,
    };
    this.categories.set(category.id, category);
    return category;
  }

  /** How many expenses reference this category — the delete rule's input. */
  setReferenceCount(categoryId: string, count: number): void {
    this.references.set(categoryId, count);
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
  createInputs(): readonly CreateExpenseCategoryInput[] {
    return [...this.created];
  }

  /** Every update patch handed over — the *patch*, never the merged row. */
  updatePatches(): readonly UpdateExpenseCategoryInput[] {
    return [...this.updated];
  }

  /** What is actually stored, so an assertion reads storage rather than a return. */
  stored(id: string): ExpenseCategory | undefined {
    return this.categories.get(asExpenseCategoryId(id));
  }

  // ── ExpenseCategoryRepository ───────────────────────────────────────────

  async listCategories(
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<readonly ExpenseCategory[]> {
    this.record("listCategories");
    this.throwIfQueued("listCategories");
    // Live rows of one society, both active and inactive — the port's documented read.
    return [...this.categories.values()]
      .filter(
        (category) =>
          category.societyId === societyId && category.deletedAt === null,
      )
      .sort(compareExpenseCategories);
  }

  async findCategory(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<ExpenseCategory | null> {
    this.record("findCategory");
    this.throwIfQueued("findCategory");
    const category = this.categories.get(id);
    // Scoped by society as well as by id: a category that exists in another society
    // must be unreachable, not merely unauthorised. A soft-deleted one is absent too,
    // which is the port's contract (`WHERE deleted_at IS NULL`) and the reason a
    // removed category is `not_found` rather than a special case a use case knows about.
    if (
      category === undefined ||
      category.societyId !== societyId ||
      category.deletedAt !== null
    ) {
      return null;
    }
    return category;
  }

  async findByName(
    name: string,
    societyId: SocietyId,
    _actor: UserId,
    exceptId?: ExpenseCategoryId,
  ): Promise<ExpenseCategory | null> {
    this.record("findByName");
    this.throwIfQueued("findByName");
    // The index's predicate, exactly: same society, live rows only, `name =` (not
    // `lower(name) =`), excluding the row being updated.
    return (
      [...this.categories.values()].find(
        (category) =>
          category.societyId === societyId &&
          category.deletedAt === null &&
          category.id !== exceptId &&
          category.name === name,
      ) ?? null
    );
  }

  async create(
    societyId: SocietyId,
    input: CreateExpenseCategoryInput,
    _actor: UserId,
  ): Promise<ExpenseCategory> {
    this.record("create");
    this.created.push(input);
    this.throwIfQueued("create");

    this.sequence += 1;
    const category: ExpenseCategory = {
      id: asExpenseCategoryId(`category-${this.sequence}`),
      societyId,
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
      defaultSplitStrategy: input.defaultSplitStrategy ?? "equal",
      defaultApartmentBasis: input.defaultApartmentBasis ?? null,
      isOwnerOnly: input.isOwnerOnly ?? false,
      isCapital: input.isCapital ?? false,
      gstApplicable: input.gstApplicable ?? false,
      isActive: input.isActive ?? true,
      displayOrder: input.displayOrder ?? 0,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      deletedAt: null,
    };
    this.categories.set(category.id, category);
    return category;
  }

  async update(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    input: UpdateExpenseCategoryInput,
    _actor: UserId,
  ): Promise<ExpenseCategory> {
    this.record("update");
    this.updated.push(input);
    this.throwIfQueued("update");

    const current = this.categories.get(id);
    if (
      current === undefined ||
      current.societyId !== societyId ||
      current.deletedAt !== null
    ) {
      throw expenseError("not_found", "Category not found.");
    }

    // Field by field: an absent key leaves the stored value untouched, and an explicit
    // `null` clears a nullable column. Spreading the patch would do neither.
    const next: ExpenseCategory = {
      ...current,
      name: input.name ?? current.name,
      icon: input.icon === undefined ? current.icon : input.icon,
      color: input.color === undefined ? current.color : input.color,
      defaultSplitStrategy:
        input.defaultSplitStrategy ?? current.defaultSplitStrategy,
      defaultApartmentBasis:
        input.defaultApartmentBasis === undefined
          ? current.defaultApartmentBasis
          : input.defaultApartmentBasis,
      isOwnerOnly: input.isOwnerOnly ?? current.isOwnerOnly,
      isCapital: input.isCapital ?? current.isCapital,
      gstApplicable: input.gstApplicable ?? current.gstApplicable,
      isActive: input.isActive ?? current.isActive,
      displayOrder: input.displayOrder ?? current.displayOrder,
      updatedAt: TEST_NOW,
    };
    this.categories.set(id, next);
    return next;
  }

  async remove(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<void> {
    this.record("remove");
    this.throwIfQueued("remove");
    const current = this.categories.get(id);
    if (
      current === undefined ||
      current.societyId !== societyId ||
      current.deletedAt !== null
    ) {
      throw expenseError("not_found", "Category not found.");
    }
    // Soft delete, as the port documents: the row is marked, not destroyed — which is
    // also what frees its name for reuse under the partial unique index.
    this.categories.set(id, { ...current, deletedAt: TEST_NOW });
  }

  // ── ExpenseReferenceReader ──────────────────────────────────────────────

  async countForCategory(
    categoryId: ExpenseCategoryId,
    _societyId: SocietyId,
    _actor: UserId,
  ): Promise<number> {
    this.record("countForCategory");
    this.throwIfQueued("countForCategory");
    return this.references.get(categoryId) ?? 0;
  }

  // ── ExpenseMembershipReader ─────────────────────────────────────────────

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

/** Narrowing helpers, so an assertion says what it means. */
export function expectOk<TValue>(result: Result<TValue, ExpenseError>): TValue {
  if (!result.ok) {
    throw new Error(
      `Expected success, but it failed with "${result.error.code}": ${result.error.message}`,
    );
  }
  return result.value;
}

export function expectErr<TValue>(
  result: Result<TValue, ExpenseError>,
): ExpenseError {
  if (result.ok) {
    throw new Error("Expected failure, but the operation succeeded.");
  }
  return result.error;
}
