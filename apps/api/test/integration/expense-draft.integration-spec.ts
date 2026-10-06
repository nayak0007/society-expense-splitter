import { randomUUID } from "node:crypto";

import {
  Expense,
  Money,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asUserId,
  paise,
  systemClock,
} from "@ses/domain";
import type {
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseDraftFields,
  ExpenseId,
  ExpenseRepository,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { EXPENSE_REPOSITORY } from "../../src/modules/expenses/application/expense.tokens";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { DeleteDraftUseCase } from "../../src/modules/expenses/application/use-cases/delete-draft.use-case";
import { GetExpenseUseCase } from "../../src/modules/expenses/application/use-cases/get-expense.use-case";
import { ListExpensesUseCase } from "../../src/modules/expenses/application/use-cases/list-expenses.use-case";
import { UpdateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/update-expense.use-case";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * The draft lifecycle against real PostgreSQL, real RLS and the real repository —
 * Roadmap T065.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes storage, so it can prove the contracts, the guard chain and the
 * use-case orchestration over a world a test wrote down. Five claims need the real
 * database:
 *
 *  1. **The atomic optimistic lock.** Two concurrent writers with the same
 *     `expectedVersion` race on a real row lock; exactly one wins and the other reads
 *     back the row's current version. No sequential mock can produce that.
 *  2. **The definer function's three rules.** Creator-only, draft-only and
 *     cross-society invisibility are enforced *inside* `expense_draft_delete()`, not
 *     by the caller — the suite calls the repository directly to prove the SQL gate,
 *     not the use-case gate the e2e suite already covers.
 *  3. **RLS.** A Guest sees nothing (`can_view_expenses` excludes them) while a member
 *     sees the draft; a Committee Member's own `pending_approval` insert is accepted by
 *     the insert policy since migration #31 (T070's deadlock fix — submission is the
 *     creator's act, publication is not); every statement runs through `UnitOfWork` as
 *     a real identity.
 *  4. **The column mapping.** Money crosses `bigint` as text exactly (a value past
 *     `int4`), `expense_date` stays a date, and the stored `jsonb` selector/config
 *     round-trip through `expenseFromRow`.
 *  5. **No financial side effects.** Create and update are counted against every
 *     financial table: exactly one `expenses` row, nothing else, `published_at` null.
 *
 * Fixtures are written on the **owner** connection; every call under test runs through
 * `UnitOfWork` as the acting member. `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let createExpense: CreateExpenseUseCase;
let updateExpense: UpdateExpenseUseCase;
let getExpense: GetExpenseUseCase;
let listExpenses: ListExpensesUseCase;
let deleteDraft: DeleteDraftUseCase;
let repository: ExpenseRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  createExpense = harness.app.get(CreateExpenseUseCase);
  updateExpense = harness.app.get(UpdateExpenseUseCase);
  getExpense = harness.app.get(GetExpenseUseCase);
  listExpenses = harness.app.get(ListExpensesUseCase);
  deleteDraft = harness.app.get(DeleteDraftUseCase);
  repository = harness.app.get<ExpenseRepository>(EXPENSE_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

/** Every table a draft write must leave alone, plus `expenses` itself. */
const FINANCIAL_TABLES = [
  "expenses",
  "expense_splits",
  "expense_gst_details",
  "expense_revisions",
  "dues",
] as const;

async function financialCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.${owner(table)}
    `;
    counts[table] = Number(row?.count ?? "0");
  }
  return counts;
}

async function categoryIdOf(
  societyId: SocietyId,
  actor: UserId,
  name: string,
): Promise<ExpenseCategoryId> {
  const categories = harness.app.get<ExpenseCategoryRepository>(
    EXPENSE_CATEGORY_REPOSITORY,
  );
  const listed = await categories.listCategories(societyId, actor);
  const category = listed.find((entry) => entry.name === name);
  if (category === undefined) {
    throw new Error(`The seeded category "${name}" is missing.`);
  }
  return category.id;
}

interface Fixture extends SocietyFixture {
  readonly committeeUserId: UserId;
  readonly committeeMemberId: string;
  readonly guestUserId: UserId;
  readonly categoryId: ExpenseCategoryId;
  readonly other: SocietyFixture;
  readonly otherCategoryId: ExpenseCategoryId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Draft Court",
    "admin@draft.ses.test",
  );

  const committeeUserId = asUserId(
    await createLocalUser(owner, "committee@draft.ses.test", "Committee"),
  );
  const committeeMemberId = await insertMember(owner, society.societyId, {
    userId: committeeUserId,
    role: "committee_member",
    displayName: "Committee Member",
  });
  const guestUserId = asUserId(
    await createLocalUser(owner, "guest@draft.ses.test", "Guest"),
  );
  await insertMember(owner, society.societyId, {
    userId: guestUserId,
    role: "guest",
    displayName: "Guest",
  });

  const other = await seedSociety(
    harness,
    "Other Court",
    "admin@other.ses.test",
  );

  return {
    ...society,
    committeeUserId,
    committeeMemberId,
    guestUserId,
    categoryId: await categoryIdOf(
      society.societyId,
      society.adminUserId,
      "Lift",
    ),
    other,
    otherCategoryId: await categoryIdOf(
      other.societyId,
      other.adminUserId,
      "Lift",
    ),
  };
}

function basicCommand(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
) {
  return {
    title: "Lift AMC — Q4",
    amountPaise: 450_000,
    expenseDate: "2026-09-30",
    categoryId: fixture.categoryId as string,
    ...overrides,
  };
}

/** The form fields a direct repository call needs — the shape the use cases write. */
function fieldsFor(
  overrides: Partial<ExpenseDraftFields> = {},
): ExpenseDraftFields {
  return {
    description: null,
    vendorName: null,
    paymentSource: "society_account",
    paidByMemberId: null,
    splitStrategy: "equal",
    apartmentBasis: null,
    splitConfig: {},
    participantSelector: {
      scope: "society",
      includeVacant: null,
      ownerOnly: false,
    },
    ...overrides,
  };
}

/** Builds an aggregate directly, for the repository-level RLS and FK proofs. */
function entityFor(
  fixture: Fixture,
  options: {
    readonly createdBy?: string;
    readonly categoryId?: string;
    readonly amountPaise?: number;
    readonly title?: string;
  } = {},
): Expense {
  const result = Expense.create({
    id: asExpenseId(randomUUID()),
    societyId: fixture.societyId,
    categoryId: asExpenseCategoryId(options.categoryId ?? fixture.categoryId),
    title: options.title ?? "Direct row",
    amount: Money.fromPaise(paise(BigInt(options.amountPaise ?? 450_000))),
    expenseDate: "2026-09-30",
    createdBy: asMemberId(options.createdBy ?? fixture.adminMemberId),
    clock: systemClock,
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe("draft persistence against real storage", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("persists a draft exactly, and the record round-trips through the adapter", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    expect(created.status).toBe("draft");
    expect(created.version).toBe(1);
    expect(created.createdBy).toBe(asMemberId(fixture.adminMemberId));
    expect(created.publishedAt).toBeNull();
    expect(created.amount.paise).toBe(450_000n);

    const [row] = await owner<
      {
        status: string;
        version: number;
        amount_paise: string;
        expense_date: string;
        created_by: string;
        published_at: string | null;
        currency: string;
        split_config: unknown;
        participant_selector: unknown;
      }[]
    >`
      select status::text as status,
             version,
             amount_paise::text as amount_paise,
             expense_date::text as expense_date,
             created_by,
             published_at,
             currency,
             split_config,
             participant_selector
        from public.expenses
       where id = ${created.id}::uuid
    `;

    expect(row).toMatchObject({
      status: "draft",
      version: 1,
      amount_paise: "450000",
      expense_date: "2026-09-30",
      created_by: fixture.adminMemberId,
      published_at: null,
      currency: "INR",
    });
    expect(row?.split_config).toEqual({});
    // The canonical selector spells every dimension, including the empty ones.
    expect(row?.participant_selector).toEqual({
      scope: "society",
      buildings: [],
      excludeApartments: [],
      floors: [],
      includeVacant: null,
      occupancy: [],
      ownerOnly: false,
      wings: [],
    });

    // The full record the write returned and the one a fresh read returns are the
    // same value — the projection's round trip, not just its columns.
    const read = await getExpense.get(
      fixture.adminUserId,
      fixture.societyId,
      created.id,
    );
    expect(read).toEqual(created);
  });

  it("crosses money past int4 exactly", async () => {
    const amountPaise = 4_294_967_297; // 2^32 + 1 — larger than int4, safe as a JSON number

    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture, { amountPaise }),
    );

    const [row] = await owner<{ amount_paise: string }[]>`
      select amount_paise::text as amount_paise
        from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.amount_paise).toBe("4294967297");
    expect(created.amount.paise).toBe(BigInt(amountPaise));
  });

  it("increments the version on every write, with the row trigger's own meaning", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    const second = await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      created.id,
      { expectedVersion: 1, title: "Lift AMC — revised" },
    );
    expect(second.expense.version).toBe(2);
    expect(second.recalculation).toBeNull();

    const third = await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      created.id,
      { expectedVersion: 2, description: "Covers Oct–Dec" },
    );
    expect(third.expense.version).toBe(3);

    const [row] = await owner<
      { version: number; title: string; description: string }[]
    >`
      select version, title, description
        from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row).toMatchObject({
      version: 3,
      title: "Lift AMC — revised",
      description: "Covers Oct–Dec",
    });
  });

  it("promotes an Admin's above-threshold create to pending_approval in the stored row", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture, { amountPaise: 1_000_001 }),
    );

    expect(created.status).toBe("pending_approval");
    const [row] = await owner<
      { status: string; published_at: string | null }[]
    >`
      select status::text as status, published_at
        from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.status).toBe("pending_approval");
    expect(row?.published_at).toBeNull();
  });

  it("routes a Committee Member's above-threshold expense into pending_approval — the T070 deadlock fix, in the stored row", async () => {
    const created = await createExpense.create(
      fixture.committeeUserId,
      fixture.societyId,
      basicCommand(fixture, { amountPaise: 5_000_000 }),
    );

    expect(created.status).toBe("pending_approval");
    const [row] = await owner<{ status: string }[]>`
      select status::text as status from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.status).toBe("pending_approval");
  });

  it("accepts a Committee Member's pending_approval insert — the widened RLS insert policy", async () => {
    const entity = entityFor(fixture, {
      createdBy: fixture.committeeMemberId,
      amountPaise: 5_000_000,
    });
    const submitted = entity.submitForApproval(systemClock);
    if (!submitted.ok) throw submitted.error;
    expect(entity.status).toBe("pending_approval");

    // Migration #31 widened `expenses_insert_author` to `draft` **or**
    // `pending_approval` for a `can_draft_expenses` caller: submitting is the
    // creator's own act, and it is deliberately *not* permission to publish
    // (approval stays Admin-only, and publication re-checks the threshold).
    const created = await repository.create(
      { expense: entity, fields: fieldsFor() },
      fixture.committeeUserId,
    );

    expect(created.status).toBe("pending_approval");
    const [row] = await owner<{ status: string; created_by: string }[]>`
      select status::text as status, created_by from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.status).toBe("pending_approval");
    expect(row?.created_by).toBe(fixture.committeeMemberId);
  });
});

describe("optimistic locking against real storage", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("lets exactly one of two writers with the same version win the race", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    const results = await Promise.allSettled([
      updateExpense.update(fixture.adminUserId, fixture.societyId, created.id, {
        expectedVersion: 1,
        title: "Writer A",
      }),
      updateExpense.update(fixture.adminUserId, fixture.societyId, created.id, {
        expectedVersion: 1,
        title: "Writer B",
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = rejected[0]?.reason as {
      code?: string;
      payload?: {
        details?: {
          field?: string;
          code?: string;
          received?: number;
          current?: number;
        }[];
      };
    };
    expect(reason.code).toBe("VERSION_MISMATCH");
    expect(reason.payload?.details?.[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 1,
      current: 2,
    });

    const [row] = await owner<{ version: number; title: string }[]>`
      select version, title from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.version).toBe(2);
    expect(["Writer A", "Writer B"]).toContain(row?.title);
  });

  it("answers a stale sequential write with the current version from the row", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );
    await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      created.id,
      {
        expectedVersion: 1,
        title: "First",
      },
    );

    await expect(
      updateExpense.update(fixture.adminUserId, fixture.societyId, created.id, {
        expectedVersion: 1,
        title: "Second",
      }),
    ).rejects.toMatchObject({
      code: "VERSION_MISMATCH",
      payload: {
        details: [
          {
            field: "expectedVersion",
            code: "STALE",
            current: 2,
          },
        ],
      },
    });
  });
});

describe("draft writes have no financial side effects", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("creates one expense row and nothing else, and never publishes", async () => {
    const before = await financialCounts();
    expect(Object.values(before)).toEqual([0, 0, 0, 0, 0]);

    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );
    await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      created.id,
      {
        expectedVersion: 1,
        title: "Edited but not published",
      },
    );

    const after = await financialCounts();
    expect(after).toEqual({
      expenses: 1,
      expense_splits: 0,
      expense_gst_details: 0,
      expense_revisions: 0,
      dues: 0,
    });

    const [row] = await owner<
      {
        status: string;
        published_at: string | null;
        voided_at: string | null;
      }[]
    >`
      select status::text as status, published_at, voided_at
        from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.status).toBe("draft");
    expect(row?.published_at).toBeNull();
    expect(row?.voided_at).toBeNull();
  });
});

describe("draft deletion through the definer function", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("lets the creator delete their draft, removing the row", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    await deleteDraft.delete(
      fixture.adminUserId,
      fixture.societyId,
      created.id,
    );

    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.count).toBe("0");
    await expect(
      getExpense.get(fixture.adminUserId, fixture.societyId, created.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a non-creator inside the database — even an Admin — through the repository", async () => {
    const created = await createExpense.create(
      fixture.committeeUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    await expect(
      repository.deleteDraft(
        created.id,
        fixture.societyId,
        fixture.adminUserId,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expenses
       where id = ${created.id}::uuid
    `;
    expect(row?.count).toBe("1");
  });

  it("refuses a published row inside the database", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );
    // `chk_split_total()` refuses a published expense whose splits do not sum to its
    // amount, so the published state is reached the way a publish would: one split
    // covering the whole amount, then the status move.
    await owner`
      insert into public.expense_splits (
        society_id, expense_id, member_id, amount_paise, weight
      )
      values (
        ${fixture.societyId}::uuid,
        ${created.id}::uuid,
        ${fixture.adminMemberId}::uuid,
        ${created.amount.paise.toString()}::bigint,
        1::numeric(12, 4)
      )
    `;
    await owner`
      update public.expenses
         set status = 'published', published_at = now()
       where id = ${created.id}::uuid
    `;

    await expect(
      repository.deleteDraft(
        created.id,
        fixture.societyId,
        fixture.adminUserId,
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("cannot address a cross-society id, even as the other society's Admin", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    await expect(
      repository.deleteDraft(
        created.id,
        fixture.other.societyId,
        fixture.other.adminUserId,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("tenancy and RLS", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("makes a cross-society expense id invisible — 404, never 403", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    await expect(
      getExpense.get(
        fixture.other.adminUserId,
        fixture.other.societyId,
        created.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateExpense.update(
        fixture.other.adminUserId,
        fixture.other.societyId,
        created.id,
        { expectedVersion: 1, title: "Foreign write" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      await repository.findById(
        created.id,
        fixture.other.societyId,
        fixture.other.adminUserId,
      ),
    ).toBeNull();
  });

  it("hides the draft from a Guest — can_view_expenses excludes them", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    expect(
      await repository.findById(
        created.id,
        fixture.societyId,
        fixture.guestUserId,
      ),
    ).toBeNull();

    const page = await listExpenses.list(
      fixture.guestUserId,
      fixture.societyId,
      {},
    );
    expect(page.expenses).toEqual([]);
  });

  it("shows the draft to every other member, which is the module's transparency rule", async () => {
    const created = await createExpense.create(
      fixture.adminUserId,
      fixture.societyId,
      basicCommand(fixture),
    );

    const seen = await getExpense.get(
      fixture.committeeUserId,
      fixture.societyId,
      created.id,
    );
    expect(seen.id).toBe(created.id);
  });

  it("refuses a category of another society at the composite foreign key", async () => {
    const entity = entityFor(fixture, {
      categoryId: fixture.otherCategoryId,
      title: "Foreign category",
    });

    await expect(
      repository.create(
        { expense: entity, fields: fieldsFor() },
        fixture.adminUserId,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("list over real SQL", () => {
  let fixture: Fixture;
  let older: ExpenseId;
  let waiting: ExpenseId;
  let newest: ExpenseId;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();

    newest = (
      await createExpense.create(
        fixture.adminUserId,
        fixture.societyId,
        basicCommand(fixture, {
          title: "Lift AMC",
          description: "Quarterly maintenance",
          expenseDate: "2026-09-30",
        }),
      )
    ).id;
    waiting = (
      await createExpense.create(
        fixture.adminUserId,
        fixture.societyId,
        basicCommand(fixture, {
          title: "Diwali decor",
          amountPaise: 2_000_000,
          expenseDate: "2026-09-15",
        }),
      )
    ).id;
    older = (
      await createExpense.create(
        fixture.adminUserId,
        fixture.societyId,
        basicCommand(fixture, {
          title: "Security salary",
          amountPaise: 200_000,
          expenseDate: "2026-08-31",
        }),
      )
    ).id;
  });

  it("orders newest first and applies each named filter", async () => {
    const all = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {},
    );
    expect(all.expenses.map((entry) => entry.id)).toEqual([
      newest,
      waiting,
      older,
    ]);

    const pending = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        status: "pending_approval",
      },
    );
    expect(pending.expenses.map((entry) => entry.id)).toEqual([waiting]);

    const byCategory = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      { categoryId: fixture.categoryId as string },
    );
    expect(byCategory.expenses.map((entry) => entry.id)).toEqual([
      newest,
      waiting,
      older,
    ]);

    const byDate = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        dateFrom: "2026-09-01",
      },
    );
    expect(byDate.expenses.map((entry) => entry.id)).toEqual([newest, waiting]);

    const byAmount = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        amountPaiseMin: 1_000_000,
      },
    );
    expect(byAmount.expenses.map((entry) => entry.id)).toEqual([waiting]);

    // The full-text predicate spells the GIN index's expression — this is the read
    // that proves the stored tsvector matches the query's own.
    const search = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        q: "maintenance",
      },
    );
    expect(search.expenses.map((entry) => entry.id)).toEqual([newest]);
  });

  it("paginates with the row-comparison cursor", async () => {
    const first = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        limit: 1,
      },
    );
    expect(first.expenses.map((entry) => entry.id)).toEqual([newest]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      },
    );
    expect(second.expenses.map((entry) => entry.id)).toEqual([waiting]);
    expect(second.hasMore).toBe(true);

    const third = await listExpenses.list(
      fixture.adminUserId,
      fixture.societyId,
      {
        limit: 1,
        cursor: second.nextCursor ?? undefined,
      },
    );
    expect(third.expenses.map((entry) => entry.id)).toEqual([older]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });
});
