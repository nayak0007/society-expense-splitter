import { Money, asMemberId, asUserId, weight } from "@ses/domain";
import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseId,
  ExpenseSplitRepository,
  MemberId,
  PublishExpenseAllocation,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { EXPENSE_SPLIT_REPOSITORY } from "../../src/modules/expenses/application/expense.tokens";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { ListRevisionsUseCase } from "../../src/modules/expenses/application/use-cases/list-revisions.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import { UpdateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/update-expense.use-case";

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
 * The published revision lifecycle against real PostgreSQL, real RLS and the real
 * `expense_recalculate()` definer function — Roadmap T068, ADR-0009.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes the split writer and the revision reader, so it can pin the
 * contract, the guard chain and the dispatch. Everything T068's acceptance actually
 * turns on is a fact about committed rows:
 *
 *  - the **due lifecycle** — a retained due keeps its id and its `paid_paise`, a
 *    removed unpaid one is `superseded` and never deleted, its obsolete split goes
 *    away and the due survives the split's deletion (`ON DELETE SET NULL (split_id)`);
 *  - the **paid-obligation block** — a revision that would put an obligation below a
 *    verified payment refuses the whole operation, atomically, and a decrease that
 *    stays at or above what was paid succeeds;
 *  - the **exact balance deltas** and the recomputed `oldest_due_date`, with
 *    `total_paid_paise` and `advance_paise` untouched;
 *  - the **conservation invariant** over `expense_splits` and current principal dues,
 *    with superseded dues excluded;
 *  - the **revision row**: exactly one per successful revision, carrying the PRE-edit
 *    version and the BEFORE snapshot, append-only;
 *  - the **row lock** (two concurrent revisions: exactly one wins), the **rollback**
 *    of a refused revision (not one financial row written), the **RLS** boundary and
 *    the definer function's own permission and lifecycle checks.
 *
 * Fixtures are written on the **owner** connection; every call under test runs through
 * `UnitOfWork` as an acting member. `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let publish: PublishExpenseUseCase;
let updateExpense: UpdateExpenseUseCase;
let createExpense: CreateExpenseUseCase;
let listRevisions: ListRevisionsUseCase;
let splits: ExpenseSplitRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  publish = harness.app.get(PublishExpenseUseCase);
  updateExpense = harness.app.get(UpdateExpenseUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  listRevisions = harness.app.get(ListRevisionsUseCase);
  splits = harness.app.get<ExpenseSplitRepository>(EXPENSE_SPLIT_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

/** Every table a revision may write. A refused revision must touch none of them. */
const FINANCIAL_TABLES = [
  "expenses",
  "expense_splits",
  "expense_revisions",
  "dues",
  "member_balances",
] as const;

async function tableCount(table: string): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count from public.${owner(table)}
  `;
  return Number(row?.count ?? "0");
}

async function financialCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    counts[table] = await tableCount(table);
  }
  return counts;
}

interface FlatSpec {
  readonly number: string;
  readonly floor?: number;
  readonly carpetAreaSqft?: string;
  readonly occupancy?: "owner_occupied" | "rented";
}

/** One billable flat plus its owner member, inserted as the owner. */
async function insertFlatWithOwner(
  societyId: SocietyId,
  buildingId: BuildingId,
  spec: FlatSpec,
): Promise<{ apartmentId: ApartmentId; memberId: MemberId }> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.apartments (
      society_id, building_id, apartment_number, floor,
      carpet_area_sqft, builtup_area_sqft, share_units,
      occupancy_status, is_billable
    )
    values (
      ${societyId}::uuid,
      ${buildingId}::uuid,
      ${spec.number},
      ${spec.floor ?? 1}::smallint,
      ${spec.carpetAreaSqft ?? null}::numeric(8, 2),
      ${spec.carpetAreaSqft ?? null}::numeric(8, 2),
      '1'::numeric(8, 3),
      ${spec.occupancy ?? "owner_occupied"}::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  const apartmentId = row!.id as ApartmentId;
  const memberId = await insertMember(owner, societyId, {
    apartmentId,
    occupancy: spec.occupancy === "rented" ? "vacant_owner" : "owner_occupied",
    isPrimary: true,
    displayName: `Owner ${spec.number}`,
  });
  return { apartmentId, memberId: memberId as MemberId };
}

interface Fixture extends SocietyFixture {
  readonly north: BuildingId;
  readonly flats: readonly ApartmentId[];
  readonly members: readonly MemberId[];
  readonly other: SocietyFixture;
  readonly categoryId: ExpenseCategoryId;
  readonly committeeUserId: UserId;
}

/** A society with one building, `flatCount` flats with owners and a "Lift" category. */
async function seed(flatCount = 4): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Revision Court",
    "admin@revision.ses.test",
  );
  const north = await insertBuilding(owner, society.societyId, "North Block");

  const flats: ApartmentId[] = [];
  const members: MemberId[] = [];
  for (let index = 1; index <= flatCount; index += 1) {
    const flat = await insertFlatWithOwner(society.societyId, north, {
      number: `R${String(index).padStart(3, "0")}`,
      floor: ((index - 1) % 8) + 1,
      carpetAreaSqft: `${700 + index}`,
      occupancy: index % 5 === 0 ? "rented" : "owner_occupied",
    });
    flats.push(flat.apartmentId);
    members.push(flat.memberId);
  }

  const committeeUserId = asUserId(
    await createLocalUser(owner, "committee@revision.ses.test", "Committee"),
  );
  await insertMember(owner, society.societyId, {
    userId: committeeUserId,
    role: "committee_member",
    displayName: "Committee Member",
  });

  const other = await seedSociety(
    harness,
    "Other Revision Court",
    "admin@otherrevision.ses.test",
  );

  return {
    ...society,
    north,
    flats,
    members,
    other,
    categoryId: await categoryIdOf(
      society.societyId,
      society.adminUserId,
      "Lift",
    ),
    committeeUserId,
  };
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

/** Creates a real draft through T065's own use case. */
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
      expenseDate: "2026-09-30",
      categoryId: fixture.categoryId as string,
      ...overrides,
    },
  );
  return record.id;
}

let keyCounter = 0;

/** Creates and publishes a draft, returning the published expense's id. */
async function published(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<ExpenseId> {
  const expenseId = await createDraft(fixture, overrides);
  keyCounter += 1;
  await publish.publish(fixture.adminUserId, fixture.societyId, expenseId, {
    expectedVersion: 1,
    idempotencyKey: `t068-publish-${String(keyCounter).padStart(4, "0")}`,
  });
  return expenseId;
}

/**
 * T068's own door, exactly as the route reaches it: the real dispatch → the real
 * recalculation use case → the real split engine → `expense_recalculate()`.
 *
 * Going through the use case (rather than calling the repository port with prepared
 * allocations) is deliberate: it is the path a client takes, so the resolver, the
 * engine, the field mapping and the error translation are all exercised together.
 */
async function revise(
  fixture: Fixture,
  expenseId: ExpenseId,
  patch: Record<string, unknown>,
  options: {
    readonly actor?: UserId;
    readonly expectedVersion?: number;
  } = {},
) {
  const outcome = await updateExpense.update(
    options.actor ?? fixture.adminUserId,
    fixture.societyId,
    expenseId,
    {
      expectedVersion: options.expectedVersion ?? 2,
      ...patch,
    } as unknown as Parameters<UpdateExpenseUseCase["update"]>[3],
  );
  return outcome.recalculation;
}

/** The conservation invariant, asserted after every successful revision (proof 31). */
async function expectConserved(expenseId: ExpenseId): Promise<void> {
  const { amount, splitSum, dueSum } = await conservationOf(expenseId);
  expect(splitSum).toBe(amount);
  expect(dueSum).toBe(amount);
}

/** The due of one member, current or superseded. */
function dueForMember(
  dues: readonly DueRow[],
  memberId: MemberId,
): DueRow | undefined {
  return dues.find((due) => due.member_id === memberId);
}

/** One member's `member_balances` row after a revision, as bigint. */
async function balanceNumbers(memberId: MemberId): Promise<{
  readonly totalDue: bigint;
  readonly totalPaid: bigint;
  readonly outstanding: bigint;
  readonly advance: bigint;
  readonly oldestDueDate: string | null;
}> {
  const row = await balanceOf(memberId);
  return {
    totalDue: BigInt(row?.total_due_paise ?? "0"),
    totalPaid: BigInt(row?.total_paid_paise ?? "0"),
    outstanding: BigInt(row?.outstanding_paise ?? "0"),
    advance: BigInt(row?.advance_paise ?? "0"),
    oldestDueDate: row?.oldest_due_date ?? null,
  };
}

/** The thrown error, whatever shape it arrived in — an AppError or an ExpenseError. */
async function failureOf(
  promise: Promise<unknown>,
): Promise<{ code: unknown; message: string; details: unknown }> {
  try {
    await promise;
  } catch (error: unknown) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      payload?: { details?: unknown };
    };
    return {
      code: candidate.code,
      message: typeof candidate.message === "string" ? candidate.message : "",
      details: candidate.payload?.details ?? candidate.details,
    };
  }
  throw new Error("Expected the call to be refused.");
}

// ── row readers: the facts a committed revision must leave behind ─────────────

interface DueRow {
  readonly id: string;
  readonly member_id: string;
  readonly apartment_id: string | null;
  readonly split_id: string | null;
  readonly amount_paise: string;
  readonly paid_paise: string;
  readonly status: string;
  readonly kind: string;
  readonly due_date: string;
}

async function duesOf(expenseId: ExpenseId): Promise<readonly DueRow[]> {
  return owner<DueRow[]>`
    select id, member_id, apartment_id, split_id, amount_paise::text,
           paid_paise::text, status, kind, due_date::text
      from public.dues
     where expense_id = ${expenseId}::uuid
     order by created_at, id
  `;
}

interface BalanceRow {
  readonly member_id: string;
  readonly total_due_paise: string;
  readonly total_paid_paise: string;
  readonly outstanding_paise: string;
  readonly advance_paise: string;
  readonly oldest_due_date: string | null;
}

async function balanceOf(memberId: MemberId): Promise<BalanceRow | undefined> {
  const [row] = await owner<BalanceRow[]>`
    select member_id, total_due_paise::text, total_paid_paise::text,
           outstanding_paise::text, advance_paise::text, oldest_due_date::text
      from public.member_balances
     where member_id = ${memberId}::uuid
  `;
  return row;
}

/** `SUM(splits)` and `SUM(current principal dues)` — the two halves of conservation. */
async function conservationOf(expenseId: ExpenseId): Promise<{
  readonly amount: bigint;
  readonly splitSum: bigint;
  readonly dueSum: bigint;
}> {
  const [expenseRow] = await owner<{ amount_paise: string }[]>`
    select amount_paise::text from public.expenses where id = ${expenseId}::uuid
  `;
  const [splitRow] = await owner<{ total: string }[]>`
    select coalesce(sum(amount_paise), 0)::text as total
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
  `;
  const [dueRow] = await owner<{ total: string }[]>`
    select coalesce(sum(amount_paise), 0)::text as total
      from public.dues
     where expense_id = ${expenseId}::uuid
       and kind = 'principal'
       and status <> 'superseded'
  `;
  return {
    amount: BigInt(expenseRow?.amount_paise ?? "0"),
    splitSum: BigInt(splitRow?.total ?? "0"),
    dueSum: BigInt(dueRow?.total ?? "0"),
  };
}

interface RevisionRow {
  readonly id: string;
  readonly version: number;
  readonly snapshot: {
    readonly expense: Record<string, unknown>;
    readonly splits: readonly Record<string, unknown>[];
  };
  readonly changed_by: string;
  readonly change_note: string | null;
}

async function revisionsOf(
  expenseId: ExpenseId,
): Promise<readonly RevisionRow[]> {
  return owner<RevisionRow[]>`
    select id, version, snapshot, changed_by, change_note
      from public.expense_revisions
     where expense_id = ${expenseId}::uuid
     order by version
  `;
}

/** Pays `amount` paise against one due — the fixture's stand-in for T069's allocator. */
async function payDue(dueId: string, societyId: SocietyId, amount: bigint) {
  await owner`
    update public.dues
       set paid_paise = ${amount.toString()}::bigint,
           status = (case
             when ${amount.toString()}::bigint >= amount_paise then 'paid'
             else 'partial'
           end)::public.due_status
     where id = ${dueId}::uuid
  `;
  const [due] = await owner<{ member_id: string }[]>`
    select member_id from public.dues where id = ${dueId}::uuid
  `;
  await owner`
    update public.member_balances
       set total_paid_paise = total_paid_paise + ${amount.toString()}::bigint,
           outstanding_paise = outstanding_paise - ${amount.toString()}::bigint
     where member_id = ${due!.member_id}::uuid
       and society_id = ${societyId}::uuid
  `;
}

describe("schema and enum", () => {
  it("accepts `superseded` on public.due_status (proof 1)", async () => {
    const [row] = await owner<{ values: string[] }[]>`
      select array_agg(enumlabel order by enumsortorder) as values
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
       where t.typname = 'due_status'
    `;
    expect(row?.values).toContain("superseded");
  });

  it("keeps the release's migration chain applied, repair included (migration #29)", async () => {
    const rows = await owner<{ name: string }[]>`
      select name from ses_meta.migrations order by name
    `;
    expect(rows.length).toBeGreaterThanOrEqual(28);
    // The recalculation repair travels as its own forward migration: #28 was
    // applied before the defect was found, and the ledger's checksum forbids
    // editing it in place.
    expect(rows.map((row) => row.name)).toContain(
      "20261007140000_fix_expense_recalculate_return_types.sql",
    );
  });

  it("refuses a current principal due with no split, and a second one per participant (proofs 32, 33)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const [expenseRow] = await owner<{ amount_paise: string }[]>`
      select amount_paise::text from public.expenses where id = ${expenseId}::uuid
    `;

    // 32 · A current principal due with NULL split violates chk_due_current_split_present.
    await expect(
      owner`
        insert into public.dues (
          society_id, apartment_id, member_id, expense_id, split_id, kind,
          amount_paise, status, due_date
        )
        values (
          ${fixture.societyId}::uuid, ${fixture.flats[0]!}::uuid,
          ${fixture.members[0]!}::uuid, ${expenseId}::uuid, null, 'principal',
          '100'::bigint, 'pending', '2026-10-31'
        )
      `,
    ).rejects.toThrow(/chk_due_current_split_present/);

    // 33 · A second current principal due for the same participant violates
    //      uq_dues_current_participant. The insert needs a split of its own —
    //      `uq_dues_split` would otherwise refuse it first — so it borrows a
    //      freshly created, zero-amount split for another participant.
    const [borrowed] = await owner<{ id: string }[]>`
      insert into public.expense_splits (
        society_id, expense_id, member_id, apartment_id, amount_paise
      )
      values (
        ${fixture.societyId}::uuid, ${expenseId}::uuid,
        ${fixture.members[0]!}::uuid, ${fixture.flats[1]!}::uuid, '0'::bigint
      )
      returning id
    `;
    await expect(
      owner`
        insert into public.dues (
          society_id, apartment_id, member_id, expense_id, split_id, kind,
          amount_paise, status, due_date
        )
        values (
          ${fixture.societyId}::uuid, ${fixture.flats[0]!}::uuid,
          ${fixture.members[0]!}::uuid, ${expenseId}::uuid,
          ${borrowed!.id}::uuid, 'principal',
          '100'::bigint, 'pending', '2026-10-31'
        )
      `,
    ).rejects.toThrow(/uq_dues_current_participant/);

    expect(expenseRow?.amount_paise).toBe("400000");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2–31 · the lifecycle proofs
// ═════════════════════════════════════════════════════════════════════════════

/** One current allocation — the split a current due points at. */
interface SplitRow {
  readonly id: string;
  readonly member_id: string | null;
  readonly apartment_id: string | null;
  readonly amount_paise: string;
}

async function splitsOf(expenseId: ExpenseId): Promise<readonly SplitRow[]> {
  return owner<SplitRow[]>`
    select id, member_id, apartment_id, amount_paise::text
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
     order by created_at, id
  `;
}

interface ExpenseRow {
  readonly amount_paise: string;
  readonly version: number;
  readonly status: string;
  readonly split_strategy: string;
  readonly apartment_basis: string | null;
  readonly split_config: Record<string, unknown>;
  readonly participant_selector: Record<string, unknown>;
  readonly due_date: string | null;
}

async function expenseOf(expenseId: ExpenseId): Promise<ExpenseRow> {
  const [row] = await owner<ExpenseRow[]>`
    select amount_paise::text, version, status::text, split_strategy::text,
           apartment_basis::text, split_config, participant_selector,
           due_date::text
      from public.expenses
     where id = ${expenseId}::uuid
  `;
  if (row === undefined) throw new Error("The expense vanished mid-test.");
  return row;
}

/**
 * One prepared allocation, in the shape both write paths read.
 *
 * Built by hand only where a proof deliberately reaches around the split engine
 * (the rollback proof and the function's own authorization check); everywhere else
 * the engine's own output travels.
 */
function allocation(
  memberId: MemberId,
  apartmentId: ApartmentId | null,
  amountPaise: bigint,
): PublishExpenseAllocation {
  return {
    memberId,
    // `null` is a member-only allocation and survives JSON as a null the function
    // reads with `NULLIF(entry ->> 'apartment_id', '')`.
    apartmentId: apartmentId as ApartmentId,
    amount: Money.fromPaise(amountPaise),
    weight: weight(1n),
    percent: null,
    assignedReason: null,
    snapshot: { memberName: "Fixture Member", apartmentNumber: "—" },
  };
}

/** Gives an existing member row a login, as the membership write paths do. */
async function attachUser(
  memberId: MemberId,
  email: string,
  displayName: string,
): Promise<UserId> {
  const userId = asUserId(await createLocalUser(owner, email, displayName));
  await owner`
    update public.members set user_id = ${userId}::uuid where id = ${memberId}::uuid
  `;
  return userId;
}

describe("retained obligations", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("raises every retained obligation in place, keeping due identity and paid_paise (proofs 2, 12, 13, 18, 19, 20, 31)", async () => {
    const expenseId = await published(fixture);
    const duesBefore = await duesOf(expenseId);
    const member0 = fixture.members[0]!;
    const paidDue = dueForMember(duesBefore, member0)!;
    await payDue(paidDue.id, fixture.societyId, 30_000n);
    const balanceBefore = await balanceNumbers(member0);

    const recalculation = await revise(fixture, expenseId, {
      amountPaise: 600_000,
      changeNote: "Raised after the AMC quote.",
    });
    expect(recalculation).not.toBeNull();
    expect(recalculation!.summary).toMatchObject({
      duesUpdated: 4,
      duesSuperseded: 0,
      duesCreated: 0,
      affectedMembers: 4,
      blockedByPaidSplits: 0,
    });
    expect(recalculation!.summary.totalDelta.paise).toBe(200_000n);

    const expense = await expenseOf(expenseId);
    expect(expense.amount_paise).toBe("600000");
    expect(expense.version).toBe(3);

    const duesAfter = await duesOf(expenseId);
    expect(duesAfter).toHaveLength(4);

    // The paid obligation keeps its row, its id and its payment; the amount moves
    // to the new authoritative split amount (proof 2) and the status follows.
    const retainedPaid = dueForMember(duesAfter, member0)!;
    expect(retainedPaid.id).toBe(paidDue.id);
    expect(retainedPaid.amount_paise).toBe("150000");
    expect(retainedPaid.paid_paise).toBe("30000");
    expect(retainedPaid.status).toBe("partial");
    expect(retainedPaid.split_id).not.toBeNull();

    for (const member of fixture.members.slice(1)) {
      const before = dueForMember(duesBefore, member)!;
      const after = dueForMember(duesAfter, member)!;
      expect(after.id).toBe(before.id);
      expect(after.amount_paise).toBe("150000");
      expect(after.paid_paise).toBe("0");
      expect(after.status).toBe("pending");
    }

    // Exact deltas, and the two columns a revision must never touch (proofs 18–20).
    const balanceAfter = await balanceNumbers(member0);
    expect(balanceAfter.totalDue - balanceBefore.totalDue).toBe(50_000n);
    expect(balanceAfter.outstanding - balanceBefore.outstanding).toBe(50_000n);
    expect(balanceAfter.totalDue).toBe(150_000n);
    expect(balanceAfter.outstanding).toBe(120_000n);
    expect(balanceAfter.totalPaid).toBe(balanceBefore.totalPaid);
    expect(balanceAfter.advance).toBe(balanceBefore.advance);
    expect(balanceAfter.totalPaid).toBe(30_000n);

    const revisions = await revisionsOf(expenseId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.version).toBe(2);
    expect(revisions[0]!.changed_by).toBe(fixture.adminMemberId);
    expect(revisions[0]!.change_note).toBe("Raised after the AMC quote.");
    expect(revisions[0]!.snapshot.expense["amount_paise"]).toBe("400000");
    expect(revisions[0]!.snapshot.expense["version"]).toBe(2);
    expect(revisions[0]!.snapshot.splits).toHaveLength(4);
    expect(
      revisions[0]!.snapshot.splits
        .map((split) => split["amount_paise"])
        .sort(),
    ).toEqual(["100000", "100000", "100000", "100000"]);

    await expectConserved(expenseId);
  });

  it("lowers a retained obligation to at or above what was paid (proofs 3, 8, 13)", async () => {
    const expenseId = await published(fixture);
    const duesBefore = await duesOf(expenseId);
    const member1 = fixture.members[1]!;
    await payDue(
      dueForMember(duesBefore, member1)!.id,
      fixture.societyId,
      30_000n,
    );
    const balanceBefore = await balanceNumbers(member1);

    const recalculation = await revise(fixture, expenseId, {
      amountPaise: 300_000,
    });
    expect(recalculation).not.toBeNull();
    expect(recalculation!.summary).toMatchObject({
      duesUpdated: 4,
      duesSuperseded: 0,
      duesCreated: 0,
    });
    expect(recalculation!.summary.totalDelta.paise).toBe(-100_000n);

    const duesAfter = await duesOf(expenseId);
    const retained = dueForMember(duesAfter, member1)!;
    expect(retained.id).toBe(dueForMember(duesBefore, member1)!.id);
    expect(retained.amount_paise).toBe("75000");
    expect(retained.paid_paise).toBe("30000");
    expect(retained.status).toBe("partial");

    for (const member of fixture.members.filter((id) => id !== member1)) {
      const after = dueForMember(duesAfter, member)!;
      expect(after.amount_paise).toBe("75000");
      expect(after.status).toBe("pending");
    }

    const balanceAfter = await balanceNumbers(member1);
    expect(balanceAfter.totalDue).toBe(75_000n);
    expect(balanceAfter.outstanding).toBe(45_000n);
    expect(balanceAfter.totalDue - balanceBefore.totalDue).toBe(-25_000n);
    expect(balanceAfter.outstanding - balanceBefore.outstanding).toBe(-25_000n);
    expect(balanceAfter.totalPaid).toBe(balanceBefore.totalPaid);
    expect(balanceAfter.advance).toBe(balanceBefore.advance);

    await expectConserved(expenseId);
  });
});

describe("removed participants", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("supersedes a removed unpaid due and deletes only its split (proofs 5, 14, 15, 16, 17, 21, 31)", async () => {
    const expenseId = await published(fixture, { amountPaise: 300_000 });
    const duesBefore = await duesOf(expenseId);
    const splitsBefore = await splitsOf(expenseId);
    const removedMember = fixture.members[3]!;
    const removedDue = dueForMember(duesBefore, removedMember)!;
    const removedSplit = splitsBefore.find(
      (split) => split.member_id === removedMember,
    )!;
    const removedBalanceBefore = await balanceNumbers(removedMember);

    const recalculation = await revise(fixture, expenseId, {
      participantSelector: { excludeApartments: [fixture.flats[3]!] },
    });
    expect(recalculation).not.toBeNull();
    expect(recalculation!.summary).toMatchObject({
      duesUpdated: 3,
      duesSuperseded: 1,
      duesCreated: 0,
      affectedMembers: 4,
    });
    expect(recalculation!.summary.totalDelta.paise).toBe(0n);

    const expense = await expenseOf(expenseId);
    expect(expense.amount_paise).toBe("300000");
    expect(expense.version).toBe(3);
    expect(expense.participant_selector["excludeApartments"]).toEqual([
      fixture.flats[3]!,
    ]);

    // The due is never deleted: same id, historical amount, no current split, and
    // it is excluded from conservation and from the balance projection.
    const duesAfter = await duesOf(expenseId);
    expect(duesAfter).toHaveLength(4);
    const superseded = dueForMember(duesAfter, removedMember)!;
    expect(superseded.id).toBe(removedDue.id);
    expect(superseded.status).toBe("superseded");
    expect(superseded.amount_paise).toBe("75000");
    expect(superseded.paid_paise).toBe("0");
    expect(superseded.split_id).toBeNull();

    const splitsAfter = await splitsOf(expenseId);
    expect(splitsAfter).toHaveLength(3);
    expect(splitsAfter.some((split) => split.id === removedSplit.id)).toBe(
      false,
    );
    expect(
      splitsAfter.some((split) => split.apartment_id === fixture.flats[3]!),
    ).toBe(false);

    // Retained rows keep both their own and their split's identity.
    for (const member of fixture.members.slice(0, 3)) {
      const retained = dueForMember(duesAfter, member)!;
      expect(retained.id).toBe(dueForMember(duesBefore, member)!.id);
      expect(retained.status).toBe("pending");
      expect(retained.amount_paise).toBe("100000");
      const split = splitsAfter.find((entry) => entry.id === retained.split_id);
      expect(split?.amount_paise).toBe("100000");
    }

    // The removed member's balance and its oldest open due are recomputed, not
    // patched with the publish-time LEAST (proof 21).
    const removedBalance = await balanceNumbers(removedMember);
    expect(removedBalance.totalDue).toBe(
      removedBalanceBefore.totalDue - 75_000n,
    );
    expect(removedBalance.totalDue).toBe(0n);
    expect(removedBalance.outstanding).toBe(0n);
    expect(removedBalance.oldestDueDate).toBeNull();

    await expectConserved(expenseId);
  });
});

describe("added participants", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("creates the added participant's split and due, dated by the publish rule (proofs 4, 21, 31)", async () => {
    const expenseId = await published(fixture, {
      amountPaise: 300_000,
      participantSelector: { excludeApartments: [fixture.flats[3]!] },
    });
    const duesBefore = await duesOf(expenseId);
    expect(duesBefore).toHaveLength(3);
    const addedMember = fixture.members[3]!;
    expect(await balanceOf(addedMember)).toBeUndefined();

    const recalculation = await revise(fixture, expenseId, {
      participantSelector: {},
    });
    expect(recalculation).not.toBeNull();
    expect(recalculation!.summary).toMatchObject({
      duesUpdated: 3,
      duesSuperseded: 0,
      duesCreated: 1,
      affectedMembers: 4,
    });
    expect(recalculation!.summary.totalDelta.paise).toBe(0n);

    const duesAfter = await duesOf(expenseId);
    expect(duesAfter).toHaveLength(4);
    const created = dueForMember(duesAfter, addedMember)!;
    expect(created.amount_paise).toBe("75000");
    expect(created.status).toBe("pending");
    expect(created.paid_paise).toBe("0");
    expect(created.split_id).not.toBeNull();
    expect(created.apartment_id).toBe(fixture.flats[3]);
    // The due date is publish's own rule (the expense has none, so the society's
    // due day), which is why it matches the dues already there.
    expect(created.due_date).toBe(duesBefore[0]!.due_date);

    const createdSplit = (await splitsOf(expenseId)).find(
      (split) => split.id === created.split_id,
    )!;
    expect(createdSplit.member_id).toBe(addedMember);
    expect(createdSplit.apartment_id).toBe(fixture.flats[3]);
    expect(createdSplit.amount_paise).toBe("75000");

    const balance = await balanceNumbers(addedMember);
    expect(balance.totalDue).toBe(75_000n);
    expect(balance.outstanding).toBe(75_000n);
    expect(balance.oldestDueDate).toBe(duesBefore[0]!.due_date);

    // The participants that stayed keep their identity; only the amount moved.
    for (const member of fixture.members.slice(0, 3)) {
      const retained = dueForMember(duesAfter, member)!;
      expect(retained.id).toBe(dueForMember(duesBefore, member)!.id);
      expect(retained.amount_paise).toBe("75000");
    }

    await expectConserved(expenseId);
  });
});

describe("the paid-obligation block", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed(2);
  });

  it("refuses to remove a partially paid participant, atomically (proof 6)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });
    const member0 = fixture.members[0]!;
    await payDue(
      dueForMember(await duesOf(expenseId), member0)!.id,
      fixture.societyId,
      30_000n,
    );
    const duesBefore = await duesOf(expenseId);
    const countsBefore = await financialCounts();
    const expenseBefore = await expenseOf(expenseId);

    const failure = await failureOf(
      revise(fixture, expenseId, {
        participantSelector: { excludeApartments: [fixture.flats[0]!] },
      }),
    );
    expect(failure.code).toBe("CONFLICT");
    expect(failure.message).toMatch(/credit adjustment/i);
    expect(JSON.stringify(failure.details)).toContain(
      "DUE_PAID_EXCEEDS_NEW_AMOUNT",
    );

    // Not one financial row was written.
    expect(await financialCounts()).toEqual(countsBefore);
    expect(await expenseOf(expenseId)).toEqual(expenseBefore);
    expect(await revisionsOf(expenseId)).toHaveLength(0);
    expect(await duesOf(expenseId)).toEqual(duesBefore);
    await expectConserved(expenseId);
  });

  it("refuses a decrease below a partially paid obligation (proof 9)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });
    const member0 = fixture.members[0]!;
    await payDue(
      dueForMember(await duesOf(expenseId), member0)!.id,
      fixture.societyId,
      30_000n,
    );
    const countsBefore = await financialCounts();

    const failure = await failureOf(
      revise(fixture, expenseId, { amountPaise: 40_000 }),
    );
    expect(failure.code).toBe("CONFLICT");
    expect(JSON.stringify(failure.details)).toContain(
      "DUE_PAID_EXCEEDS_NEW_AMOUNT",
    );
    expect((await expenseOf(expenseId)).amount_paise).toBe("200000");
    expect(await financialCounts()).toEqual(countsBefore);
    expect(await revisionsOf(expenseId)).toHaveLength(0);
  });

  it("refuses to remove a fully paid participant (proof 7)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });
    const member1 = fixture.members[1]!;
    const paid = dueForMember(await duesOf(expenseId), member1)!;
    await payDue(paid.id, fixture.societyId, 100_000n);
    expect(dueForMember(await duesOf(expenseId), member1)!.status).toBe("paid");

    const failure = await failureOf(
      revise(fixture, expenseId, {
        participantSelector: { excludeApartments: [fixture.flats[1]!] },
      }),
    );
    expect(failure.code).toBe("CONFLICT");
    expect(JSON.stringify(failure.details)).toContain(
      "DUE_PAID_EXCEEDS_NEW_AMOUNT",
    );
    expect(await revisionsOf(expenseId)).toHaveLength(0);
    expect(dueForMember(await duesOf(expenseId), member1)!.status).toBe("paid");
    await expectConserved(expenseId);
  });

  it("rolls every write back when a later write in the same transaction fails (proof 27)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });
    const member0 = fixture.members[0]!;
    const member1 = fixture.members[1]!;
    const duesBefore = await duesOf(expenseId);
    const countsBefore = await financialCounts();
    const expenseBefore = await expenseOf(expenseId);
    const balancesBefore = new Map<
      MemberId,
      Awaited<ReturnType<typeof balanceNumbers>>
    >();
    for (const member of fixture.members) {
      balancesBefore.set(member, await balanceNumbers(member));
    }

    // A plan whose amounts sum to the new total but which names the same
    // member-only allocation twice: the engine never produces it, the function's
    // sum check accepts it, and the database's own `uq_expense_splits_participant`
    // refuses the duplicate insert — after the retained rows have already been
    // written, so this is a genuine mid-write failure rather than an early refusal.
    const failure = await failureOf(
      splits.recalculate(
        expenseId,
        fixture.societyId,
        {
          expectedVersion: 2,
          fields: {},
          allocations: [
            allocation(member0, fixture.flats[0]!, 50_000n),
            allocation(member1, fixture.flats[1]!, 50_000n),
            allocation(member1, null, 50_000n),
            allocation(member1, null, 50_000n),
          ],
        },
        fixture.adminUserId,
      ),
    );
    expect(failure.message.length).toBeGreaterThan(0);

    expect(await financialCounts()).toEqual(countsBefore);
    expect(await expenseOf(expenseId)).toEqual(expenseBefore);
    expect(await revisionsOf(expenseId)).toHaveLength(0);
    expect(await duesOf(expenseId)).toEqual(duesBefore);
    for (const member of fixture.members) {
      expect(await balanceNumbers(member)).toEqual(balancesBefore.get(member));
    }

    // The same revision without the duplicate commits, which proves the failure
    // was the duplicate — not an unrelated refusal — and that the rollback left
    // the version the caller holds on the row.
    const accepted = await splits.recalculate(
      expenseId,
      fixture.societyId,
      {
        expectedVersion: 2,
        fields: {},
        allocations: [
          allocation(member0, fixture.flats[0]!, 100_000n),
          allocation(member1, fixture.flats[1]!, 100_000n),
        ],
      },
      fixture.adminUserId,
    );
    expect(accepted.expense.version).toBe(3);
    expect(await revisionsOf(expenseId)).toHaveLength(1);
    await expectConserved(expenseId);
  });
});

describe("strategy and routing changes", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("re-weights a retained plan when the strategy changes (proofs 10, 12, 31)", async () => {
    const expenseId = await published(fixture, { amountPaise: 400_000 });
    const duesBefore = await duesOf(expenseId);
    const splitsBefore = await splitsOf(expenseId);

    const recalculation = await revise(fixture, expenseId, {
      splitStrategy: "percentage",
      splitConfig: {
        percentages: [
          { apartmentId: fixture.flats[0]!, basisPoints: 4000 },
          { apartmentId: fixture.flats[1]!, basisPoints: 2000 },
          { apartmentId: fixture.flats[2]!, basisPoints: 2000 },
          { apartmentId: fixture.flats[3]!, basisPoints: 2000 },
        ],
      },
    });
    expect(recalculation).not.toBeNull();
    expect(recalculation!.summary).toMatchObject({
      duesUpdated: 4,
      duesSuperseded: 0,
      duesCreated: 0,
    });
    expect(recalculation!.summary.totalDelta.paise).toBe(0n);

    const expense = await expenseOf(expenseId);
    expect(expense.split_strategy).toBe("percentage");
    expect(Array.isArray(expense.split_config["percentages"])).toBe(true);
    expect(expense.version).toBe(3);

    const expected = ["160000", "80000", "80000", "80000"];
    const duesAfter = await duesOf(expenseId);
    fixture.members.forEach((member, index) => {
      const before = dueForMember(duesBefore, member)!;
      const after = dueForMember(duesAfter, member)!;
      expect(after.id).toBe(before.id);
      expect(after.amount_paise).toBe(expected[index]);
    });

    const splitsAfter = await splitsOf(expenseId);
    fixture.flats.forEach((flat, index) => {
      const before = splitsBefore.find((split) => split.apartment_id === flat)!;
      const after = splitsAfter.find((split) => split.apartment_id === flat)!;
      expect(after.id).toBe(before.id);
      expect(after.amount_paise).toBe(expected[index]);
    });

    // The BEFORE snapshot preserves the strategy that was replaced (proof 23).
    const revisions = await revisionsOf(expenseId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.snapshot.expense["split_strategy"]).toBe("equal");
    expect(revisions[0]!.snapshot.expense["amount_paise"]).toBe("400000");

    await expectConserved(expenseId);
  });

  it("re-routes a rented flat from its tenant to its owner, superseding the tenant's due (proofs 11, 21, 31)", async () => {
    // This proof needs a fifth, rented flat, so it seeds its own fixture.
    await resetData(owner);
    fixture = await seed(5);
    const rentedFlat = fixture.flats[4]!;
    const ownerMember = fixture.members[4]!;
    const tenantMember = asMemberId(
      await insertMember(owner, fixture.societyId, {
        apartmentId: rentedFlat,
        occupancy: "tenant",
        isPrimary: false,
        displayName: "Tenant R005",
      }),
    );

    const expenseId = await published(fixture, { amountPaise: 500_000 });
    const duesBefore = await duesOf(expenseId);
    expect(duesBefore).toHaveLength(5);
    const tenantDue = dueForMember(duesBefore, tenantMember)!;
    expect(tenantDue.amount_paise).toBe("100000");
    expect(dueForMember(duesBefore, ownerMember)).toBeUndefined();

    const recalculation = await revise(fixture, expenseId, {
      participantSelector: { ownerOnly: true },
    });
    expect(recalculation).not.toBeNull();
    expect(recalculation!.summary).toMatchObject({
      duesUpdated: 0,
      duesSuperseded: 1,
      duesCreated: 1,
      affectedMembers: 6,
    });
    expect(recalculation!.summary.totalDelta.paise).toBe(0n);

    const duesAfter = await duesOf(expenseId);
    const tenantAfter = dueForMember(duesAfter, tenantMember)!;
    expect(tenantAfter.id).toBe(tenantDue.id);
    expect(tenantAfter.status).toBe("superseded");
    expect(tenantAfter.amount_paise).toBe("100000");
    expect(tenantAfter.split_id).toBeNull();

    const ownerAfter = dueForMember(duesAfter, ownerMember)!;
    expect(ownerAfter.status).toBe("pending");
    expect(ownerAfter.amount_paise).toBe("100000");
    expect(ownerAfter.split_id).not.toBeNull();
    expect(ownerAfter.apartment_id).toBe(rentedFlat);

    const tenantBalance = await balanceNumbers(tenantMember);
    expect(tenantBalance.totalDue).toBe(0n);
    expect(tenantBalance.outstanding).toBe(0n);
    expect(tenantBalance.oldestDueDate).toBeNull();

    const ownerBalance = await balanceNumbers(ownerMember);
    expect(ownerBalance.totalDue).toBe(100_000n);
    expect(ownerBalance.outstanding).toBe(100_000n);

    const splitsAfter = await splitsOf(expenseId);
    expect(splitsAfter).toHaveLength(5);
    expect(splitsAfter.some((split) => split.member_id === tenantMember)).toBe(
      false,
    );

    // The snapshot names the routing that was replaced, tenant included.
    const revisions = await revisionsOf(expenseId);
    expect(revisions).toHaveLength(1);
    expect(
      revisions[0]!.snapshot.splits.some(
        (split) => split["member_id"] === tenantMember,
      ),
    ).toBe(true);

    await expectConserved(expenseId);
  });
});

describe("revision history", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("writes exactly one append-only row per revision, carrying the PRE-edit version (proofs 22, 23, 24, 31)", async () => {
    const expenseId = await published(fixture, { amountPaise: 400_000 });

    const first = await revise(fixture, expenseId, {
      amountPaise: 600_000,
      changeNote: "First revision.",
    });
    expect(first).not.toBeNull();
    const second = await revise(
      fixture,
      expenseId,
      { amountPaise: 300_000, changeNote: "Second revision." },
      { expectedVersion: 3 },
    );
    expect(second).not.toBeNull();

    const revisions = await revisionsOf(expenseId);
    expect(revisions).toHaveLength(2);
    expect(revisions.map((revision) => revision.version)).toEqual([2, 3]);
    expect(revisions[0]!.change_note).toBe("First revision.");
    expect(revisions[1]!.change_note).toBe("Second revision.");
    expect(revisions[0]!.changed_by).toBe(fixture.adminMemberId);
    expect(revisions[1]!.changed_by).toBe(fixture.adminMemberId);

    // Each snapshot is the state that revision replaced: the first carries the
    // published state, the second carries what the first committed.
    expect(revisions[0]!.snapshot.expense["amount_paise"]).toBe("400000");
    expect(revisions[0]!.snapshot.expense["version"]).toBe(2);
    expect(revisions[1]!.snapshot.expense["amount_paise"]).toBe("600000");
    expect(revisions[1]!.snapshot.expense["version"]).toBe(3);

    expect((await expenseOf(expenseId)).version).toBe(4);
    await expectConserved(expenseId);
  });

  it("replays a stale expectedVersion as a refusal with no writes (proof 25)", async () => {
    const expenseId = await published(fixture, { amountPaise: 400_000 });
    const countsBefore = await financialCounts();
    const expenseBefore = await expenseOf(expenseId);

    const failure = await failureOf(
      revise(
        fixture,
        expenseId,
        { amountPaise: 600_000 },
        { expectedVersion: 1 },
      ),
    );
    expect(failure.code).toBe("VERSION_MISMATCH");
    expect(JSON.stringify(failure.details)).toContain("expectedVersion");
    expect(JSON.stringify(failure.details)).toContain("STALE");

    expect(await financialCounts()).toEqual(countsBefore);
    expect(await expenseOf(expenseId)).toEqual(expenseBefore);
    expect(await revisionsOf(expenseId)).toHaveLength(0);
    await expectConserved(expenseId);
  });

  it("reads the history through the real reader for every permitted role (proof 30)", async () => {
    const expenseId = await published(fixture, { amountPaise: 400_000 });
    expect(
      await listRevisions.list(
        fixture.adminUserId,
        fixture.societyId,
        expenseId,
      ),
    ).toEqual([]);

    await revise(fixture, expenseId, {
      amountPaise: 600_000,
      changeNote: "History read.",
    });

    const history = await listRevisions.list(
      fixture.adminUserId,
      fixture.societyId,
      expenseId,
    );
    expect(history).toHaveLength(1);
    const revision = history[0]!;
    expect(revision.expenseId).toBe(expenseId);
    expect(revision.version).toBe(2);
    expect(revision.changedBy).toBe(fixture.adminMemberId);
    expect(revision.changeNote).toBe("History read.");
    expect(revision.snapshot.expense["amount_paise"]).toBe("400000");
    expect(revision.snapshot.splits).toHaveLength(4);

    // A resident owner and a treasurer read the same history; the matrix's
    // `expense.view` is what gates it, and the use case narrows nothing further.
    const residentUserId = await attachUser(
      fixture.members[0]!,
      "owner-history@revision.ses.test",
      "Owner R001",
    );
    const treasurerUserId = asUserId(
      await createLocalUser(
        owner,
        "treasurer-history@revision.ses.test",
        "Treasurer",
      ),
    );
    await insertMember(owner, fixture.societyId, {
      userId: treasurerUserId,
      role: "treasurer",
      displayName: "Treasurer",
    });

    for (const actor of [residentUserId, treasurerUserId]) {
      const read = await listRevisions.list(
        actor,
        fixture.societyId,
        expenseId,
      );
      expect(read.map((entry) => entry.version)).toEqual([2]);
    }
  });
});

describe("concurrency, isolation and authorization", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed(2);
  });

  it("serialises two concurrent revisions on the row lock, exactly one winning (proof 26, 31)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });

    const results = await Promise.allSettled([
      revise(fixture, expenseId, { amountPaise: 250_000 }),
      revise(fixture, expenseId, { amountPaise: 300_000 }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as { code?: unknown }).code).toBe(
      "VERSION_MISMATCH",
    );

    const expense = await expenseOf(expenseId);
    expect(expense.version).toBe(3);
    expect(["250000", "300000"]).toContain(expense.amount_paise);
    expect(await revisionsOf(expenseId)).toHaveLength(1);
    const { amount, splitSum, dueSum } = await conservationOf(expenseId);
    expect(splitSum).toBe(amount);
    expect(dueSum).toBe(amount);
  });

  it("answers cross-society ids as not found and writes nothing (proof 28)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });
    const countsBefore = await financialCounts();

    const failure = await failureOf(
      revise({ ...fixture, societyId: fixture.other.societyId }, expenseId, {
        amountPaise: 300_000,
      }),
    );
    expect(failure.code).toBe("NOT_FOUND");

    const readFailure = await failureOf(
      listRevisions.list(
        fixture.adminUserId,
        fixture.other.societyId,
        expenseId,
      ),
    );
    expect(readFailure.code).toBe("NOT_FOUND");

    expect(await financialCounts()).toEqual(countsBefore);
    expect(await revisionsOf(expenseId)).toHaveLength(0);
  });

  it("refuses roles without `expense.publish`, in the use case and in the function (proof 29)", async () => {
    const expenseId = await published(fixture, { amountPaise: 200_000 });

    const committee = await failureOf(
      revise(
        fixture,
        expenseId,
        { amountPaise: 250_000 },
        { actor: fixture.committeeUserId },
      ),
    );
    expect(committee.code).toBe("FORBIDDEN");
    expect(committee.message).toMatch(/Admin or Treasurer/);

    const residentUserId = asUserId(
      await createLocalUser(
        owner,
        "resident-revise@revision.ses.test",
        "Resident",
      ),
    );
    await insertMember(owner, fixture.societyId, {
      userId: residentUserId,
      role: "resident",
      displayName: "Resident",
    });
    const resident = await failureOf(
      revise(
        fixture,
        expenseId,
        { amountPaise: 250_000 },
        { actor: residentUserId },
      ),
    );
    expect(resident.code).toBe("FORBIDDEN");

    // The function itself refuses the same caller even when reached directly, and
    // writes nothing: the application guard is not the only guard.
    const countsBefore = await financialCounts();
    const direct = await failureOf(
      splits.recalculate(
        expenseId,
        fixture.societyId,
        {
          expectedVersion: 2,
          fields: {},
          allocations: [
            allocation(fixture.members[0]!, fixture.flats[0]!, 100_000n),
            allocation(fixture.members[1]!, fixture.flats[1]!, 100_000n),
          ],
        },
        residentUserId,
      ),
    );
    // Called directly, the repository answers with the domain refusal the use
    // case translates; on the wire (above) the same refusal is `FORBIDDEN`.
    expect(String(direct.code).toLowerCase()).toBe("forbidden");
    expect(await financialCounts()).toEqual(countsBefore);
    expect(await revisionsOf(expenseId)).toHaveLength(0);

    // A treasurer may revise; the refusal above was the role, not the request.
    const treasurerUserId = asUserId(
      await createLocalUser(
        owner,
        "treasurer-revise@revision.ses.test",
        "Treasurer",
      ),
    );
    await insertMember(owner, fixture.societyId, {
      userId: treasurerUserId,
      role: "treasurer",
      displayName: "Treasurer",
    });
    const accepted = await revise(
      fixture,
      expenseId,
      { amountPaise: 250_000 },
      { actor: treasurerUserId },
    );
    expect(accepted).not.toBeNull();
    expect(accepted!.expense.version).toBe(3);
    await expectConserved(expenseId);
  });
});
