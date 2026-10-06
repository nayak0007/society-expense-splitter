import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  Money,
  asMemberId,
  asUserId,
  calculateOutstanding,
  paise,
  weight,
  type ApartmentId,
  type BuildingId,
  type ExpenseCategoryId,
  type ExpenseCategoryRepository,
  type ExpenseId,
  type ExpenseSplitRepository,
  type MemberId,
  type PublishExpenseAllocation,
  type PublishExpenseRecordInput,
  type SocietyId,
  type UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { resolveMigrationsDir } from "../../src/infrastructure/database/migrations/runner";
import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";
import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { EXPENSE_SPLIT_REPOSITORY } from "../../src/modules/expenses/application/expense.tokens";
import { ApproveExpenseUseCase } from "../../src/modules/expenses/application/use-cases/approve-expense.use-case";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import {
  PublishExpenseUseCase,
  type PublishExpenseCommand,
} from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertBuilding,
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * Dues and member balances against real PostgreSQL, real RLS and the real definer
 * function — Roadmap T067.
 *
 * ## What only this suite can prove
 *
 * The e2e suite replaces the split repository with a fake, so nothing above the
 * HTTP boundary can show what the publishing transaction actually writes. The
 * acceptance turns on the database:
 *
 *  1. **`SUM(dues) = SUM(splits) = amount`, exactly** — including the Roadmap's
 *     own ₹60,000 / 64-flat case, on the database's own sums.
 *  2. **Balances updated inside the publishing transaction** — a failed
 *     publication leaves no dues and no balance delta, and a replay adds nothing.
 *  3. **Concurrency**: two parallel publications that touch one member produce the
 *     exact combined balance (the set-based upsert under the row lock), and a
 *     same-key race produces one set of dues.
 *  4. **The database's own invariants**: `uq_dues_split`, and the deferred
 *     `trg_due_billable_write` trigger refusing a due for a draft and a due that
 *     is not its split.
 *  5. **RLS**, three layers deep, on both new tables — own-row-or-manager, no
 *     write grant, cross-society and removed-member refusals.
 *  6. **The documented Down block** is executable and the file re-applies over it
 *     (the forward-only convention T060's schema spec establishes).
 *
 * Fixtures are written on the **owner** connection; every identity call runs
 * through `UnitOfWork` as an acting member. `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let publish: PublishExpenseUseCase;
let createExpense: CreateExpenseUseCase;
let approve: ApproveExpenseUseCase;
let splits: ExpenseSplitRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  publish = harness.app.get(PublishExpenseUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  approve = harness.app.get(ApproveExpenseUseCase);
  splits = harness.app.get<ExpenseSplitRepository>(EXPENSE_SPLIT_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

async function rows<T = Record<string, unknown>>(
  tx: TransactionContext,
  query: SQL,
): Promise<readonly T[]> {
  return (await tx.execute(query)) as unknown as readonly T[];
}

// ── reading the database back ────────────────────────────────────────────────

async function tableCount(table: string): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count from public.${owner(table)}
  `;
  return Number(row?.count ?? "0");
}

async function sumOf(table: "dues" | "expense_splits"): Promise<bigint> {
  const [row] = await owner<{ total: string }[]>`
    select coalesce(sum(amount_paise), 0)::text as total
      from public.${owner(table)}
  `;
  return BigInt(row?.total ?? "0");
}

interface DueRow {
  readonly id: string;
  readonly member_id: string;
  readonly apartment_id: string | null;
  readonly expense_id: string | null;
  readonly split_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly paid_paise: string;
  readonly amount_paise: string;
  readonly due_date: string;
}

function dueRows(expenseId: ExpenseId): Promise<DueRow[]> {
  return owner<DueRow[]>`
    select id,
           member_id,
           apartment_id,
           expense_id,
           split_id,
           kind,
           status,
           paid_paise::text as paid_paise,
           amount_paise::text as amount_paise,
           due_date::text as due_date
      from public.dues
     where expense_id = ${expenseId}::uuid
     order by amount_paise desc, member_id
  `;
}

interface BalanceRow {
  readonly member_id: string;
  readonly total_due_paise: string;
  readonly total_paid_paise: string;
  readonly advance_paise: string;
  readonly outstanding_paise: string;
  readonly oldest_due_date: string | null;
}

async function balanceOf(memberId: MemberId): Promise<BalanceRow | undefined> {
  const rows = await owner<BalanceRow[]>`
    select member_id,
           total_due_paise::text as total_due_paise,
           total_paid_paise::text as total_paid_paise,
           advance_paise::text as advance_paise,
           outstanding_paise::text as outstanding_paise,
           oldest_due_date::text as oldest_due_date
      from public.member_balances
     where member_id = ${memberId}::uuid
  `;
  return rows[0];
}

async function memberBalanceCount(societyId: SocietyId): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count from public.member_balances
     where society_id = ${societyId}::uuid
  `;
  return Number(row?.count ?? "0");
}

async function sumOutstanding(societyId: SocietyId): Promise<bigint> {
  const [row] = await owner<{ total: string }[]>`
    select coalesce(sum(outstanding_paise), 0)::text as total
      from public.member_balances
     where society_id = ${societyId}::uuid
  `;
  return BigInt(row?.total ?? "0");
}

interface ExpenseState {
  readonly status: string;
  readonly version: number;
  readonly publishedAt: string | null;
}

async function statusOf(expenseId: ExpenseId): Promise<ExpenseState> {
  const [row] = await owner<
    { status: string; version: number; published_at: string | null }[]
  >`
    select status, version, published_at::text as published_at
      from public.expenses where id = ${expenseId}::uuid
  `;
  if (row === undefined) throw new Error(`Expense ${expenseId} is missing.`);
  return {
    status: row.status,
    version: Number(row.version),
    publishedAt: row.published_at,
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

interface FlatFixture {
  readonly apartmentId: ApartmentId;
  readonly number: string;
  readonly ownerMemberId: MemberId;
  readonly tenantMemberId: MemberId | null;
}

interface Fixture extends SocietyFixture {
  readonly north: BuildingId;
  readonly flats: readonly FlatFixture[];
  readonly other: SocietyFixture;
  readonly liftCategoryId: ExpenseCategoryId;
  readonly sinkingCategoryId: ExpenseCategoryId;
  readonly treasurerUserId: UserId;
  readonly committeeUserId: UserId;
  readonly residentUserId: UserId;
  readonly residentMemberId: MemberId;
  readonly removedUserId: UserId;
}

/** One flat, its owner membership, and — for rented flats — a tenant. */
async function insertFlat(
  societyId: SocietyId,
  buildingId: BuildingId,
  number: string,
  options: { readonly rented?: boolean; readonly carpet: string },
): Promise<FlatFixture> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.apartments (
      society_id, building_id, apartment_number, floor,
      carpet_area_sqft, builtup_area_sqft, share_units,
      occupancy_status, is_billable
    )
    values (
      ${societyId}::uuid,
      ${buildingId}::uuid,
      ${number},
      1::smallint,
      ${options.carpet}::numeric(8, 2),
      ${`${Number(options.carpet) + 175}`}::numeric(8, 2),
      '1'::numeric(8, 3),
      ${options.rented === true ? "rented" : "owner_occupied"}::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  const apartmentId = row!.id as ApartmentId;

  const ownerMemberId = asMemberId(
    await insertMember(owner, societyId, {
      apartmentId,
      occupancy: options.rented === true ? "vacant_owner" : "owner_occupied",
      // The tenant is the primary occupant of a rented flat; the owner is not.
      isPrimary: options.rented !== true,
      displayName: `Owner ${number}`,
    }),
  );

  const tenantMemberId =
    options.rented === true
      ? asMemberId(
          await insertMember(owner, societyId, {
            apartmentId,
            occupancy: "tenant",
            isPrimary: true,
            displayName: `Tenant ${number}`,
          }),
        )
      : null;

  return { apartmentId, number, ownerMemberId, tenantMemberId };
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

/**
 * A society with `flatCount` flats (P001 rented, with owner **and** tenant),
 * the officer roles, a linked resident and a removed member, plus a second society.
 */
async function seed(flatCount = 4): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Balances Court",
    "admin@balances.ses.test",
  );
  const north = await insertBuilding(owner, society.societyId, "North Block");

  const flats: FlatFixture[] = [];
  for (let index = 1; index <= flatCount; index += 1) {
    const number = `P${String(index).padStart(3, "0")}`;
    flats.push(
      await insertFlat(society.societyId, north, number, {
        rented: index === 1,
        carpet: `${700 + index}`,
      }),
    );
  }

  const treasurerUserId = asUserId(
    await createLocalUser(owner, "treasurer@balances.ses.test", "Treasurer"),
  );
  await insertMember(owner, society.societyId, {
    userId: treasurerUserId,
    role: "treasurer",
    displayName: "Treasurer",
  });

  const committeeUserId = asUserId(
    await createLocalUser(owner, "committee@balances.ses.test", "Committee"),
  );
  await insertMember(owner, society.societyId, {
    userId: committeeUserId,
    role: "committee_member",
    displayName: "Committee Member",
  });

  // A resident linked to a (shadow) owner — the account-merge shape. The last
  // flat is used so a single-flat fixture still has one.
  const residentFlat = flats[1] ?? flats[0]!;
  const residentUserId = asUserId(
    await createLocalUser(owner, "resident@balances.ses.test", "Resident"),
  );
  await owner`
    update public.members
       set user_id = ${residentUserId}::uuid
     where id = ${residentFlat.ownerMemberId}::uuid
  `;

  // A member whose membership is removed: linked to a user, no access.
  const removedUserId = asUserId(
    await createLocalUser(owner, "removed@balances.ses.test", "Removed"),
  );
  await insertMember(owner, society.societyId, {
    userId: removedUserId,
    role: "resident",
    status: "removed",
    displayName: "Removed Member",
  });

  const other = await seedSociety(
    harness,
    "Other Court",
    "admin@otherbalances.ses.test",
  );

  return {
    ...society,
    north,
    flats,
    other,
    liftCategoryId: await categoryIdOf(
      society.societyId,
      society.adminUserId,
      "Lift",
    ),
    sinkingCategoryId: await categoryIdOf(
      society.societyId,
      society.adminUserId,
      "Sinking Fund",
    ),
    treasurerUserId,
    committeeUserId,
    residentUserId,
    residentMemberId: residentFlat.ownerMemberId,
    removedUserId,
  };
}

async function createDraft(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<ExpenseId> {
  const record = await createExpense.create(
    fixture.adminUserId,
    fixture.societyId,
    {
      title: "Lift AMC — Q4",
      amountPaise: 400_000,
      expenseDate: "2026-10-01",
      categoryId: fixture.liftCategoryId as string,
      ...overrides,
    },
  );
  return record.id;
}

const KEY = "integration-balances-key-0001";

function publishOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  overrides: Partial<PublishExpenseCommand> = {},
) {
  return publish.publish(fixture.adminUserId, fixture.societyId, expenseId, {
    expectedVersion: 1,
    idempotencyKey: KEY,
    ...overrides,
  });
}

/**
 * Clear T070's approval gate for a fixture whose amount is at or above the
 * society's threshold — `amount_paise >= approval_threshold_paise` (ADR-0011 D3),
 * which the default 1,000,000-paise threshold makes true for the ₹60,000 / 64-flat
 * case below. Without an Admin's decision `expense_publish()` writes nothing and
 * raises `APPROVAL_REQUIRED` (D4), so this suite's publication test must approve
 * first. The creating Admin approves their own expense, which D5 explicitly
 * permits, and the approval increments the version the publish must then match.
 */
function approveOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  expectedVersion = 1,
) {
  return approve.approve(fixture.adminUserId, fixture.societyId, expenseId, {
    expectedVersion,
  });
}

async function failureOf(
  promise: Promise<unknown>,
): Promise<{ code: unknown; message: string }> {
  try {
    await promise;
  } catch (error: unknown) {
    const candidate = error as { code?: unknown; message?: unknown };
    return {
      code: candidate.code,
      message: typeof candidate.message === "string" ? candidate.message : "",
    };
  }
  throw new Error("Expected the call to be refused.");
}

function publishInputOf(
  idempotencyKey: string,
  allocations: readonly PublishExpenseAllocation[],
  expectedVersion = 1,
): PublishExpenseRecordInput {
  return {
    expectedVersion,
    idempotencyKey,
    requestHash: createHash("sha256")
      .update(`integration-balances:${idempotencyKey}`)
      .digest("hex"),
    allocations,
  };
}

/** Equal shares across the fixture's flats, conserving the amount exactly. */
async function allocationsFor(
  fixture: Fixture,
  amountPaise: bigint,
): Promise<PublishExpenseAllocation[]> {
  const count = BigInt(fixture.flats.length);
  const share = amountPaise / count;
  const allocations: PublishExpenseAllocation[] = [];
  let assigned = 0n;
  for (const flat of fixture.flats) {
    const [row] = await owner<{ display_name: string }[]>`
      select display_name from public.members where id = ${flat.ownerMemberId}::uuid
    `;
    const amount = share;
    assigned += amount;
    allocations.push({
      memberId: flat.ownerMemberId,
      apartmentId: flat.apartmentId,
      amount: Money.fromPaise(amount),
      weight: weight(1),
      percent: null,
      assignedReason: null,
      snapshot: {
        memberName: row!.display_name,
        apartmentNumber: flat.number,
      },
    });
  }
  const last = allocations[allocations.length - 1]!;
  allocations[allocations.length - 1] = {
    ...last,
    amount: Money.fromPaise(last.amount.paise + (amountPaise - assigned)),
  };
  return allocations;
}

/** The documented due-date rule, computed independently of the migration. */
async function expectedDueDate(
  dueDay: number,
  timezone = "Asia/Kolkata",
): Promise<string> {
  const [row] = await owner<{ today: string }[]>`
    select (now() at time zone ${timezone})::date::text as today
  `;
  const parts = row!.today.split("-").map(Number);
  const year = parts[0]!;
  let dueMonth = parts[1]!;
  const day = parts[2]!;
  let dueYear = year;
  if (day > dueDay) {
    dueMonth += 1;
    if (dueMonth > 12) {
      dueMonth = 1;
      dueYear += 1;
    }
  }
  return `${dueYear}-${String(dueMonth).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
}

async function todayDayOfMonth(): Promise<number> {
  const [row] = await owner<{ day: string }[]>`
    select extract(day from (now() at time zone 'Asia/Kolkata'))::int::text as day
  `;
  return Number(row!.day);
}

// ── the good path: dues from splits, balances in the same transaction ───────

describe("publishing writes the receivable", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("creates exactly one principal due per split, paisa for paisa, with the payment fields at their schema defaults", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);

    const dues = await dueRows(expenseId);
    const splitsOfExpense = await owner<
      {
        id: string;
        amount_paise: string;
        member_id: string | null;
        apartment_id: string | null;
      }[]
    >`
      select id, amount_paise::text as amount_paise, member_id, apartment_id
        from public.expense_splits where expense_id = ${expenseId}::uuid
       order by id
    `;

    expect(dues).toHaveLength(splitsOfExpense.length);
    const bySplit = new Map(splitsOfExpense.map((row) => [row.id, row]));
    for (const due of dues) {
      const split = bySplit.get(due.split_id!);
      expect(split).toBeDefined();
      expect(due.amount_paise).toBe(split!.amount_paise);
      expect(due.member_id).toBe(split!.member_id);
      expect(due.apartment_id).toBe(split!.apartment_id);
      expect(due.expense_id).toBe(expenseId);
      // Schema defaults, untouched by T067: nothing is paid, nothing is late.
      expect(due.kind).toBe("principal");
      expect(due.status).toBe("pending");
      expect(due.paid_paise).toBe("0");
    }
    // One due per split, and no split left without one.
    expect(new Set(dues.map((due) => due.split_id)).size).toBe(dues.length);
  });

  it("conserves the amount across splits, dues and balances exactly", async () => {
    const expenseId = await createDraft(fixture, { amountPaise: 600_000 });
    await publishOf(fixture, expenseId);

    const [amount] = await owner<{ amount: string }[]>`
      select amount_paise::text as amount from public.expenses where id = ${expenseId}::uuid
    `;
    expect(amount?.amount).toBe("600000");
    expect(await sumOf("expense_splits")).toBe(600_000n);
    expect(await sumOf("dues")).toBe(600_000n);
    expect(await sumOutstanding(fixture.societyId)).toBe(600_000n);

    // Every balance row equals its own dues, and every billed member has one row.
    const [aggregate] = await owner<{ members: string; mismatches: string }[]>`
      select count(*)::text as members,
             count(*) filter (
               where mb.total_due_paise <> d.total or mb.outstanding_paise <> d.total
             )::text as mismatches
        from public.member_balances mb
        join (
          select member_id, sum(amount_paise) as total
            from public.dues
           group by member_id
        ) d on d.member_id = mb.member_id
       where mb.society_id = ${fixture.societyId}::uuid
    `;
    expect(aggregate?.members).toBe("4");
    expect(aggregate?.mismatches).toBe("0");
  });

  it("stamps the society's next due day on every due and maintains oldest_due_date", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);

    const expected = await expectedDueDate(10);
    const dues = await dueRows(expenseId);
    for (const due of dues) {
      expect(due.due_date).toBe(expected);
    }
    // Every billed member carries the same oldest open date. (The billed member
    // of the rented flat is its tenant — that routing is T063's, and the
    // owner-only test below pins the exception.)
    expect(new Set(dues.map((due) => due.member_id)).size).toBe(4);
    for (const memberId of new Set(dues.map((due) => due.member_id))) {
      expect((await balanceOf(asMemberId(memberId)))?.oldest_due_date).toBe(
        expected,
      );
    }
  });

  it("uses the next month when the due day has passed, adds deltas, and keeps the older date", async () => {
    // Force the other branch of the rule: a due day strictly before today.
    const today = await todayDayOfMonth();
    const dueDay = today > 1 ? today - 1 : 28;
    await owner`
      update public.society_settings
         set due_day = ${dueDay}::smallint
       where society_id = ${fixture.societyId}::uuid
    `;
    const expected = await expectedDueDate(dueDay);

    const first = await createDraft(fixture, { title: "First" });
    await publishOf(fixture, first);
    expect((await dueRows(first))[0]?.due_date).toBe(expected);

    // A second expense for the same member set: the balance's oldest stays where
    // it was, the totals add.
    const second = await createDraft(fixture, {
      title: "Second",
      amountPaise: 100_000,
    });
    await publishOf(fixture, second, { idempotencyKey: "second-key" });

    // The member the rented flat's first publish actually billed (its tenant).
    const billed = (await dueRows(first)).find(
      (due) => due.apartment_id === fixture.flats[0]!.apartmentId,
    )!;
    const [dues] = await owner<{ total: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as total
        from public.dues where member_id = ${billed.member_id}::uuid
    `;
    const balance = await balanceOf(asMemberId(billed.member_id));
    expect(balance?.total_due_paise).toBe(dues?.total);
    expect(balance?.oldest_due_date).toBe(expected);
  });

  it("updates all 64 balances correctly for ₹60,000 per-sqft across 64 flats", async () => {
    await resetData(owner);
    const big = await seed(64);
    const expenseId = await createDraft(big, {
      title: "Repainting — all towers",
      amountPaise: 6_000_000,
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
    });

    // ₹60,000 is far above the default threshold, so T070's gate applies: the
    // Admin approves the expense they created (D5) and the approval bumps the
    // row to version 2, which the publish now has to match.
    await approveOf(big, expenseId);
    await publishOf(big, expenseId, { expectedVersion: 2 });

    // The Roadmap's own test, now including the receivable half. Every number is
    // the database's own; the application's arithmetic is never trusted here.
    const [report] = await owner<
      {
        expense_amount: string;
        split_count: string;
        split_total: string;
        due_count: string;
        due_total: string;
        member_count: string;
        balance_total: string;
        oldest: string | null;
      }[]
    >`
      select e.amount_paise::text as expense_amount,
             (select count(*) from public.expense_splits s
               where s.expense_id = e.id)::text as split_count,
             (select coalesce(sum(s.amount_paise), 0) from public.expense_splits s
               where s.expense_id = e.id)::text as split_total,
             (select count(*) from public.dues d
               where d.expense_id = e.id)::text as due_count,
             (select coalesce(sum(d.amount_paise), 0) from public.dues d
               where d.expense_id = e.id)::text as due_total,
             (select count(distinct d.member_id) from public.dues d
               where d.expense_id = e.id)::text as member_count,
             (select coalesce(sum(mb.outstanding_paise), 0)
                from public.member_balances mb
               where mb.society_id = e.society_id)::text as balance_total,
             (select min(d.due_date)::text from public.dues d
               where d.expense_id = e.id) as oldest
        from public.expenses e
       where e.id = ${expenseId}::uuid
    `;

    expect(report).toEqual({
      expense_amount: "6000000",
      split_count: "64",
      split_total: "6000000",
      due_count: "64",
      due_total: "6000000",
      member_count: "64",
      balance_total: "6000000",
      oldest: await expectedDueDate(10),
    });
    expect(await memberBalanceCount(big.societyId)).toBe(64);

    // The domain calculator agrees with the committed rows, member by member: the
    // reference formula and the SQL upsert cannot drift apart silently.
    interface DueLineRow {
      readonly member_id: string;
      readonly kind: string;
      readonly status: string;
      readonly amount_paise: string;
      readonly paid_paise: string;
      readonly due_date: string;
    }
    const dues = await owner<DueLineRow[]>`
      select member_id, kind, status, amount_paise::text as amount_paise,
             paid_paise::text as paid_paise, due_date::text as due_date
        from public.dues
       where expense_id = ${expenseId}::uuid
    `;
    const byMember = new Map<string, DueLineRow[]>();
    for (const due of dues) {
      const bucket = byMember.get(due.member_id) ?? [];
      bucket.push(due);
      byMember.set(due.member_id, bucket);
    }
    expect(byMember.size).toBe(64);
    for (const [memberId, lines] of byMember) {
      const balance = await balanceOf(asMemberId(memberId));
      const expected = calculateOutstanding({
        dues: lines.map((line) => ({
          kind: line.kind as "principal",
          status: line.status,
          amountPaise: paise(BigInt(line.amount_paise)),
          paidPaise: paise(BigInt(line.paid_paise)),
          dueDate: line.due_date,
        })),
      });
      expect(balance?.outstanding_paise).toBe(
        expected.outstandingPaise.toString(),
      );
      expect(balance?.total_due_paise).toBe(expected.totalDuePaise.toString());
      expect(balance?.oldest_due_date).toBe(expected.oldestDueDate);
    }
  });

  it("routes an owner-only category's dues to the owner, never the tenant", async () => {
    const rented = fixture.flats[0]!;
    const expenseId = await createDraft(fixture, {
      title: "Sinking fund",
      categoryId: fixture.sinkingCategoryId,
    });

    await publishOf(fixture, expenseId);

    const dues = await dueRows(expenseId);
    const rentedDue = dues.find(
      (due) => due.apartment_id === rented.apartmentId,
    );
    expect(rentedDue).toBeDefined();
    expect(rentedDue!.member_id).toBe(rented.ownerMemberId);
    expect(rentedDue!.member_id).not.toBe(rented.tenantMemberId);
    // The tenant is billed nothing at all.
    expect(dues.some((due) => due.member_id === rented.tenantMemberId)).toBe(
      false,
    );
    // And the owner carries the balance.
    expect(await balanceOf(rented.ownerMemberId)).toBeDefined();
    expect(await balanceOf(rented.tenantMemberId!)).toBeUndefined();
  });

  it("supports ordering by outstanding descending with the index", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);

    const plan = await owner.begin(async (tx) => {
      await tx.unsafe("set local enable_seqscan = off");
      return tx<{ "QUERY PLAN": string }[]>`
        explain (costs off)
        select member_id from public.member_balances
         where society_id = ${fixture.societyId}::uuid
         order by outstanding_paise desc
         limit 10
      `;
    });

    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("idx_balances_society_outstanding");
  });
});

// ── idempotency and races ────────────────────────────────────────────────────

describe("replay and races over real storage", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("replays the stored response without adding a due, a balance or a record", async () => {
    const expenseId = await createDraft(fixture);
    const first = await publishOf(fixture, expenseId);
    const before = {
      dues: await tableCount("dues"),
      balances: await memberBalanceCount(fixture.societyId),
      duesTotal: await sumOf("dues"),
      outstanding: await sumOutstanding(fixture.societyId),
      records: await tableCount("idempotency_records"),
      version: (await statusOf(expenseId)).version,
      member: await balanceOf(fixture.flats[0]!.ownerMemberId),
    };

    const replay = await publishOf(fixture, expenseId);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.expense.version).toBe(first.expense.version);
    expect({
      dues: await tableCount("dues"),
      balances: await memberBalanceCount(fixture.societyId),
      duesTotal: await sumOf("dues"),
      outstanding: await sumOutstanding(fixture.societyId),
      records: await tableCount("idempotency_records"),
      version: (await statusOf(expenseId)).version,
      member: await balanceOf(fixture.flats[0]!.ownerMemberId),
    }).toEqual(before);
  });

  it("refuses a reused key for a different request and changes no money", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);
    const before = {
      dues: await tableCount("dues"),
      outstanding: await sumOutstanding(fixture.societyId),
    };

    const error = await failureOf(
      publishOf(fixture, expenseId, { expectedVersion: 2 }),
    );

    expect(error.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect({
      dues: await tableCount("dues"),
      outstanding: await sumOutstanding(fixture.societyId),
    }).toEqual(before);
  });

  it("turns a same-key race into one publication and one set of dues", async () => {
    const expenseId = await createDraft(fixture);
    const allocations = await allocationsFor(fixture, 400_000n);
    const input = publishInputOf(KEY, allocations);

    const results = await Promise.allSettled([
      splits.publish(expenseId, fixture.societyId, input, fixture.adminUserId),
      splits.publish(expenseId, fixture.societyId, input, fixture.adminUserId),
    ]);

    // Either both requests succeed (one fresh, one store-backed replay) or the
    // loser is refused by the row lock — never two fresh publications.
    const fresh = results.filter(
      (result) =>
        result.status === "fulfilled" && result.value.replayed === false,
    );
    expect(fresh).toHaveLength(1);

    expect(await tableCount("dues")).toBe(4);
    expect(await sumOf("dues")).toBe(400_000n);
    expect(await sumOutstanding(fixture.societyId)).toBe(400_000n);
    expect(await tableCount("idempotency_records")).toBe(1);
  });

  it("adds both deltas when two publications hit the same member concurrently", async () => {
    await resetData(owner);
    // One flat: every publication has exactly one allocation, so both
    // transactions contend for the same balance row.
    const small = await seed(1);
    const first = await createDraft(small, {
      title: "First concurrent",
      amountPaise: 100_000,
    });
    const second = await createDraft(small, {
      title: "Second concurrent",
      amountPaise: 250_000,
    });

    const [a, b] = await Promise.all([
      publish.publish(small.adminUserId, small.societyId, first, {
        expectedVersion: 1,
        idempotencyKey: "race-member-key-0001",
      }),
      publish.publish(small.adminUserId, small.societyId, second, {
        expectedVersion: 1,
        idempotencyKey: "race-member-key-0002",
      }),
    ]);

    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);

    // Both publications billed the same member — the tenant of the single flat.
    const member = asMemberId((await dueRows(first))[0]!.member_id);
    expect((await dueRows(second))[0]!.member_id).toBe(member);
    const balance = await balanceOf(member);
    // The exact combined effect: no lost update, no double count.
    expect(balance?.total_due_paise).toBe("350000");
    expect(balance?.outstanding_paise).toBe("350000");
    expect(await tableCount("dues")).toBe(2);
    expect((await dueRows(first)).length + (await dueRows(second)).length).toBe(
      2,
    );
  });
});

// ── failure atomicity ────────────────────────────────────────────────────────

describe("failure atomicity", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("rolls back the whole publication when a due cannot address a member", async () => {
    const expenseId = await createDraft(fixture);
    const before = await statusOf(expenseId);
    const allocations = await allocationsFor(fixture, 400_000n);
    // The API refuses this before the database sees it (`unassigned_participants`);
    // here the definer function itself must fail closed, and the failure must take
    // the splits, the transition and the balance delta with it.
    allocations[0] = {
      ...allocations[0]!,
      memberId: null as unknown as MemberId,
    };

    const failure = await failureOf(
      splits.publish(
        expenseId,
        fixture.societyId,
        publishInputOf(KEY, allocations),
        fixture.adminUserId,
      ),
    );

    expect(failure.message.length).toBeGreaterThan(0);
    expect(await statusOf(expenseId)).toEqual(before);
    expect(await tableCount("expense_splits")).toBe(0);
    expect(await tableCount("dues")).toBe(0);
    expect(await memberBalanceCount(fixture.societyId)).toBe(0);
    expect(await tableCount("idempotency_records")).toBe(0);
    // Nothing was touched, so the aggregate is genuinely absent rather than zeroed.
    expect(await sumOutstanding(fixture.societyId)).toBe(0n);
  });

  it("rolls back when the split set itself violates a unique key", async () => {
    const expenseId = await createDraft(fixture, { amountPaise: 100_000 });
    const before = await statusOf(expenseId);
    // The same owner twice: conserving in total, impossible as rows. Nothing may
    // survive — not the splits, not the dues, not the record.
    // The same participant — same member **and** same flat — twice: the
    // `uq_expense_splits_participant` key refuses the second row, after the
    // function has already deleted nothing and begun writing.
    const one = await allocationsFor(fixture, 100_000n);
    const duplicate = [
      { ...one[0]!, amount: Money.fromPaise(50_000n) },
      { ...one[0]!, amount: Money.fromPaise(50_000n) },
    ];

    const failure = await failureOf(
      splits.publish(
        expenseId,
        fixture.societyId,
        publishInputOf(KEY, duplicate),
        fixture.adminUserId,
      ),
    );

    expect(failure.code).toBe("conflict");
    expect(await statusOf(expenseId)).toEqual(before);
    expect(await tableCount("expense_splits")).toBe(0);
    expect(await tableCount("dues")).toBe(0);
    expect(await tableCount("idempotency_records")).toBe(0);
  });
});

// ── the database's own invariants ────────────────────────────────────────────

describe("the database's own invariants", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("refuses a second due for the same split", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);
    const [due] = await dueRows(expenseId);

    const failure = await failureOf(
      owner`
        insert into public.dues (
          society_id, member_id, apartment_id, expense_id, split_id,
          kind, amount_paise, due_date
        )
        values (
          ${fixture.societyId}::uuid, ${due!.member_id}::uuid,
          ${due!.apartment_id}::uuid, ${expenseId}::uuid, ${due!.split_id}::uuid,
          'principal', ${due!.amount_paise}::bigint, current_date
        )
      `,
    );

    expect(failure.message).toMatch(/duplicate key|unique/i);
    expect(await tableCount("dues")).toBe(4);
  });

  it("refuses a due whose expense is not published", async () => {
    const draftId = await createDraft(fixture);
    const flat = fixture.flats[0]!;
    // A split on a draft: allowed by the schema (drafts may hold staging rows),
    // but nothing may turn it into a receivable while the expense is a draft.
    const [split] = await owner<{ id: string }[]>`
      insert into public.expense_splits (
        society_id, expense_id, member_id, apartment_id, amount_paise, snapshot
      )
      values (
        ${fixture.societyId}::uuid, ${draftId}::uuid,
        ${flat.ownerMemberId}::uuid, ${flat.apartmentId}::uuid,
        1000::bigint, '{}'::jsonb
      )
      returning id
    `;

    const failure = await failureOf(
      owner`
        insert into public.dues (
          society_id, member_id, apartment_id, expense_id, split_id,
          kind, amount_paise, due_date
        )
        values (
          ${fixture.societyId}::uuid, ${flat.ownerMemberId}::uuid,
          ${flat.apartmentId}::uuid, ${draftId}::uuid, ${split!.id}::uuid,
          'principal', 1000::bigint, current_date
        )
      `,
    );

    expect(failure.message).toContain("DUE_WITHOUT_PUBLISHED_EXPENSE");
    expect(await tableCount("dues")).toBe(0);
  });

  it("refuses a principal due that is not exactly its split", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);
    const flat = fixture.flats[0]!;
    // A fresh zero-amount split on the same published expense keeps the parent's
    // conservation intact (0 adds nothing) while giving the due below a split of
    // its own — so the only invariant it can violate is the amount equality.
    const [split] = await owner<{ id: string }[]>`
      insert into public.expense_splits (
        society_id, expense_id, member_id, apartment_id, amount_paise, snapshot
      )
      values (
        ${fixture.societyId}::uuid, ${expenseId}::uuid,
        ${flat.ownerMemberId}::uuid, ${flat.apartmentId}::uuid,
        0::bigint, '{}'::jsonb
      )
      returning id
    `;

    const failure = await failureOf(
      owner`
        insert into public.dues (
          society_id, member_id, apartment_id, expense_id, split_id,
          kind, amount_paise, due_date
        )
        values (
          ${fixture.societyId}::uuid, ${flat.ownerMemberId}::uuid,
          ${flat.apartmentId}::uuid, ${expenseId}::uuid, ${split!.id}::uuid,
          'principal', 1::bigint, current_date
        )
      `,
    );

    expect(failure.message).toContain("DUE_SPLIT_MISMATCH");
    expect(await tableCount("dues")).toBe(4);
  });

  it("leaves non-principal dues and payment-column updates alone", async () => {
    // A late fee that names no expense is legal (T085's shape), and the payment
    // path's own updates must not pay the trigger's cost or be blocked by it.
    await owner`
      insert into public.dues (society_id, member_id, kind, amount_paise, due_date)
      values (
        ${fixture.societyId}::uuid, ${fixture.flats[0]!.ownerMemberId}::uuid,
        'late_fee', 500::bigint, current_date
      )
    `;
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);
    const [due] = await dueRows(expenseId);

    await owner`
      update public.dues
         set paid_paise = 1, status = 'partial'
       where id = ${due!.id}::uuid
    `;

    const [row] = await owner<{ paid_paise: string; status: string }[]>`
      select paid_paise::text as paid_paise, status
        from public.dues where id = ${due!.id}::uuid
    `;
    expect(row).toEqual({ paid_paise: "1", status: "partial" });
    expect(await tableCount("dues")).toBe(5);
  });
});

// ── RLS and identity ─────────────────────────────────────────────────────────

describe("RLS on dues and balances", () => {
  let fixture: Fixture;

  function rowsAs<T>(userId: UserId, query: SQL): Promise<readonly T[]> {
    return harness.unitOfWork.transaction({ kind: "user", userId }, (tx) =>
      rows<T>(tx, query),
    ) as unknown as Promise<readonly T[]>;
  }

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);
  });

  it("shows a resident their own balance and a manager everyone's", async () => {
    // This resident is the linked account of P002's owner (the account-merge
    // shape): exactly one balance row is theirs.
    const own = await rowsAs<{ member_id: string }>(
      fixture.residentUserId,
      sql`select member_id from public.member_balances order by member_id`,
    );
    expect(own).toHaveLength(1);
    expect(own[0]!.member_id).toBe(fixture.residentMemberId);

    const admin = await rowsAs<{ member_id: string }>(
      fixture.adminUserId,
      sql`select member_id from public.member_balances order by member_id`,
    );
    expect(admin).toHaveLength(4);

    const treasurer = await rowsAs<{ member_id: string }>(
      fixture.treasurerUserId,
      sql`select member_id from public.member_balances`,
    );
    expect(treasurer).toHaveLength(4);
  });

  it("shows a committee member nothing that is not theirs", async () => {
    const committee = await rowsAs<{ member_id: string }>(
      fixture.committeeUserId,
      sql`select member_id from public.member_balances`,
    );
    expect(committee).toHaveLength(0);

    const committeeDues = await rowsAs<{ id: string }>(
      fixture.committeeUserId,
      sql`select id from public.dues`,
    );
    expect(committeeDues).toHaveLength(0);
  });

  it("shows another society's admin nothing", async () => {
    const foreign = await rowsAs<{ member_id: string }>(
      fixture.other.adminUserId,
      sql`select member_id from public.member_balances`,
    );
    expect(foreign).toHaveLength(0);
  });

  it("shows a removed member nothing", async () => {
    const removed = await rowsAs<{ member_id: string }>(
      fixture.removedUserId,
      sql`select member_id from public.member_balances`,
    );
    expect(removed).toHaveLength(0);
  });

  it("refuses every client write to balances and dues", async () => {
    async function refusal(query: SQL, user: UserId): Promise<string> {
      try {
        await harness.unitOfWork.transaction(
          { kind: "user", userId: user },
          (tx) => rows(tx, query),
        );
        return "allowed";
      } catch (error: unknown) {
        const candidate = error as {
          code?: unknown;
          cause?: { code?: unknown };
        };
        if (typeof candidate.code === "string") return candidate.code;
        if (typeof candidate.cause?.code === "string") {
          return candidate.cause.code;
        }
        return "refused";
      }
    }

    expect(
      await refusal(
        sql`insert into public.member_balances (member_id, society_id)
            values (${fixture.flats[0]!.ownerMemberId}::uuid,
                    ${fixture.societyId}::uuid)
            returning member_id`,
        fixture.adminUserId,
      ),
    ).toBe("42501");
    expect(
      await refusal(
        sql`update public.member_balances set outstanding_paise = 0 returning member_id`,
        fixture.adminUserId,
      ),
    ).toBe("42501");
    expect(
      await refusal(
        sql`delete from public.member_balances returning member_id`,
        fixture.adminUserId,
      ),
    ).toBe("42501");
    expect(
      await refusal(
        sql`insert into public.dues (society_id, member_id, amount_paise, due_date)
            values (${fixture.societyId}::uuid, ${fixture.adminMemberId}::uuid,
                    1::bigint, current_date)
            returning id`,
        fixture.adminUserId,
      ),
    ).toBe("42501");
  });
});

// ── shadow members ───────────────────────────────────────────────────────────

describe("shadow members", () => {
  it("bills a shadow member, keeps the history when an account is linked, and never duplicates it", async () => {
    await resetData(owner);
    const fixture = await seed();
    const shadow = fixture.flats[2]!.ownerMemberId;

    const [before] = await owner<{ user_id: string | null }[]>`
      select user_id from public.members where id = ${shadow}::uuid
    `;
    expect(before?.user_id).toBeNull();

    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);
    const [dueBefore] = await owner<{ total: string; count: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as total, count(*)::text as count
        from public.dues where member_id = ${shadow}::uuid
    `;
    const balanceBefore = await balanceOf(shadow);
    expect(dueBefore?.total).not.toBe("0");
    expect(balanceBefore).toBeDefined();

    // Registration links the account to the same membership row — the stable id
    // is what keeps the history attached.
    const user = asUserId(
      await createLocalUser(owner, "newly-linked@balances.ses.test", "Linked"),
    );
    await owner`
      update public.members set user_id = ${user}::uuid
       where id = ${shadow}::uuid
    `;

    const [dueAfter] = await owner<{ total: string; count: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as total, count(*)::text as count
        from public.dues where member_id = ${shadow}::uuid
    `;
    expect(dueAfter?.total).toBe(dueBefore?.total);
    expect(dueAfter?.count).toBe(dueBefore?.count);
    expect(await balanceOf(shadow)).toEqual(balanceBefore);
    // And the balance row is still unique per member: no second row appeared.
    const [rowCount] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.member_balances
       where member_id = ${shadow}::uuid
    `;
    expect(rowCount?.count).toBe("1");

    // The newly linked owner can now read exactly their own balance.
    const visible = await harness.unitOfWork.transaction(
      { kind: "user", userId: user },
      (tx) =>
        rows<{ member_id: string }>(
          tx,
          sql`select member_id from public.member_balances`,
        ),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.member_id).toBe(shadow);
  });
});

// ── the documented Down block ────────────────────────────────────────────────

/**
 * The migration's own `Down` block, read out of the file rather than copied into
 * this test, so the two cannot drift. The runner is forward-only (ADR-0008), and
 * every migration answers that with a hand-written block in its header; this test
 * executes it inside one transaction and re-applies the file over it, which the
 * guarded `IF NOT EXISTS` / `CREATE OR REPLACE` statements make a cycle rather
 * than a one-way door (the convention T060's schema spec established).
 */
function extractDownStatements(source: string): readonly string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes("Down (run by hand"));
  const statements: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("--")) break;
    const stripped = line.replace(/^--\s?/, "").trim();
    if (stripped.endsWith(";")) statements.push(stripped);
  }
  return statements;
}

const MIGRATION_FILENAME = "20261006120000_member_balances.sql";

describe("the documented Down block", () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(
      join(resolveMigrationsDir(), MIGRATION_FILENAME),
      "utf8",
    );
  });

  beforeEach(async () => {
    await resetData(owner);
  });

  it("is present, executable, and the file re-applies over it", async () => {
    const statements = extractDownStatements(source);
    expect(statements.length).toBeGreaterThanOrEqual(4);
    expect(
      statements.some((line) =>
        line.startsWith("DROP TABLE IF EXISTS public.member_balances"),
      ),
    ).toBe(true);
    expect(
      statements.some((line) =>
        line.includes("DROP INDEX IF EXISTS public.uq_dues_split"),
      ),
    ).toBe(true);

    await owner.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }

      const [gone] = await tx<
        { balances: string | null; index: string | null; fn: string }[]
      >`
        select to_regclass('public.member_balances')::text as balances,
               to_regclass('public.uq_dues_split')::text as index,
               (select count(*)::text from pg_proc where proname = 'chk_due_billable') as fn
      `;
      expect(gone).toEqual({ balances: null, index: null, fn: "0" });

      // Re-apply this file **and every later one**, the way the runner would:
      // the T067 chain is `20261006120000` (the schema and function), `…130000`
      // and `…140000` (the function's two live-database fixes) and `…150000` (the
      // policy predicate that keeps T060's Down rehearsal executable). Re-applying
      // only `source` would leave the container with the first function version.
      const chain = readdirSync(resolveMigrationsDir())
        .filter(
          (entry) => entry >= MIGRATION_FILENAME && entry.endsWith(".sql"),
        )
        .sort();
      for (const entry of chain) {
        await tx.unsafe(
          readFileSync(join(resolveMigrationsDir(), entry), "utf8"),
        );
      }

      const [restored] = await tx<
        { balances: string | null; index: string | null; trigger: string }[]
      >`
        select to_regclass('public.member_balances')::text as balances,
               to_regclass('public.uq_dues_split')::text as index,
               (select count(*)::text from pg_trigger
                 where tgname = 'trg_due_billable_write' and not tgisinternal) as trigger
      `;
      expect(restored).toEqual({
        balances: "member_balances",
        index: "uq_dues_split",
        trigger: "1",
      });
    });
  });
});
