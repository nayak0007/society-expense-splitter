import { asUserId, calculateOutstanding, paise } from "@ses/domain";
import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseEvent,
  ExpenseEventPublisher,
  ExpenseId,
  MemberId,
  SocietyId,
  UserId,
} from "@ses/domain";
import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { EXPENSE_EVENT_PUBLISHER } from "../../src/modules/expenses/application/expense.tokens";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import { UpdateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/update-expense.use-case";
import { VoidExpenseUseCase } from "../../src/modules/expenses/application/use-cases/void-expense.use-case";

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
 * The void lifecycle against real PostgreSQL, real RLS and the real
 * `expense_void()` definer function — Roadmap T069, ADR-0010.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes the split writer, so it can pin the route, the guard chain,
 * the response contract and the dispatch. Everything T069's acceptance actually
 * turns on is a fact about committed rows:
 *
 *  - the **due lifecycle** — every current principal due becomes `superseded` and
 *    **nothing is deleted**: the due keeps its id, its amount, its `paid_paise` and
 *    its `split_id`, and `expense_splits` is not touched at all (ADR-0010
 *    Decision 1);
 *  - the **exact balance arithmetic** — `total_due -= A`, `total_paid -= P`,
 *    `advance += P`, `outstanding -= A`, per member, with the balance equation
 *    `outstanding = total_due − total_paid − advance` still true afterwards and
 *    agreeing with the domain calculator (ADR-0010 Decision 2);
 *  - the **credit conversion** — a partially or fully paid due's money does not
 *    vanish; it becomes available `advance_paise`, additively when a member
 *    already carries credit, and no payment or allocation row is invented
 *    (ADR-0010 Decision 3);
 *  - the **fail-closed refusals** — a `waived`/`written_off` (or non-principal)
 *    current obligation refuses the whole void and writes nothing;
 *  - the **authorization boundary** — Committee/Resident/Guest refused,
 *    Treasurer allowed, cross-society an indistinguishable 404, and the definer
 *    function's own `42501` when reached directly;
 *  - the **write surface** — an authenticated direct `DELETE` on `expenses` or
 *    `dues` is refused at the grant level, and an authenticated direct `UPDATE`
 *    cannot complete a void (the lifecycle stamps are not client-writable and the
 *    completeness constraint refuses the half-write);
 *  - the **ordering and locking** — one transaction, two concurrent voids leave
 *    exactly one winner, void and recalculation serialise, a genuine failure
 *    rolls every financial table back, and `expense.voided` is dispatched only
 *    after the commit (and not at all after a refusal).
 *
 * Fixtures are written on the **owner** connection; every call under test runs
 * through `UnitOfWork` as an acting member. `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

/**
 * The dispatch seam, observed.
 *
 * The harness boots the **real** module with its real infrastructure, so the
 * publisher binding is production's (`LoggingExpenseEventPublisher`). That is
 * deliberate — but it logs and proves nothing, so this suite shadows the one
 * method on the *instance* the use case already holds. Nothing else changes: the
 * ordering guarantee under test is the application's, and the world is inspected
 * from inside `dispatch`, which is the only place "after commit" can be observed.
 */
interface ObservedDispatch {
  readonly events: readonly ExpenseEvent[];
  readonly statusAtDispatch: string | null;
}

const observed: ObservedDispatch[] = [];

/**
 * Only the void dispatches — the publish path announces itself too, and this suite
 * asserts about the event *it* is responsible for.
 */
function voidDispatches(): readonly ObservedDispatch[] {
  return observed.filter((entry) =>
    entry.events.some((event) => event.name === "expense.voided"),
  );
}

async function statusAtDispatch(expenseId: ExpenseId): Promise<string | null> {
  const [row] = await owner<{ status: string }[]>`
    select status::text as status from public.expenses where id = ${expenseId}::uuid
  `;
  return row?.status ?? null;
}

beforeAll(() => {
  const publisher = harness.app.get<ExpenseEventPublisher>(
    EXPENSE_EVENT_PUBLISHER,
  );
  const dispatch = publisher.dispatch.bind(publisher);
  publisher.dispatch = async (events) => {
    for (const event of events) {
      observed.push({
        events: [...events],
        statusAtDispatch: await statusAtDispatch(event.expenseId),
      });
    }
    return dispatch(events);
  };
});

beforeEach(async () => {
  observed.length = 0;
  await resetData(owner);
});

// ── fixtures ─────────────────────────────────────────────────────────────────

interface FlatSpec {
  readonly number: string;
  readonly floor?: number;
}

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
      '900'::numeric(8, 2),
      '900'::numeric(8, 2),
      '1'::numeric(8, 3),
      'owner_occupied'::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  const apartmentId = row!.id as ApartmentId;
  const memberId = await insertMember(owner, societyId, {
    apartmentId,
    occupancy: "owner_occupied",
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
  readonly treasurerUserId: UserId;
  readonly residentUserId: UserId;
  readonly guestUserId: UserId;
}

/** A society with one building, `flatCount` owner-occupied flats, a category and four roles. */
async function seed(flatCount = 4): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Void Court",
    "admin@void.ses.test",
  );
  const north = await insertBuilding(owner, society.societyId, "North Block");

  const flats: ApartmentId[] = [];
  const members: MemberId[] = [];
  for (let index = 1; index <= flatCount; index += 1) {
    const flat = await insertFlatWithOwner(society.societyId, north, {
      number: `V${String(index).padStart(3, "0")}`,
      floor: ((index - 1) % 8) + 1,
    });
    flats.push(flat.apartmentId);
    members.push(flat.memberId);
  }

  const roleUser = async (
    email: string,
    displayName: string,
    role: "committee_member" | "treasurer" | "resident" | "guest",
  ): Promise<UserId> => {
    const userId = asUserId(await createLocalUser(owner, email, displayName));
    await insertMember(owner, society.societyId, {
      userId,
      role,
      displayName,
    });
    return userId;
  };

  const committeeUserId = await roleUser(
    "committee@void.ses.test",
    "Committee Member",
    "committee_member",
  );
  const treasurerUserId = await roleUser(
    "treasurer@void.ses.test",
    "Treasurer",
    "treasurer",
  );
  const residentUserId = await roleUser(
    "resident@void.ses.test",
    "Resident",
    "resident",
  );
  const guestUserId = await roleUser("guest@void.ses.test", "Guest", "guest");

  const other = await seedSociety(
    harness,
    "Other Void Court",
    "admin@othervoid.ses.test",
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
    treasurerUserId,
    residentUserId,
    guestUserId,
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
  const createExpense = harness.app.get(CreateExpenseUseCase);
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

/** Creates and publishes a draft, returning the published expense's id (version 2). */
async function published(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<ExpenseId> {
  const publish = harness.app.get(PublishExpenseUseCase);
  const expenseId = await createDraft(fixture, overrides);
  keyCounter += 1;
  await publish.publish(fixture.adminUserId, fixture.societyId, expenseId, {
    expectedVersion: 1,
    idempotencyKey: `t069-publish-${String(keyCounter).padStart(4, "0")}`,
  });
  return expenseId;
}

/** The voider's own reasons, all well-formed unless a test overrides one. */
const REASON = "Duplicate bill; cancelled by the vendor.";

/**
 * T069's door, exactly as the route reaches it: the real use case → the real
 * `expense_void()` → the real balances. Going through the use case (rather than
 * calling the repository port) is deliberate: the authorization decision, the
 * reason rule, the error translation and the post-commit dispatch are all
 * exercised together, which is the path a client takes.
 */
async function voidOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  options: {
    readonly actor?: UserId;
    readonly expectedVersion?: number;
    readonly reason?: string;
    readonly societyId?: SocietyId;
  } = {},
) {
  const useCase = harness.app.get(VoidExpenseUseCase);
  return useCase.void(
    options.actor ?? fixture.adminUserId,
    options.societyId ?? fixture.societyId,
    expenseId,
    {
      expectedVersion: options.expectedVersion ?? 2,
      reason: options.reason ?? REASON,
    },
  );
}

// ── row readers ──────────────────────────────────────────────────────────────

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

function dueForMember(
  dues: readonly DueRow[],
  memberId: MemberId,
): DueRow | undefined {
  return dues.find((due) => due.member_id === memberId);
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

interface BalanceNumbers {
  readonly totalDue: bigint;
  readonly totalPaid: bigint;
  readonly advance: bigint;
  readonly outstanding: bigint;
  readonly oldestDueDate: string | null;
}

async function balanceNumbers(memberId: MemberId): Promise<BalanceNumbers> {
  const row = await balanceOf(memberId);
  return {
    totalDue: BigInt(row?.total_due_paise ?? "0"),
    totalPaid: BigInt(row?.total_paid_paise ?? "0"),
    advance: BigInt(row?.advance_paise ?? "0"),
    outstanding: BigInt(row?.outstanding_paise ?? "0"),
    oldestDueDate: row?.oldest_due_date ?? null,
  };
}

/** The equation ADR-0010 Decision 2 must preserve, asserted after every success. */
async function expectBalanceEquation(memberId: MemberId): Promise<void> {
  const balance = await balanceNumbers(memberId);
  expect(balance.outstanding).toBe(
    balance.totalDue - balance.totalPaid - balance.advance,
  );

  // And the domain's own calculator agrees with the committed row over the
  // member's current dues — the reference formula and the SQL upsert cannot drift.
  const lines = await owner<
    {
      kind: string;
      status: string;
      amount_paise: string;
      paid_paise: string;
      due_date: string;
    }[]
  >`
    select kind, status, amount_paise::text, paid_paise::text, due_date::text
      from public.dues
     where member_id = ${memberId}::uuid
  `;
  const projected = calculateOutstanding({
    dues: lines.map((line) => ({
      kind: line.kind as "principal" | "late_fee" | "adjustment",
      status: line.status,
      amountPaise: paise(BigInt(line.amount_paise)),
      paidPaise: paise(BigInt(line.paid_paise)),
      dueDate: line.due_date,
    })),
    // The credit side is `advance_paise` itself: after a void it is non-zero, and
    // the formula's `Σcredits` term is exactly what ADR-0010 Decision 2 moved there.
    creditsPaise: paise(balance.advance),
  });
  expect(balance.outstanding).toBe(BigInt(projected.outstandingPaise));

  // `member_balances.total_due_paise` counts every **current** obligation — open or
  // settled — while the calculator's `Σdues` counts the open ones, so the column is
  // the projection plus the settled (non-open, non-superseded) lines' amounts.
  // Superseded history is in neither (ADR-0010 Decision 1/2).
  const settledNotSuperseded = lines.reduce((sum, line) => {
    const open = ["pending", "partial", "overdue"].includes(line.status);
    const historical = line.status === "superseded";
    return open || historical ? sum : sum + BigInt(line.amount_paise);
  }, 0n);
  expect(balance.totalDue).toBe(
    BigInt(projected.totalDuePaise) + settledNotSuperseded,
  );
  expect(balance.totalPaid).toBe(BigInt(projected.paidPaise));
  expect(balance.oldestDueDate).toBe(projected.oldestDueDate);
}

interface SplitRow {
  readonly id: string;
  readonly member_id: string;
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
  readonly status: string;
  readonly version: number;
  readonly amount_paise: string;
  readonly voided_at: string | null;
  readonly voided_by: string | null;
  readonly void_reason: string | null;
  readonly published_at: string | null;
  readonly updated_at: string;
}

async function expenseOf(expenseId: ExpenseId): Promise<ExpenseRow> {
  const [row] = await owner<ExpenseRow[]>`
    select status::text as status, version, amount_paise::text,
           voided_at::text, voided_by, void_reason, published_at::text,
           updated_at::text
      from public.expenses
     where id = ${expenseId}::uuid
  `;
  if (row === undefined) throw new Error("The expense row is missing.");
  return row;
}

async function revisionCount(expenseId: ExpenseId): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count
      from public.expense_revisions
     where expense_id = ${expenseId}::uuid
  `;
  return Number(row?.count ?? "0");
}

/** Every table a void may write. A refused void must touch none of them. */
const FINANCIAL_TABLES = [
  "expenses",
  "expense_splits",
  "expense_revisions",
  "dues",
  "member_balances",
] as const;

async function financialCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from ${owner(table)}
    `;
    counts[table] = Number(row?.count ?? "0");
  }
  return counts;
}

/** The thrown error, whatever shape it arrived in — an `AppError` or an `ExpenseError`. */
async function failureOf(promise: Promise<unknown>): Promise<{
  code: unknown;
  message: string;
  field: unknown;
  details: unknown;
}> {
  try {
    await promise;
  } catch (error: unknown) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      field?: unknown;
      details?: unknown;
      payload?: { details?: unknown; field?: unknown };
    };
    return {
      code: candidate.code,
      message: typeof candidate.message === "string" ? candidate.message : "",
      field: candidate.payload?.field ?? candidate.field,
      details: candidate.payload?.details ?? candidate.details,
    };
  }
  throw new Error("Expected the call to be refused.");
}

/**
 * Pays `amount` paise against one due — the fixture's stand-in for T079's
 * allocator, which does not exist yet.
 *
 * It writes the same two facts the real path will: the due's `paid_paise` (with
 * the payment-derived status, `chk_dues_paid_within_amount` permitting) and the
 * member's balance (`total_paid += amount`, `outstanding -= amount`), so the balance
 * equation still holds when the void under test runs. T069 only ever *reads* these
 * rows, which is why the fixture is a legitimate precondition rather than a
 * shortcut past the code under test.
 */
async function payDue(
  dueId: string,
  societyId: SocietyId,
  amount: bigint,
): Promise<void> {
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

/**
 * An advance a member already carries before the void — the fixture's stand-in for
 * T086's credit adjustment, which does not exist yet.
 *
 * Both columns move together, which is what a real credit issue does: the credit is
 * available (`advance += X`) and it cancels that much outstanding (`outstanding -=
 * X`), so the balance equation ADR-0010 Decision 2 must preserve still holds when
 * the void under test adds to it.
 */
async function creditMember(
  memberId: MemberId,
  societyId: SocietyId,
  amount: bigint,
): Promise<void> {
  await owner`
    update public.member_balances
       set advance_paise = advance_paise + ${amount.toString()}::bigint,
           outstanding_paise = outstanding_paise - ${amount.toString()}::bigint
     where member_id = ${memberId}::uuid
       and society_id = ${societyId}::uuid
  `;
}

/**
 * Runs one statement as an acting `authenticated` identity and answers its SQLSTATE.
 *
 * The same shape the member-balances suite uses for its grant proofs: the point is
 * that the *database* refuses, under a real RLS identity, rather than that a
 * TypeScript layer declined to try.
 */
async function sqlstateAs(user: UserId, query: SQL): Promise<string> {
  try {
    await harness.unitOfWork.transaction({ kind: "user", userId: user }, (tx) =>
      tx.execute(query),
    );
    return "allowed";
  } catch (error: unknown) {
    const candidate = error as { code?: unknown; cause?: { code?: unknown } };
    if (typeof candidate.code === "string") return candidate.code;
    if (typeof candidate.cause?.code === "string") return candidate.cause.code;
    return "refused";
  }
}

/**
 * Sets every due of one expense to the same date and re-derives every member's
 * `oldest_due_date` — the fixture's stand-in for the publish rule, so a test can
 * place two expenses at two known ages without waiting for two billing cycles.
 *
 * The recomputation uses the same authoritative rule the SQL writers use
 * (`MIN(due_date)` over the member's open dues), so the pre-state the void meets is
 * a state the product itself could have produced.
 */
async function setDueDates(expenseId: ExpenseId, date: string): Promise<void> {
  await owner`
    update public.dues set due_date = ${date}::date
     where expense_id = ${expenseId}::uuid
  `;
  await owner`
    update public.member_balances mb
       set oldest_due_date = sub.min_due
      from (
        select d.member_id, min(d.due_date) as min_due
          from public.dues d
         where d.status in ('pending', 'partial', 'overdue')
         group by d.member_id
      ) sub
     where mb.member_id = sub.member_id
  `;
}

// ── the void lifecycle ───────────────────────────────────────────────────────

describe("void", () => {
  it("supersedes an unpaid due and leaves the member with nothing (1, 6, 13, 16, 17)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const member = fixture.members[0]!;

    const before = await balanceNumbers(member);
    expect(before).toMatchObject({
      totalDue: 100_000n,
      totalPaid: 0n,
      advance: 0n,
      outstanding: 100_000n,
    });

    const result = await voidOf(fixture, expenseId);

    // The summary is measured from the rows the transaction committed.
    expect(result.summary.duesSuperseded).toBe(4);
    expect(result.summary.creditsIssued.paise).toBe(0n);
    expect(result.summary.affectedMembers).toBe(4);
    expect(result.expense.status).toBe("void");

    const dues = await duesOf(expenseId);
    expect(dues).toHaveLength(4);
    expect(dues.every((due) => due.status === "superseded")).toBe(true);

    const after = await balanceNumbers(member);
    expect(after).toMatchObject({
      totalDue: 0n,
      totalPaid: 0n,
      advance: 0n,
      outstanding: 0n,
    });
    await expectBalanceEquation(member);
  });

  it("turns a partial payment into available credit (2, 6, 8, 9, 14, 15, 16, 17)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const member = fixture.members[1]!;

    const dues = await duesOf(expenseId);
    const due = dueForMember(dues, member)!;
    await payDue(due.id, fixture.societyId, 40_000n);

    const before = await balanceNumbers(member);
    expect(before).toMatchObject({
      totalDue: 100_000n,
      totalPaid: 40_000n,
      advance: 0n,
      outstanding: 60_000n,
    });

    await voidOf(fixture, expenseId);

    // The historical due keeps its amount and its paid history; only its status moved.
    const after450 = dueForMember(await duesOf(expenseId), member)!;
    expect(after450).toMatchObject({
      amount_paise: "100000",
      paid_paise: "40000",
      status: "superseded",
    });
    expect(after450.id).toBe(due.id);

    const after = await balanceNumbers(member);
    expect(after).toMatchObject({
      totalDue: 0n,
      totalPaid: 0n,
      advance: 40_000n,
      outstanding: -40_000n,
    });
    await expectBalanceEquation(member);
  });

  it("turns a full payment into credit without losing a paisa (3, 15, 16)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const member = fixture.members[2]!;

    const dues = await duesOf(expenseId);
    const due = dueForMember(dues, member)!;
    await payDue(due.id, fixture.societyId, 100_000n);

    await voidOf(fixture, expenseId);

    const historical = dueForMember(await duesOf(expenseId), member)!;
    expect(historical).toMatchObject({
      amount_paise: "100000",
      paid_paise: "100000",
      status: "superseded",
    });

    const after = await balanceNumbers(member);
    expect(after).toMatchObject({
      totalDue: 0n,
      totalPaid: 0n,
      advance: 100_000n,
      outstanding: -100_000n,
    });
    await expectBalanceEquation(member);
  });

  it("handles a mixed-payment multi-member expense, member by member (4, 7, 8, 9, 10, 12, 17)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const [a, b, c] = [
      fixture.members[0]!,
      fixture.members[1]!,
      fixture.members[2]!,
    ];

    const dues = await duesOf(expenseId);
    const bDue = dueForMember(dues, b)!;
    const cDue = dueForMember(dues, c)!;
    await payDue(bDue.id, fixture.societyId, 40_000n);
    await payDue(cDue.id, fixture.societyId, 100_000n);

    const splitsBefore = await splitsOf(expenseId);
    const idsBefore = new Map(dues.map((due) => [due.member_id, due.id]));

    await voidOf(fixture, expenseId);

    // Every due is superseded, every id/amount/paid_paise/split link preserved.
    const after = await duesOf(expenseId);
    for (const due of after) {
      expect(due.status).toBe("superseded");
      expect(due.id).toBe(idsBefore.get(due.member_id));
      expect(due.amount_paise).toBe("100000");
      expect(due.split_id).not.toBeNull();
    }
    expect(dueForMember(after, b)!.paid_paise).toBe("40000");
    expect(dueForMember(after, c)!.paid_paise).toBe("100000");

    // The splits are byte-identical: a void reverses obligations, it does not
    // delete the bill (ADR-0010 Decision 1).
    expect(await splitsOf(expenseId)).toEqual(splitsBefore);

    const expected = new Map<MemberId, bigint>([
      [a, 0n],
      [b, 40_000n],
      [c, 100_000n],
    ]);
    for (const [member, advance] of expected) {
      const balance = await balanceNumbers(member);
      expect(balance.totalDue).toBe(0n);
      expect(balance.totalPaid).toBe(0n);
      expect(balance.advance).toBe(advance);
      expect(balance.outstanding).toBe(-advance);
      await expectBalanceEquation(member);
    }
  });

  it("adds the void's credit to an advance the member already carries (5, 11, 14)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const member = fixture.members[1]!;

    const dues = await duesOf(expenseId);
    const due = dueForMember(dues, member)!;
    await payDue(due.id, fixture.societyId, 40_000n);

    // A pre-existing credit — T086's job, which does not exist yet.
    await creditMember(member, fixture.societyId, 20_000n);
    const before = await balanceNumbers(member);
    expect(before).toMatchObject({
      totalDue: 100_000n,
      totalPaid: 40_000n,
      advance: 20_000n,
      outstanding: 40_000n,
    });
    await expectBalanceEquation(member);

    await voidOf(fixture, expenseId);

    // Existing credit is additive: X + P, nothing lost or overwritten.
    const after = await balanceNumbers(member);
    expect(after).toMatchObject({
      totalDue: 0n,
      totalPaid: 0n,
      advance: 60_000n,
      outstanding: -60_000n,
    });
    await expectBalanceEquation(member);
  });

  it("leaves dues already superseded by a T068 recalculation untouched (12, 41)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    // T068 removes a participant: that due is superseded with an amount preserved.
    const updateExpense = harness.app.get(UpdateExpenseUseCase);
    await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      expenseId,
      {
        expectedVersion: 2,
        participantSelector: {
          includeVacant: null,
          excludeApartments: [fixture.flats[3]!],
        },
      } as unknown as Parameters<UpdateExpenseUseCase["update"]>[3],
    );

    const retired = (await duesOf(expenseId)).find(
      (due) => due.member_id === fixture.members[3],
    )!;
    expect(retired.status).toBe("superseded");
    const retiredSnapshot = { ...retired };

    await voidOf(fixture, expenseId, { expectedVersion: 3 });

    const after = (await duesOf(expenseId)).find(
      (due) => due.id === retiredSnapshot.id,
    )!;
    expect(after).toEqual(retiredSnapshot);
  });

  it("removes the voided obligation from the balance projection but keeps history (41)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    await voidOf(fixture, expenseId);

    const [totals] = await owner<
      { historical: string; current: string; splits: string }[]
    >`
      select
        coalesce(sum(amount_paise), 0)::text as historical,
        coalesce(sum(amount_paise) filter (where status <> 'superseded'), 0)::text as current,
        (select coalesce(sum(amount_paise), 0)::text
           from public.expense_splits where expense_id = ${expenseId}::uuid) as splits
        from public.dues
       where expense_id = ${expenseId}::uuid
    `;
    expect(totals?.historical).toBe("400000");
    expect(totals?.current).toBe("0");
    // The bill itself survives at full value.
    expect(totals?.splits).toBe("400000");
  });

  it("moves oldest_due_date by the member's remaining dues, and NULLs it when none are left (18, 19)", async () => {
    const fixture = await seed(1);
    const member = fixture.members[0]!;

    const older = await published(fixture, { amountPaise: 50_000 });
    await setDueDates(older, "2026-08-10");
    const newer = await published(fixture, { amountPaise: 50_000 });
    await setDueDates(newer, "2026-09-10");

    expect((await balanceNumbers(member)).oldestDueDate).toBe("2026-08-10");
    expect((await balanceNumbers(member)).totalDue).toBe(100_000n);

    await voidOf(fixture, older);
    // The voided expense stops being an obligation, so the member's oldest open due
    // is the surviving one — recomputed from the authoritative rows, never the
    // publish-time `LEAST`.
    expect((await balanceNumbers(member)).oldestDueDate).toBe("2026-09-10");
    expect((await balanceNumbers(member)).totalDue).toBe(50_000n);
    await expectBalanceEquation(member);

    await voidOf(fixture, newer);
    expect((await balanceNumbers(member)).oldestDueDate).toBeNull();
    await expectBalanceEquation(member);
  });

  it("stamps status, reason, author and version (20, 40)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    expect(await revisionCount(expenseId)).toBe(0);

    const result = await voidOf(fixture, expenseId, {
      reason: "Vendor cancelled the lift contract.",
    });

    const row = await expenseOf(expenseId);
    expect(row.status).toBe("void");
    expect(row.voided_at).not.toBeNull();
    expect(row.voided_by).toBe(fixture.adminMemberId);
    expect(row.void_reason).toBe("Vendor cancelled the lift contract.");
    expect(row.version).toBe(3);
    // The DTO's instant and the column's are the same moment, rendered by two
    // layers (an ISO-8601 string over the wire, a Postgres timestamp here).
    const columnIso = `${row.voided_at?.slice(0, 10) ?? ""}T${row.voided_at?.slice(11, 19) ?? ""}`;
    expect(result.expense.voidedAt?.slice(0, 19)).toBe(columnIso);

    // No revision row: a void is not an edit (ADR-0010).
    expect(await revisionCount(expenseId)).toBe(0);
  });

  it("refuses a reason shorter than ten characters, blank, or with control characters (21, 22, 23)", async () => {
    const fixture = await seed();

    for (const reason of ["Too short", "          ", "Bad\tcharacter here"]) {
      const expenseId = await published(fixture);
      const before = await financialCounts();
      const failure = await failureOf(voidOf(fixture, expenseId, { reason }));

      expect(failure.code).toBe("VALIDATION_ERROR");
      // The domain's own field name for the void reason, so a form highlights the
      // right box.
      expect(failure.field).toBe("voidReason");
      expect(await financialCounts()).toEqual(before);
      expect((await expenseOf(expenseId)).status).toBe("published");
    }
  });

  it("refuses a second void with INVALID_TRANSITION rather than replaying (24, 20)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    await voidOf(fixture, expenseId);
    const afterFirst = await financialCounts();

    const failure = await failureOf(
      voidOf(fixture, expenseId, { expectedVersion: 3 }),
    );
    expect(failure.code).toBe("INVALID_TRANSITION");
    expect(await financialCounts()).toEqual(afterFirst);
    expect(await balanceNumbers(fixture.members[0]!)).toMatchObject({
      totalDue: 0n,
    });
  });

  it("refuses a stale expectedVersion and writes nothing (25)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const before = await financialCounts();

    const failure = await failureOf(
      voidOf(fixture, expenseId, { expectedVersion: 1 }),
    );
    expect(failure.code).toBe("VERSION_MISMATCH");
    expect(JSON.stringify(failure.details)).toContain("current");
    expect(await financialCounts()).toEqual(before);
    expect((await expenseOf(expenseId)).status).toBe("published");
    expect(voidDispatches()).toHaveLength(0);
  });

  it("fails closed on a waived current due and rolls everything back (29)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const member = fixture.members[0]!;
    const due = dueForMember(await duesOf(expenseId), member)!;

    await owner`
      update public.dues
         set status = 'waived'::public.due_status,
             waived_reason = 'Forgiven by the committee'
       where id = ${due.id}::uuid
    `;

    const before = await financialCounts();
    const duesBefore = await duesOf(expenseId);
    const failure = await failureOf(voidOf(fixture, expenseId));

    expect(failure.code).toBe("CONFLICT");
    expect(JSON.stringify(failure.details)).toContain("DUE_STATE_UNSUPPORTED");
    expect(await financialCounts()).toEqual(before);
    expect((await expenseOf(expenseId)).status).toBe("published");
    // The waived row is exactly as the fixture left it and the other three are
    // still current — nothing was half-superseded before the refusal.
    expect(await duesOf(expenseId)).toEqual(duesBefore);
    expect(voidDispatches()).toHaveLength(0);
  });

  it("fails closed on a written_off current due (30)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const due = dueForMember(await duesOf(expenseId), fixture.members[0]!)!;

    await owner`
      update public.dues set status = 'written_off'::public.due_status
       where id = ${due.id}::uuid
    `;

    const before = await financialCounts();
    const failure = await failureOf(voidOf(fixture, expenseId));
    expect(failure.code).toBe("CONFLICT");
    expect(await financialCounts()).toEqual(before);
  });

  it("fails closed on a current non-principal obligation it cannot reverse", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    // A late fee against the same expense would keep its share of the projection
    // while the expense stops being a bill — the conservation hole ADR-0010
    // refuses to guess about. No production writer creates one today (T085);
    // this fixture proves the guard exists.
    await owner`
      insert into public.dues (
        society_id, member_id, apartment_id, expense_id, kind,
        amount_paise, paid_paise, status, due_date
      )
      values (
        ${fixture.societyId}::uuid,
        ${fixture.members[0]!}::uuid,
        ${fixture.flats[0]!}::uuid,
        ${expenseId}::uuid,
        'late_fee',
        5_000::bigint,
        0::bigint,
        'pending'::public.due_status,
        current_date
      )
    `;

    const before = await financialCounts();
    const failure = await failureOf(voidOf(fixture, expenseId));
    expect(failure.code).toBe("CONFLICT");
    expect(await financialCounts()).toEqual(before);
    expect((await expenseOf(expenseId)).status).toBe("published");
  });

  it("answers 404 for a cross-society expense, never 403 (31)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    // The other society's Admin is a manager *there*. Asked about this society's
    // expense, the answer must be indistinguishable from a row that never existed,
    // and nothing may move.
    const failure = await failureOf(
      voidOf(fixture, expenseId, {
        actor: fixture.other.adminUserId,
        societyId: fixture.other.societyId,
      }),
    );
    expect(failure.code).toBe("NOT_FOUND");

    // A manager of *this* society asking about it in the other society is the same
    // invisibility: no membership there, no row.
    const mirrored = await failureOf(
      voidOf(fixture, expenseId, {
        actor: fixture.adminUserId,
        societyId: fixture.other.societyId,
      }),
    );
    expect(mirrored.code).toBe("NOT_FOUND");
    expect((await expenseOf(expenseId)).status).toBe("published");

    // And the 404s were about the (id, society) pair, not about the row: the real
    // Admin can void it in the society that owns it.
    const own = await voidOf(fixture, expenseId);
    expect(own.expense.status).toBe("void");
  });

  it("refuses Committee, Resident and Guest, and allows the Treasurer (32, 33, 34, 35)", async () => {
    const fixture = await seed();

    const committee = await published(fixture);
    const committeeFailure = await failureOf(
      voidOf(fixture, committee, { actor: fixture.committeeUserId }),
    );
    expect(committeeFailure.code).toBe("FORBIDDEN");
    expect((await expenseOf(committee)).status).toBe("published");

    const residentExpense = await published(fixture);
    const residentFailure = await failureOf(
      voidOf(fixture, residentExpense, { actor: fixture.residentUserId }),
    );
    expect(residentFailure.code).toBe("FORBIDDEN");

    // A Guest is refused *earlier* than a role refusal: `expense.view` excludes
    // them, so RLS hides the row from its own read and the use case answers the
    // indistinguishable 404 rather than confirming the expense exists (PRD T041).
    // The route's `@RequirePermission("expense.void")` refuses them with 403 in
    // front of the handler — proven in the e2e suite.
    const guestExpense = await published(fixture);
    const guestFailure = await failureOf(
      voidOf(fixture, guestExpense, { actor: fixture.guestUserId }),
    );
    expect(guestFailure.code).toBe("NOT_FOUND");

    // The Treasurer holds `expense.void` outright.
    const treasurerExpense = await published(fixture);
    const result = await voidOf(fixture, treasurerExpense, {
      actor: fixture.treasurerUserId,
    });
    expect(result.expense.status).toBe("void");
    await expectBalanceEquation(fixture.members[0]!);
  });

  it("refuses the definer function reached directly without the capability (36)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    // A Committee Member is a real, active member — the refusal is the capability.
    expect(
      await sqlstateAs(
        fixture.committeeUserId,
        sql`select * from public.expense_void(
          ${expenseId}::uuid, ${fixture.societyId}::uuid, 2, 'Direct call attempt'
        )`,
      ),
    ).toBe("42501");

    // And a non-member cannot even tell the society exists.
    expect(
      await sqlstateAs(
        fixture.other.adminUserId,
        sql`select * from public.expense_void(
          ${expenseId}::uuid, ${fixture.societyId}::uuid, 2, 'Direct call attempt'
        )`,
      ),
    ).toBe("P0002");
  });

  it("refuses a direct DELETE of an expense or a due at the grant level (37, 38)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const due = dueForMember(await duesOf(expenseId), fixture.members[0]!)!;

    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`delete from public.expenses where id = ${expenseId}::uuid`,
      ),
    ).toBe("42501");
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`delete from public.dues where id = ${due.id}::uuid`,
      ),
    ).toBe("42501");

    // Nothing was removed — the "hard delete is impossible" acceptance.
    expect(await financialCounts()).toMatchObject({
      expenses: 1,
      dues: 4,
    });
  });

  it("refuses a direct client UPDATE that would half-void the expense (39)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    // `status` and `void_reason` ARE in the client's UPDATE grant; `voided_at` and
    // `voided_by` are not. So this statement is exactly the bypass the hardening
    // closes: it passes RLS (the Admin may update a published row) and is refused
    // by the completeness constraint, leaving no half-void behind.
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses
               set status = 'void',
                   void_reason = 'Voided by a direct client'
             where id = ${expenseId}::uuid`,
      ),
    ).toBe("23514");

    const row = await expenseOf(expenseId);
    expect(row.status).toBe("published");
    expect(row.void_reason).toBeNull();
    expect(row.voided_at).toBeNull();
  });

  it("keeps every financial row and writes none after a refusal (28, 41, 43)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const before = await financialCounts();

    // A genuine mid-transaction refusal: the expense is not published (a draft), so
    // the definer function raises *after* its membership and capability checks and
    // before any write. Nothing may be touched and nothing may be announced.
    const draft = await createDraft(fixture, { title: "Draft to refuse" });
    const failure = await failureOf(
      voidOf(fixture, draft, { expectedVersion: 1 }),
    );
    expect(failure.code).toBe("INVALID_TRANSITION");

    expect(await financialCounts()).toMatchObject({
      expenses: before["expenses"]! + 1,
      expense_splits: before["expense_splits"],
      dues: before["dues"],
      member_balances: before["member_balances"],
    });
    expect(await revisionCount(expenseId)).toBe(0);
    expect(voidDispatches()).toHaveLength(0);
    await expectBalanceEquation(fixture.members[0]!);
  });
});

// ── ordering, locking and the event ──────────────────────────────────────────

describe("ordering and concurrency", () => {
  it("dispatches expense.voided only after the commit (42)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    await voidOf(fixture, expenseId);

    const voided = voidDispatches();
    expect(voided).toHaveLength(1);
    const [dispatch] = voided;
    expect(dispatch!.statusAtDispatch).toBe("void");
    const [event] = dispatch!.events;
    expect(event).toMatchObject({
      name: "expense.voided",
      expenseId,
      societyId: fixture.societyId,
    });
  });

  it("leaves exactly one winner when two voids race (26)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);

    const results = await Promise.allSettled([
      voidOf(fixture, expenseId),
      voidOf(fixture, expenseId),
    ]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const row = await expenseOf(expenseId);
    expect(row.status).toBe("void");
    expect(row.version).toBe(3);
    expect(await balanceNumbers(fixture.members[0]!)).toMatchObject({
      totalDue: 0n,
      totalPaid: 0n,
      advance: 0n,
      outstanding: 0n,
    });
    // One void, one event.
    expect(voidDispatches()).toHaveLength(1);
  });

  it("serialises void against recalculation, one winner (27)", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    const updateExpense = harness.app.get(UpdateExpenseUseCase);

    const results = await Promise.allSettled([
      voidOf(fixture, expenseId),
      updateExpense.update(fixture.adminUserId, fixture.societyId, expenseId, {
        expectedVersion: 2,
        title: "Lift AMC — Q4 (revised)",
      } as unknown as Parameters<UpdateExpenseUseCase["update"]>[3]),
    ]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const row = await expenseOf(expenseId);
    if (row.status === "void") {
      // The void won: the revision saw a void expense and refused.
      expect(row.version).toBe(3);
      expect(await revisionCount(expenseId)).toBe(0);
    } else {
      // The revision won: the void saw a moved version and refused.
      expect(row.status).toBe("published");
      expect(row.version).toBe(3);
      expect(await revisionCount(expenseId)).toBe(1);
      // The refusal was a lock refusal, and it is still voidable afterwards.
      const result = await voidOf(fixture, expenseId, { expectedVersion: 3 });
      expect(result.expense.status).toBe("void");
    }
    await expectBalanceEquation(fixture.members[0]!);
  });
});

// ── RPC safety and the ledger ────────────────────────────────────────────────

describe("migration and RPC safety", () => {
  it("records the forward migration in the ledger", async () => {
    const rows = await owner<{ name: string }[]>`
      select name from ses_meta.migrations order by name
    `;
    expect(rows.map((row) => row.name)).toContain(
      "20261008120000_expense_void.sql",
    );
  });

  it("declares exactly the result types its query returns — the #28 42804 regression", async () => {
    const [declared] = await owner<{ result: string }[]>`
      select pg_get_function_result(
        'public.expense_void(uuid, uuid, integer, text)'::regprocedure
      ) as result
    `;
    const result = declared?.result ?? "";
    // Postgres drops the typmod in this rendering, so `payment_source` shows as
    // `character varying` (`character varying(24)` is what `pg_proc` holds and what
    // the `RETURN QUERY` must match — see below).
    expect(result).toContain("payment_source character varying");
    expect(result).toContain("amount_paise text");
    expect(result).toContain("split_strategy text");
    expect(result).toContain("void_summary jsonb");

    // The decisive half: execute the function and read the *runtime* type of every
    // column the previous test's declared list names. A declared/returned mismatch
    // is a `42804` raised by PostgreSQL at this very call — the defect #28 shipped
    // and a fake-backed suite could never see.
    const fixture = await seed();
    const expenseId = await published(fixture);
    const rows = await harness.unitOfWork.transaction(
      { kind: "user", userId: fixture.adminUserId },
      (tx) =>
        tx.execute<{
          payment_source: string;
          amount_paise: string;
          expense_date: string;
          split_strategy: string;
          status: string;
          version: string;
          void_summary: string;
        }>(sql`
          select pg_typeof(v.payment_source)::text as payment_source,
                 pg_typeof(v.amount_paise)::text as amount_paise,
                 pg_typeof(v.expense_date)::text as expense_date,
                 pg_typeof(v.split_strategy)::text as split_strategy,
                 pg_typeof(v.status)::text as status,
                 pg_typeof(v.version)::text as version,
                 pg_typeof(v.void_summary)::text as void_summary
            from public.expense_void(
              ${expenseId}::uuid,
              ${fixture.societyId}::uuid,
              2,
              'Typed by an executing call'
            ) v
        `),
    );
    expect(rows[0]).toEqual({
      payment_source: "character varying",
      amount_paise: "text",
      expense_date: "text",
      split_strategy: "text",
      status: "text",
      version: "integer",
      void_summary: "jsonb",
    });
  });

  it("still satisfies the new completeness constraint on a real void", async () => {
    const fixture = await seed();
    const expenseId = await published(fixture);
    await voidOf(fixture, expenseId);

    const [row] = await owner<{ ok: boolean }[]>`
      select (voided_at is not null
              and voided_by is not null
              and length(btrim(void_reason)) >= 10) as ok
        from public.expenses
       where id = ${expenseId}::uuid
    `;
    expect(row?.ok).toBe(true);
  });
});

// ── the ₹3,000 audit example ─────────────────────────────────────────────────

describe("the audit example", () => {
  it("reconciles three members' ₹1,000 dues to zero current obligations (audit)", async () => {
    const fixture = await seed(3);
    // Equal split of ₹3,000 across the three flats: ₹1,000 each.
    const expenseId = await published(fixture, { amountPaise: 300_000 });

    const [a, b, c] = [
      fixture.members[0]!,
      fixture.members[1]!,
      fixture.members[2]!,
    ];
    const dues = await duesOf(expenseId);
    expect(dues).toHaveLength(3);
    expect(dues.every((due) => due.amount_paise === "100000")).toBe(true);

    // A: unpaid. B: ₹400 paid. C: ₹1,000 paid.
    await payDue(dueForMember(dues, b)!.id, fixture.societyId, 40_000n);
    await payDue(dueForMember(dues, c)!.id, fixture.societyId, 100_000n);

    const result = await voidOf(fixture, expenseId);
    expect(result.summary.duesSuperseded).toBe(3);
    expect(result.summary.creditsIssued.paise).toBe(140_000n);
    expect(result.summary.affectedMembers).toBe(3);

    const expected: readonly (readonly [MemberId, bigint])[] = [
      [a, 0n],
      [b, 40_000n],
      [c, 100_000n],
    ];
    for (const [member, advance] of expected) {
      const balance = await balanceNumbers(member);
      expect(balance).toMatchObject({
        totalDue: 0n,
        totalPaid: 0n,
        advance,
        outstanding: -advance,
      });
      await expectBalanceEquation(member);
    }

    // Historical dues still total ₹3,000; current principal obligations total zero.
    const [totals] = await owner<{ historical: string; current: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as historical,
             coalesce(sum(amount_paise) filter (where status <> 'superseded'), 0)::text as current
        from public.dues
       where expense_id = ${expenseId}::uuid
         and kind = 'principal'
    `;
    expect(totals?.historical).toBe("300000");
    expect(totals?.current).toBe("0");

    // The bill itself is still on the books, at full value (Decision 1).
    const [splits] = await owner<{ total: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as total
        from public.expense_splits
       where expense_id = ${expenseId}::uuid
    `;
    expect(splits?.total).toBe("300000");

    // And the credit is a balance figure, never an invented payment row.
    const [payments] = await owner<{ count: string }[]>`
      select count(*)::text as count
        from information_schema.tables
       where table_schema = 'public' and table_name in ('payments', 'payment_allocations')
    `;
    expect(payments?.count).toBe("0");
  });
});
