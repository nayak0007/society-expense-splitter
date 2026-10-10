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
  PublishExpenseRecordInput,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { EXPENSE_SPLIT_REPOSITORY } from "../../src/modules/expenses/application/expense.tokens";
import { ApproveExpenseUseCase } from "../../src/modules/expenses/application/use-cases/approve-expense.use-case";
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
 * The expense **lifecycle** against real PostgreSQL, real RLS and the real
 * definer RPCs — Roadmap T077 (Stage A), SAD §15.4.
 *
 * ## Why this file exists beside the per-transition specs
 *
 * T065–T070 each own a spec that pins one transition (draft, publish, approval,
 * void) in depth. What no single one of them covers is the *sequence* a real
 * treasurer walks — create → edit → (approve) → publish → void — and the money
 * post-conditions **after each step of that sequence**, in one file and one
 * database. That is what this suite adds; it deliberately does not re-derive the
 * single-transition edges those specs already prove.
 *
 * ## What only a real database can answer
 *
 *  1. `SUM(expense_splits.amount_paise) = expenses.amount_paise` exactly, on real
 *     `numeric`/`bigint` columns and the deferred `chk_split_total()` trigger.
 *  2. One principal `due` per persisted split, and a `member_balances` row whose
 *     `outstanding_paise` equals what was billed — the receivable half (T067).
 *  3. Idempotency replay (SAD §7.7) writes **no** additional financial rows.
 *  4. Void supersedes dues without deleting them (ADR-0010) and leaves the balance
 *     equation intact.
 *  5. Cross-society access is a `not_found`, never a `forbidden`, and writes nothing.
 *
 * Fixtures are written on the **owner** connection; every call under test runs
 * through `UnitOfWork` as an acting member. `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;

let createExpense: CreateExpenseUseCase;
let updateExpense: UpdateExpenseUseCase;
let approveExpense: ApproveExpenseUseCase;
let publishExpense: PublishExpenseUseCase;
let voidExpense: VoidExpenseUseCase;
let splits: ExpenseSplitRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  createExpense = harness.app.get(CreateExpenseUseCase);
  updateExpense = harness.app.get(UpdateExpenseUseCase);
  approveExpense = harness.app.get(ApproveExpenseUseCase);
  publishExpense = harness.app.get(PublishExpenseUseCase);
  voidExpense = harness.app.get(VoidExpenseUseCase);
  splits = harness.app.get<ExpenseSplitRepository>(EXPENSE_SPLIT_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

// ── fixture ──────────────────────────────────────────────────────────────────

interface FlatSpec {
  readonly number: string;
  readonly floor?: number;
  readonly carpetAreaSqft?: string;
  readonly builtupAreaSqft?: string;
}

interface OwnerFlat {
  readonly apartmentId: ApartmentId;
  readonly memberId: MemberId;
}

/** One billable flat plus its primary owner, inserted as the owner (fixture path). */
async function insertFlatWithOwner(
  societyId: SocietyId,
  buildingId: BuildingId,
  spec: FlatSpec,
): Promise<OwnerFlat> {
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
      ${spec.builtupAreaSqft ?? null}::numeric(8, 2),
      '1'::numeric(8, 3),
      'owner_occupied'::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  const apartmentId = row!.id as ApartmentId;
  const memberId = asMemberId(
    await insertMember(owner, societyId, {
      apartmentId,
      occupancy: "owner_occupied",
      isPrimary: true,
      displayName: `Owner ${spec.number}`,
    }),
  );
  return { apartmentId, memberId };
}

interface Fixture extends SocietyFixture {
  readonly north: BuildingId;
  readonly flats: readonly OwnerFlat[];
  readonly other: SocietyFixture;
  readonly categoryId: ExpenseCategoryId;
  readonly treasurerUserId: UserId;
}

/** A society with one building, `flatCount` owner-occupied flats and a "Lift" category. */
async function seed(flatCount = 4): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Lifecycle Court",
    "admin@lifecycle.ses.test",
  );
  const north = await insertBuilding(owner, society.societyId, "North Block");

  const flats: OwnerFlat[] = [];
  for (let index = 1; index <= flatCount; index += 1) {
    flats.push(
      await insertFlatWithOwner(society.societyId, north, {
        number: `P${String(index).padStart(3, "0")}`,
        floor: ((index - 1) % 8) + 1,
        // Distinct areas so a per-sqft split has to place the odd paisa.
        carpetAreaSqft: `${700 + index}`,
        builtupAreaSqft: `${875 + index}`,
      }),
    );
  }

  const treasurerUserId = asUserId(
    await createLocalUser(owner, "treasurer@lifecycle.ses.test", "Treasurer"),
  );
  await insertMember(owner, society.societyId, {
    userId: treasurerUserId,
    role: "treasurer",
    displayName: "Treasurer",
  });

  const other = await seedSociety(
    harness,
    "Other Lifecycle Court",
    "admin@otherLifecycle.ses.test",
  );

  return {
    ...society,
    north,
    flats,
    other,
    categoryId: await categoryIdOf(
      society.societyId,
      society.adminUserId,
      "Lift",
    ),
    treasurerUserId,
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
  if (category === undefined)
    throw new Error(`The seeded category "${name}" is missing.`);
  return category.id;
}

let keyCounter = 0;

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
      amountPaise: 600_000,
      expenseDate: "2026-09-30",
      categoryId: fixture.categoryId as string,
      // A per-sqft basis exercises the real resolver → engine → split writer path,
      // not a hand-written allocation set.
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
      ...overrides,
    },
  );
  return record.id;
}

function nextKey(): string {
  keyCounter += 1;
  return `lifecycle-key-${String(keyCounter).padStart(4, "0")}`;
}

function publishOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  expectedVersion: number,
  key: string = nextKey(),
) {
  return publishExpense.publish(
    fixture.adminUserId,
    fixture.societyId,
    expenseId,
    {
      expectedVersion,
      idempotencyKey: key,
    },
  );
}

// ── row readers ──────────────────────────────────────────────────────────────

interface ExpenseState {
  readonly status: string;
  readonly version: number;
  readonly title: string;
  readonly publishedAt: string | null;
}

async function stateOf(expenseId: ExpenseId): Promise<ExpenseState> {
  const [row] = await owner<
    {
      status: string;
      version: number;
      title: string;
      published_at: string | null;
    }[]
  >`
    select status, version, title, published_at::text as published_at
      from public.expenses
     where id = ${expenseId}::uuid
  `;
  if (row === undefined) throw new Error(`Expense ${expenseId} is missing.`);
  return {
    status: row.status,
    version: Number(row.version),
    title: row.title,
    publishedAt: row.published_at,
  };
}

interface SplitRow {
  readonly member_id: string | null;
  readonly apartment_id: string | null;
  readonly amount_paise: string;
}

function splitRows(expenseId: ExpenseId): Promise<SplitRow[]> {
  return owner<SplitRow[]>`
    select member_id, apartment_id, amount_paise::text as amount_paise
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
     order by amount_paise desc, member_id
  `;
}

async function splitTotal(expenseId: ExpenseId): Promise<bigint> {
  const rows = await splitRows(expenseId);
  return rows.reduce((sum, row) => sum + BigInt(row.amount_paise), 0n);
}

interface DueRow {
  readonly id: string;
  readonly member_id: string;
  readonly split_id: string | null;
  readonly amount_paise: string;
  readonly status: string;
  readonly kind: string;
}

function duesOf(expenseId: ExpenseId): Promise<DueRow[]> {
  return owner<DueRow[]>`
    select id, member_id, split_id, amount_paise::text as amount_paise, status, kind
      from public.dues
     where expense_id = ${expenseId}::uuid
     order by member_id
  `;
}

interface BalanceNumbers {
  readonly totalDue: bigint;
  readonly totalPaid: bigint;
  readonly advance: bigint;
  readonly outstanding: bigint;
}

async function balanceOf(memberId: MemberId): Promise<BalanceNumbers> {
  const [row] = await owner<
    {
      total_due_paise: string;
      total_paid_paise: string;
      advance_paise: string;
      outstanding_paise: string;
    }[]
  >`
    select total_due_paise::text, total_paid_paise::text,
           advance_paise::text, outstanding_paise::text
      from public.member_balances
     where member_id = ${memberId}::uuid
  `;
  return {
    totalDue: BigInt(row?.total_due_paise ?? "0"),
    totalPaid: BigInt(row?.total_paid_paise ?? "0"),
    advance: BigInt(row?.advance_paise ?? "0"),
    outstanding: BigInt(row?.outstanding_paise ?? "0"),
  };
}

async function countOf(table: string): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count from public.${owner(table)}
  `;
  return Number(row?.count ?? "0");
}

/**
 * The thrown error, as the HTTP layer would render it.
 *
 * Two vocabularies meet here, and both are load-bearing. A **use case** failure
 * carries the API catalogue's uppercase envelope code (`NOT_FOUND`), while a
 * **repository/definer** failure carries the module's lowercase domain code
 * (`not_found`, `split_mismatch`) — the same split the committed suites assert.
 * The catalogue additionally puts the stable detail code beside the envelope one
 * (`409 CONFLICT` + `APPROVAL_REQUIRED`), which is the pair a client branches on.
 */
async function failureOf(promise: Promise<unknown>): Promise<{
  code: unknown;
  message: string;
  field: unknown;
  detail: unknown;
}> {
  try {
    await promise;
  } catch (error: unknown) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      field?: unknown;
      payload?: { field?: unknown; details?: { code?: unknown }[] };
    };
    return {
      code: candidate.code,
      message: typeof candidate.message === "string" ? candidate.message : "",
      field: candidate.payload?.field ?? candidate.field,
      detail: candidate.payload?.details?.[0]?.code,
    };
  }
  throw new Error("Expected the call to be refused.");
}

/** Post-conditions every successful publication must satisfy, in one place. */
async function expectConserved(
  expenseId: ExpenseId,
  amountPaise: bigint,
): Promise<void> {
  const rows = await splitRows(expenseId);
  expect(rows.length).toBeGreaterThan(0);

  // The database's own sum, not the application's.
  const [sum] = await owner<{ total: string }[]>`
    select coalesce(sum(amount_paise), 0)::text as total
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
  `;
  expect(sum?.total).toBe(amountPaise.toString());

  // One principal receivable per split, and the balance row agrees with what was billed.
  const dues = await duesOf(expenseId);
  expect(dues).toHaveLength(rows.length);
  for (const due of dues) {
    expect(due.kind).toBe("principal");
    expect(due.status).toBe("pending");
    expect(BigInt(due.amount_paise)).toBeGreaterThan(0n);
    const balance = await balanceOf(asMemberId(due.member_id));
    expect(balance.totalPaid).toBe(0n);
    expect(balance.advance).toBe(0n);
    expect(balance.outstanding).toBe(BigInt(due.amount_paise));
    expect(balance.outstanding).toBe(
      balance.totalDue - balance.totalPaid - balance.advance,
    );
  }
}

// ── broken-allocation helpers (used only by the regression describe) ─────────

async function allocationOf(
  fixture: Fixture,
  flatIndex: number,
  amountPaise: bigint,
): Promise<PublishExpenseAllocation> {
  const flat = fixture.flats[flatIndex];
  if (flat === undefined)
    throw new Error(`No fixture flat at index ${flatIndex}.`);
  const [row] = await owner<{ display_name: string }[]>`
    select display_name from public.members where id = ${flat.memberId}::uuid
  `;
  return {
    memberId: flat.memberId,
    apartmentId: flat.apartmentId,
    amount: Money.fromPaise(amountPaise),
    weight: weight(1),
    percent: null,
    assignedReason: null,
    snapshot: {
      memberName: row?.display_name ?? "Owner",
      apartmentNumber: `P${String(flatIndex + 1).padStart(3, "0")}`,
    },
  };
}

function publishInput(
  allocations: readonly PublishExpenseAllocation[],
  expectedVersion = 1,
  key: string = nextKey(),
): PublishExpenseRecordInput {
  return {
    expectedVersion,
    idempotencyKey: key,
    requestHash: `integration-hash:${key}`,
    allocations,
  };
}

// ── the lifecycle ────────────────────────────────────────────────────────────

describe("expense lifecycle against real PostgreSQL", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("create → edit → publish", () => {
    it("carries a draft through an edit to a conserved publication with dues and balances", async () => {
      const expenseId = await createDraft(fixture);
      expect(await stateOf(expenseId)).toMatchObject({
        status: "draft",
        version: 1,
      });

      // Edit the draft: the version the row was read at is required, and the write bumps it.
      const edited = await updateExpense.update(
        fixture.adminUserId,
        fixture.societyId,
        expenseId,
        {
          expectedVersion: 1,
          title: "Lift AMC — Q4 (revised)",
        },
      );
      expect(edited.expense.version).toBe(2);
      expect(await stateOf(expenseId)).toMatchObject({
        status: "draft",
        version: 2,
        title: "Lift AMC — Q4 (revised)",
      });

      // Publish against the version the edit produced.
      const publication = await publishOf(fixture, expenseId, 2);
      expect(publication.replayed).toBe(false);
      expect(publication.expense.status).toBe("published");
      expect(publication.expense.publishedAt).not.toBeNull();

      await expectConserved(expenseId, 600_000n);
      expect(await countOf("idempotency_records")).toBe(1);
      expect(await stateOf(expenseId)).toMatchObject({
        status: "published",
        version: 3,
      });
    });

    it("refuses a stale expectedVersion on edit and leaves the row byte-identical", async () => {
      const expenseId = await createDraft(fixture);
      const before = await stateOf(expenseId);

      const error = await failureOf(
        updateExpense.update(
          fixture.adminUserId,
          fixture.societyId,
          expenseId,
          {
            expectedVersion: 99,
            title: "Should not land",
          },
        ),
      );

      expect(error.code).toBe("VERSION_MISMATCH");
      expect(await stateOf(expenseId)).toEqual(before);
    });

    it("refuses a stale expectedVersion on publish and writes nothing", async () => {
      const expenseId = await createDraft(fixture);

      const error = await failureOf(publishOf(fixture, expenseId, 99));

      expect(error.code).toBe("VERSION_MISMATCH");
      expect(await splitRows(expenseId)).toHaveLength(0);
      expect(await duesOf(expenseId)).toHaveLength(0);
      expect(await countOf("idempotency_records")).toBe(0);
      expect(await stateOf(expenseId)).toMatchObject({
        status: "draft",
        version: 1,
      });
    });
  });

  describe("approval threshold (T070 / ADR-0011)", () => {
    it("routes an at-threshold create to pending_approval and refuses publish until approved", async () => {
      // The society's threshold is 1,000,000 paise; `amount >= threshold` requires approval.
      const expenseId = await createDraft(fixture, { amountPaise: 1_000_000 });
      expect(await stateOf(expenseId)).toMatchObject({
        status: "pending_approval",
        version: 1,
      });

      const refused = await failureOf(publishOf(fixture, expenseId, 1));

      // The gate fires inside the definer function, so nothing financial is written.
      // The refusal is the catalogue's `409 CONFLICT` envelope carrying the stable
      // `APPROVAL_REQUIRED` detail code — the same pair the approved T070 suite pins
      // (`expense-approval.integration-spec.ts`).
      expect(refused.code).toBe("CONFLICT");
      expect(refused.detail).toBe("APPROVAL_REQUIRED");
      expect(await splitRows(expenseId)).toHaveLength(0);
      expect(await duesOf(expenseId)).toHaveLength(0);
      expect(await countOf("idempotency_records")).toBe(0);
      expect(await stateOf(expenseId)).toMatchObject({
        status: "pending_approval",
      });

      // Approval does not move the status; it stamps the decision and bumps the version.
      const approved = await approveExpense.approve(
        fixture.adminUserId,
        fixture.societyId,
        expenseId,
        {
          expectedVersion: 1,
        },
      );
      expect(approved.version).toBe(2);
      expect((await stateOf(expenseId)).status).toBe("pending_approval");

      const publication = await publishOf(fixture, expenseId, 2);
      expect(publication.expense.status).toBe("published");
      await expectConserved(expenseId, 1_000_000n);
    });

    it("publishes a below-threshold draft without an approval", async () => {
      const expenseId = await createDraft(fixture, { amountPaise: 999_999 });
      expect((await stateOf(expenseId)).status).toBe("draft");

      const publication = await publishOf(fixture, expenseId, 1);

      expect(publication.expense.status).toBe("published");
      await expectConserved(expenseId, 999_999n);
    });
  });

  describe("idempotency replay (SAD §7.7)", () => {
    it("replays the stored publication and writes no additional financial rows", async () => {
      const expenseId = await createDraft(fixture);
      const key = nextKey();
      const first = await publishOf(fixture, expenseId, 1, key);

      const snapshot = {
        splits: await countOf("expense_splits"),
        dues: await countOf("dues"),
        balances: await countOf("member_balances"),
        records: await countOf("idempotency_records"),
        version: (await stateOf(expenseId)).version,
      };

      const second = await publishOf(fixture, expenseId, 1, key);

      expect(second.replayed).toBe(true);
      expect(second.summary.total.paise).toBe(first.summary.total.paise);
      expect(await countOf("expense_splits")).toBe(snapshot.splits);
      expect(await countOf("dues")).toBe(snapshot.dues);
      expect(await countOf("member_balances")).toBe(snapshot.balances);
      expect(await countOf("idempotency_records")).toBe(snapshot.records);
      expect((await stateOf(expenseId)).version).toBe(snapshot.version);
    });
  });

  describe("void (T069 / ADR-0010)", () => {
    it("supersedes dues without deleting them and keeps the balance equation", async () => {
      const expenseId = await createDraft(fixture);
      await publishOf(fixture, expenseId, 1);
      const duesBefore = await duesOf(expenseId);
      const splitsBefore = await splitRows(expenseId);

      const voided = await voidExpense.void(
        fixture.adminUserId,
        fixture.societyId,
        expenseId,
        {
          expectedVersion: 2,
          reason: "Duplicate bill; cancelled by the vendor.",
        },
      );

      expect(voided.expense.status).toBe("void");
      expect(await stateOf(expenseId)).toMatchObject({ status: "void" });

      // The dues are historical, not gone: same ids, amounts and split links.
      const duesAfter = await duesOf(expenseId);
      expect(duesAfter).toHaveLength(duesBefore.length);
      expect(duesAfter.every((due) => due.status === "superseded")).toBe(true);
      expect(duesAfter.map((due) => due.id)).toEqual(
        duesBefore.map((due) => due.id),
      );
      expect(duesAfter.map((due) => due.amount_paise)).toEqual(
        duesBefore.map((due) => due.amount_paise),
      );
      expect(duesAfter.map((due) => due.split_id)).toEqual(
        duesBefore.map((due) => due.split_id),
      );

      // The bill itself is untouched: no split row changes on a void.
      expect(await splitRows(expenseId)).toEqual(splitsBefore);

      // Nothing was paid, so the charge simply clears: outstanding returns to zero.
      const members = [...new Set(duesBefore.map((due) => due.member_id))];
      for (const member of members) {
        const balance = await balanceOf(asMemberId(member));
        expect(balance.outstanding).toBe(0n);
        expect(balance.totalDue).toBe(0n);
        expect(balance.advance).toBe(0n);
        expect(balance.outstanding).toBe(
          balance.totalDue - balance.totalPaid - balance.advance,
        );
      }
    });
  });

  describe("cross-society isolation", () => {
    it("answers not_found — never forbidden — and writes nothing for a foreign society id", async () => {
      const expenseId = await createDraft(fixture);

      const published = await failureOf(
        publishExpense.publish(
          fixture.other.adminUserId,
          fixture.other.societyId,
          expenseId,
          {
            expectedVersion: 1,
            idempotencyKey: nextKey(),
          },
        ),
      );
      // A use case resolves the society under RLS and turns "absent" into the API
      // catalogue's uppercase `NOT_FOUND` — never a distinguishable 403.
      expect(published.code).toBe("NOT_FOUND");

      const edited = await failureOf(
        updateExpense.update(
          fixture.other.adminUserId,
          fixture.other.societyId,
          expenseId,
          {
            expectedVersion: 1,
            title: "Foreign write",
          },
        ),
      );
      expect(edited.code).toBe("NOT_FOUND");

      expect(await splitRows(expenseId)).toHaveLength(0);
      expect(await countOf("idempotency_records")).toBe(0);
      expect(await stateOf(expenseId)).toMatchObject({
        status: "draft",
        version: 1,
      });
    });
  });

  describe("broken-allocation regression", () => {
    it("refuses a non-conserving allocation set through the definer and writes nothing", async () => {
      const expenseId = await createDraft(fixture, {
        splitStrategy: "equal",
        apartmentBasis: null,
      });
      const before = await stateOf(expenseId);

      // One paisa short of the ₹6,000 bill. The definer function sums the real
      // allocations before it writes a row, and the deferred trigger would judge the
      // final state at COMMIT; both refuse this set.
      const allocations = [
        await allocationOf(fixture, 0, 300_000n),
        await allocationOf(fixture, 1, 299_999n),
      ];

      // The use case recomputes the split from the persisted row, so a broken set has to
      // be driven straight at the port to isolate the integrity check itself (T066's
      // `splits.publish` is the same writer the use case calls).
      const error = await failureOf(
        splits.publish(
          expenseId,
          fixture.societyId,
          publishInput(allocations),
          fixture.adminUserId,
        ),
      );

      expect(error.code).toBe("split_mismatch");
      expect(await splitRows(expenseId)).toHaveLength(0);
      expect(await stateOf(expenseId)).toEqual(before);
      expect(await countOf("idempotency_records")).toBe(0);
    });

    it("refuses an out-of-balance split write at COMMIT and rolls the corruption back", async () => {
      const expenseId = await createDraft(fixture);
      await publishOf(fixture, expenseId, 1);

      const splitsBefore = await splitRows(expenseId);
      const totalBefore = await splitTotal(expenseId);
      expect(totalBefore).toBe(600_000n);

      // A fifth, genuinely valid participant — so the failure is the *conservation*
      // trigger and not the participant unique key.
      const extra = await insertFlatWithOwner(
        fixture.societyId,
        fixture.north,
        {
          number: "P900",
          floor: 9,
          carpetAreaSqft: "999",
        },
      );

      // A direct, owner-level write that pushes the published split set one paisa over
      // the bill. `chk_split_total()` is DEFERRABLE INITIALLY DEFERRED, so it fires at
      // COMMIT: the transaction must fail and take its row with it. Nothing about the
      // trigger or the constraint is disabled or weakened.
      await expect(
        owner.begin(async (tx) => {
          await tx`
            insert into public.expense_splits (
              society_id, expense_id, member_id, apartment_id, amount_paise, snapshot
            )
            values (
              ${fixture.societyId}::uuid,
              ${expenseId}::uuid,
              ${extra.memberId}::uuid,
              ${extra.apartmentId}::uuid,
              1,
              '{"memberName":"Overflow"}'::jsonb
            )
          `;
        }),
      ).rejects.toThrow(/SPLIT_MISMATCH/i);

      // The corruption is gone and the committed bill is exactly as it was.
      expect(await splitRows(expenseId)).toEqual(splitsBefore);
      expect(await splitTotal(expenseId)).toBe(totalBefore);
      expect(await stateOf(expenseId)).toMatchObject({ status: "published" });
    });
  });
});
