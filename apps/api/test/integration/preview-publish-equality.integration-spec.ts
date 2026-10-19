import type {
  ApartmentBasis,
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseId,
  ExpenseRecord,
  SocietyId,
  SplitStrategy,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import {
  PreviewSplitUseCase,
  type ExpenseSplitPreview,
  type PreviewSplitCommand,
  type PreviewSplitConfig,
} from "../../src/modules/expenses/application/use-cases/preview-split.use-case";

import { resetData } from "../utils/integration-db";
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
 * T064's blocking acceptance criterion, against real PostgreSQL — the regression the
 * Phase 4 audit found missing.
 *
 * ## What this suite proves, and what it deliberately does not
 *
 * The e2e parity case (`expense-publish.e2e-spec.ts`) compares two in-memory worlds:
 * a faked split store on one side and the preview use case on the other. That proves
 * the wiring, not the crossing. T064's sentence is about **money the database now
 * holds**: the allocation a preview showed for an unchanged draft must be the
 * allocation publishing that same draft persists.
 *
 * So every case here runs the production path end to end:
 *
 * ```
 * CreateExpenseUseCase        → one real `expenses` row, real RLS, real grants
 * PreviewSplitUseCase         → real participant rows, real category row, real engine
 * PublishExpenseUseCase       → real resolver, real `expense_publish()` transaction
 * owner connection (read only) → the rows the transaction actually committed
 * ```
 *
 * The comparison is **per participant**, keyed by `(apartmentId, memberId)` — the
 * pair `expense_splits` is unique on — never by aggregate total. Identical totals
 * are the failure mode a broken allocation hides behind: two flats swapping a paisa
 * conserves the sum and pays the wrong residents. The suite asserts the complete
 * participant set, every amount in integer paise, every weight, the persisted total,
 * no duplicates, no missing participants, the committed lifecycle state and the exact
 * sum.
 *
 * ## The calculation path is shared, and this is where that claim is measured
 *
 * Preview and publish are not two calculations that happen to agree. Publishing
 * imports `resolveSplitPlan`, `buildSplitInput`, `computeSplit` and
 * `verifyConservation` from `preview-split.use-case.ts` — the same functions the
 * preview runs, over the **stored** draft row rather than a client copy. This suite
 * therefore also proves the persisted draft is a faithful input: the preview command
 * is built from the row `create()` returned (`splitStrategy`, `apartmentBasis`,
 * `splitConfig`, `participantSelector`, `amount`), not re-stated by the test.
 *
 * ## Mutable inputs: the guarantee is a snapshot, not a stale preview
 *
 * Publication recomputes from the current roster and the stored draft. A preview is
 * information; it is not a reservation. Two cases measure the consequence rather
 * than inventing a stronger guarantee: changing an apartment's carpet area, and
 * adding a billable flat, between preview and publish both change the persisted
 * allocation — and in both, the persisted set equals a **fresh** preview taken after
 * the change, never the stale one. That is the architecture's honest contract.
 *
 * ## Fixtures
 *
 * Fixtures are written on the **owner** connection (they must exist before any
 * identity does). Every call under test runs through `UnitOfWork` as the society's
 * own Admin, so RLS, the definer function and the column grants are all in play.
 * `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let preview: PreviewSplitUseCase;
let createExpense: CreateExpenseUseCase;
let publish: PublishExpenseUseCase;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  preview = harness.app.get(PreviewSplitUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  publish = harness.app.get(PublishExpenseUseCase);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type FlatNumber = "E101" | "E102" | "E103" | "E104" | "E105" | "E106";

interface Flat {
  readonly id: ApartmentId;
  readonly number: string;
  readonly ownerMemberId: string;
  readonly tenantMemberId: string | null;
}

type Flats = Readonly<Record<FlatNumber, Flat>>;

interface Fixture extends SocietyFixture {
  readonly buildingId: BuildingId;
  readonly flats: Flats;
  readonly liftCategoryId: ExpenseCategoryId;
  readonly sinkingFundCategoryId: ExpenseCategoryId;
  readonly other: SocietyFixture;
}

interface FlatSpec {
  readonly number: string;
  readonly floor: number;
  readonly bhk: string;
  readonly carpetAreaSqft: string;
  readonly builtupAreaSqft: string;
  readonly parkingSlots: number;
  readonly shareUnits: string;
  readonly occupancy: "owner_occupied" | "rented";
}

/**
 * All six flats with distinct, deliberately awkward facts.
 *
 * Every value is chosen so a residual paisa must be placed: the carpet areas do not
 * divide the amount, the built-up areas carry a `.5`, the BHK set includes a real
 * `1.5`, and the parking counts include `0`. Identical weights would hide a residual
 * bug behind a split that happens to be exact.
 */
const FLAT_SPECS: readonly FlatSpec[] = [
  {
    number: "E101",
    floor: 1,
    bhk: "2.0",
    carpetAreaSqft: "700.00",
    builtupAreaSqft: "875.00",
    parkingSlots: 1,
    shareUnits: "2.000",
    occupancy: "owner_occupied",
  },
  {
    number: "E102",
    floor: 1,
    bhk: "1.0",
    carpetAreaSqft: "400.00",
    builtupAreaSqft: "500.00",
    parkingSlots: 0,
    shareUnits: "1.500",
    occupancy: "owner_occupied",
  },
  {
    number: "E103",
    floor: 2,
    bhk: "1.0",
    carpetAreaSqft: "350.00",
    builtupAreaSqft: "437.50",
    parkingSlots: 1,
    shareUnits: "1.000",
    occupancy: "rented",
  },
  {
    number: "E104",
    floor: 3,
    bhk: "3.0",
    carpetAreaSqft: "900.00",
    builtupAreaSqft: "1125.00",
    parkingSlots: 2,
    shareUnits: "3.000",
    occupancy: "owner_occupied",
  },
  {
    number: "E105",
    floor: 0,
    bhk: "1.5",
    carpetAreaSqft: "650.00",
    builtupAreaSqft: "812.50",
    parkingSlots: 0,
    shareUnits: "1.000",
    occupancy: "owner_occupied",
  },
  {
    number: "E106",
    floor: 5,
    bhk: "2.0",
    carpetAreaSqft: "650.00",
    builtupAreaSqft: "812.50",
    parkingSlots: 1,
    shareUnits: "2.500",
    occupancy: "owner_occupied",
  },
];

async function insertFlat(
  societyId: SocietyId,
  buildingId: BuildingId,
  spec: FlatSpec,
): Promise<ApartmentId> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.apartments (
      society_id, building_id, apartment_number, floor, bhk,
      carpet_area_sqft, builtup_area_sqft, parking_slots, share_units,
      occupancy_status, is_billable
    )
    values (
      ${societyId}::uuid,
      ${buildingId}::uuid,
      ${spec.number},
      ${spec.floor}::smallint,
      ${spec.bhk}::numeric(3, 1),
      ${spec.carpetAreaSqft}::numeric(8, 2),
      ${spec.builtupAreaSqft}::numeric(8, 2),
      ${spec.parkingSlots}::smallint,
      ${spec.shareUnits}::numeric(8, 3),
      ${spec.occupancy}::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  return row!.id as ApartmentId;
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

async function seed(): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Equality Court",
    "admin@equality.ses.test",
  );
  const societyId = society.societyId;
  const buildingId = await insertBuilding(owner, societyId, "Equality Block");

  const flats: Partial<Record<FlatNumber, Flat>> = {};
  for (const spec of FLAT_SPECS) {
    const id = await insertFlat(societyId, buildingId, spec);
    const ownerMemberId = await insertMember(owner, societyId, {
      apartmentId: id,
      occupancy:
        spec.occupancy === "rented" ? "vacant_owner" : "owner_occupied",
      isPrimary: spec.occupancy !== "rented",
      displayName: `Owner ${spec.number}`,
    });
    // The rented flat carries both an owner (non-primary) and the tenant the charge
    // is normally addressed to, so the owner-only plan can prove the move.
    const tenantMemberId =
      spec.occupancy === "rented"
        ? await insertMember(owner, societyId, {
            apartmentId: id,
            occupancy: "tenant",
            isPrimary: true,
            displayName: `Tenant ${spec.number}`,
          })
        : null;
    flats[spec.number as FlatNumber] = {
      id,
      number: spec.number,
      ownerMemberId,
      tenantMemberId,
    };
  }

  const liftCategoryId = await categoryIdOf(
    societyId,
    society.adminUserId,
    "Lift",
  );
  const sinkingFundCategoryId = await categoryIdOf(
    societyId,
    society.adminUserId,
    "Sinking Fund",
  );

  return {
    ...society,
    buildingId,
    flats: flats as Flats,
    liftCategoryId,
    sinkingFundCategoryId,
    other: await seedSociety(
      harness,
      "Other Equality Court",
      "admin@otherequality.ses.test",
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The production path
// ─────────────────────────────────────────────────────────────────────────────

interface DraftSpec {
  readonly amountPaise: number;
  readonly splitStrategy: SplitStrategy;
  readonly apartmentBasis?: ApartmentBasis;
  readonly splitConfig?: PreviewSplitConfig;
  readonly categoryId?: ExpenseCategoryId;
}

/** Creates the real draft whose stored fields both later steps consume. */
function createDraft(
  fixture: Fixture,
  spec: DraftSpec,
): Promise<ExpenseRecord> {
  return createExpense.create(fixture.adminUserId, fixture.societyId, {
    title: `Equality ${String(spec.amountPaise)} — ${spec.splitStrategy}`,
    amountPaise: spec.amountPaise,
    expenseDate: "2026-10-01",
    categoryId: String(spec.categoryId ?? fixture.liftCategoryId),
    splitStrategy: spec.splitStrategy,
    ...(spec.apartmentBasis === undefined
      ? {}
      : { apartmentBasis: spec.apartmentBasis }),
    ...(spec.splitConfig === undefined
      ? {}
      : { splitConfig: spec.splitConfig }),
    participantSelector: {},
  });
}

/**
 * The preview command for a **stored** draft.
 *
 * Built from the row `create()` returned rather than from the test's own spec: the
 * equality being measured is between the preview and the publish of the same saved
 * draft, so the test must not be able to supply the preview with a value the draft
 * does not contain.
 */
function previewCommandOf(record: ExpenseRecord): PreviewSplitCommand {
  return {
    amountPaise: record.amount.paise,
    selector: record.participantSelector,
    categoryId: record.categoryId,
    splitStrategy: record.splitStrategy,
    apartmentBasis: record.apartmentBasis,
    splitConfig: record.splitConfig as PreviewSplitConfig | undefined,
  };
}

function previewOf(
  fixture: Fixture,
  record: ExpenseRecord,
): Promise<ExpenseSplitPreview> {
  return preview.preview(
    fixture.adminUserId,
    fixture.societyId,
    previewCommandOf(record),
  );
}

function publishOf(
  fixture: Fixture,
  record: ExpenseRecord,
  idempotencyKey: string,
  expectedVersion = record.version,
) {
  return publish.publish(fixture.adminUserId, fixture.societyId, record.id, {
    expectedVersion,
    idempotencyKey,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// What PostgreSQL committed
// ─────────────────────────────────────────────────────────────────────────────

interface SplitRow {
  readonly id: string;
  readonly member_id: string | null;
  readonly apartment_id: string | null;
  readonly amount_paise: string;
  readonly weight: string | null;
  readonly percent: string | null;
  readonly assigned_reason: string | null;
  readonly snapshot: Record<string, unknown>;
}

function splitRows(expenseId: ExpenseId): Promise<SplitRow[]> {
  return owner<SplitRow[]>`
    select id,
           member_id,
           apartment_id,
           amount_paise::text as amount_paise,
           weight::text as weight,
           percent::text as percent,
           assigned_reason,
           snapshot
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
     order by snapshot->>'apartmentNumber', member_id
  `;
}

interface ExpenseState {
  readonly status: string;
  readonly version: number;
  readonly publishedAt: string | null;
}

async function expenseState(expenseId: ExpenseId): Promise<ExpenseState> {
  const [row] = await owner<
    { status: string; version: number; published_at: string | null }[]
  >`
    select status, version, published_at::text as published_at
      from public.expenses
     where id = ${expenseId}::uuid
  `;
  if (row === undefined) throw new Error(`Expense ${expenseId} is missing.`);
  return {
    status: row.status,
    version: Number(row.version),
    publishedAt: row.published_at,
  };
}

/** The financial tables a preview must not touch, and a publish must own. */
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

async function publishedAuditCount(expenseId: ExpenseId): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count
      from public.audit_logs
     where entity_type = 'expense'
       and entity_id = ${expenseId}::uuid
       and action = 'expense.published'
  `;
  return Number(row?.count ?? "0");
}

interface PublishedAuditRow {
  readonly category: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

function publishedAuditRows(
  expenseId: ExpenseId,
): Promise<PublishedAuditRow[]> {
  return owner<PublishedAuditRow[]>`
    select category, before, after
      from public.audit_logs
     where entity_type = 'expense'
       and entity_id = ${expenseId}::uuid
       and action = 'expense.published'
     order by occurred_at
  `;
}

async function idempotencyRecordCount(key: string): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count
      from public.idempotency_records
     where idempotency_key = ${key}
  `;
  return Number(row?.count ?? "0");
}

// ─────────────────────────────────────────────────────────────────────────────
// The equality assertion — per participant, never per total
// ─────────────────────────────────────────────────────────────────────────────

interface ParticipantFacts {
  readonly memberId: string;
  readonly apartmentId: string;
  readonly apartmentNumber: string;
  readonly amountPaise: bigint;
  readonly weight: bigint;
}

/** Stable identity: the pair `expense_splits` is unique on. */
function identityOf(memberId: string, apartmentId: string): string {
  return `${apartmentId}\u0000${memberId}`;
}

/**
 * A numeric column as the integer it holds.
 *
 * `weight` is `numeric(12, 4)` and every producer writes an integer-valued weight, so
 * the fractional part is zeros. Reading the whole part as a `BigInt` keeps the
 * comparison exact instead of routing a weight through a float, and the guard makes a
 * genuinely fractional value loud rather than silently truncated.
 */
function integerOfNumeric(value: string): bigint {
  const match = /^(-?\d+)(?:\.0+)?$/.exec(value);
  if (match === null) {
    throw new Error(`The persisted weight "${value}" is not an integer value.`);
  }
  return BigInt(match[1]!);
}

function apartmentNumberOf(row: SplitRow): string {
  const value = row.snapshot["apartmentNumber"];
  if (typeof value !== "string") {
    throw new Error(
      `A persisted split has no snapshot apartmentNumber: ${JSON.stringify(row.snapshot)}`,
    );
  }
  return value;
}

function previewFacts(
  result: ExpenseSplitPreview,
): ReadonlyMap<string, ParticipantFacts> {
  const facts = new Map<string, ParticipantFacts>();
  for (const allocation of result.allocations) {
    const key = identityOf(allocation.memberId, allocation.apartmentId);
    if (facts.has(key)) {
      throw new Error(`The preview contains a duplicate participant: ${key}`);
    }
    facts.set(key, {
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      apartmentNumber: allocation.apartmentNumber,
      amountPaise: allocation.amount.paise,
      weight: allocation.weight,
    });
  }
  return facts;
}

function persistedFacts(
  rows: readonly SplitRow[],
): ReadonlyMap<string, ParticipantFacts> {
  const facts = new Map<string, ParticipantFacts>();
  for (const row of rows) {
    if (row.member_id === null || row.apartment_id === null) {
      throw new Error(`A persisted split has no participant: ${row.id}`);
    }
    if (row.weight === null) {
      throw new Error(`A persisted split has no weight: ${row.id}`);
    }
    const key = identityOf(row.member_id, row.apartment_id);
    if (facts.has(key)) {
      throw new Error(
        `The publication contains a duplicate participant: ${key}`,
      );
    }
    facts.set(key, {
      memberId: row.member_id,
      apartmentId: row.apartment_id,
      apartmentNumber: apartmentNumberOf(row),
      amountPaise: BigInt(row.amount_paise),
      weight: integerOfNumeric(row.weight),
    });
  }
  return facts;
}

/**
 * The whole acceptance criterion for one publication.
 *
 * Every check is per participant. The only aggregate asserted is conservation, and
 * it is asserted *after* the per-person comparison has already established which
 * person owes what — a swapped paisa passes the sum and fails the set.
 */
function expectPublishedMatchesPreview(
  result: ExpenseSplitPreview,
  rows: readonly SplitRow[],
): void {
  const expected = previewFacts(result);
  const actual = persistedFacts(rows);

  // Identical participant sets — no duplicate splits and no missing participants.
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  expect(rows).toHaveLength(result.participantCount);
  expect(actual.size).toBe(rows.length);

  // Identical allocated paise and weight for every participant.
  for (const [key, wanted] of expected) {
    expect(actual.get(key)).toEqual(wanted);
  }

  // Identical total, measured on the database's own sum.
  const persistedTotal = rows.reduce(
    (total, row) => total + BigInt(row.amount_paise),
    0n,
  );
  expect(persistedTotal).toBe(result.total.paise);
  expect(result.residualPaise).toBe(0n);
  expect(result.total.paise).toBe(
    result.allocations.reduce(
      (total, allocation) => total + allocation.amount.paise,
      0n,
    ),
  );

  // Every persisted amount is a valid non-negative integer of paise.
  for (const row of rows) {
    expect(row.amount_paise).toMatch(/^\d+$/);
    expect(BigInt(row.amount_paise)).toBeGreaterThanOrEqual(0n);
  }
}

function amountsByNumber(result: ExpenseSplitPreview): Record<string, bigint> {
  return Object.fromEntries(
    result.allocations.map((allocation): [string, bigint] => [
      allocation.apartmentNumber,
      allocation.amount.paise,
    ]),
  );
}

function weightsByNumber(result: ExpenseSplitPreview): Record<string, bigint> {
  return Object.fromEntries(
    result.allocations.map((allocation): [string, bigint] => [
      allocation.apartmentNumber,
      allocation.weight,
    ]),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans — every strategy and every supported apartment basis
// ─────────────────────────────────────────────────────────────────────────────

interface PlanSpec {
  readonly name: string;
  readonly amountPaise: number;
  readonly splitStrategy: SplitStrategy;
  readonly apartmentBasis?: ApartmentBasis;
  readonly category?: "lift" | "sinking_fund";
  readonly splitConfig?: (fixture: Fixture) => PreviewSplitConfig;
  readonly assertPreview?: (
    result: ExpenseSplitPreview,
    fixture: Fixture,
  ) => void;
  readonly assertPersisted?: (
    rows: readonly SplitRow[],
    fixture: Fixture,
  ) => void;
}

const PLANS: readonly PlanSpec[] = [
  {
    name: "equal — a non-divisible amount, largest remainder and the apartment-number tie-break",
    amountPaise: 100_000,
    splitStrategy: "equal",
    assertPreview: (result) => {
      expect(amountsByNumber(result)).toEqual({
        E101: 16_667n,
        E102: 16_667n,
        E103: 16_667n,
        E104: 16_667n,
        E105: 16_666n,
        E106: 16_666n,
      });
      expect(weightsByNumber(result)).toEqual({
        E101: 1n,
        E102: 1n,
        E103: 1n,
        E104: 1n,
        E105: 1n,
        E106: 1n,
      });
    },
  },
  {
    name: "percentage — unequal weights, an explicit zero percent and omitted flats at zero",
    amountPaise: 100_001,
    splitStrategy: "percentage",
    splitConfig: (fixture) => ({
      percentages: [
        { apartmentId: fixture.flats.E101.id, basisPoints: 5_000 },
        { apartmentId: fixture.flats.E102.id, basisPoints: 2_500 },
        { apartmentId: fixture.flats.E103.id, basisPoints: 0 },
        { apartmentId: fixture.flats.E104.id, basisPoints: 2_500 },
      ],
    }),
    assertPreview: (result) => {
      expect(amountsByNumber(result)).toEqual({
        E101: 50_001n,
        E102: 25_000n,
        E103: 0n,
        E104: 25_000n,
        E105: 0n,
        E106: 0n,
      });
      expect(weightsByNumber(result)).toEqual({
        E101: 5_000n,
        E102: 2_500n,
        E103: 0n,
        E104: 2_500n,
        E105: 0n,
        E106: 0n,
      });
    },
    assertPersisted: (rows) => {
      // The percentage column is the strategy's own figure, carried exactly.
      const percentByNumber = Object.fromEntries(
        rows.map((row): [string, string | null] => [
          apartmentNumberOf(row),
          row.percent,
        ]),
      );
      expect(percentByNumber).toEqual({
        E101: "50.0000",
        E102: "25.0000",
        E103: "0.0000",
        E104: "25.0000",
        E105: "0.0000",
        E106: "0.0000",
      });
    },
  },
  {
    name: "shares — explicit thousandths over the stored share_units defaults",
    amountPaise: 100_003,
    splitStrategy: "shares",
    splitConfig: (fixture) => ({
      shares: [
        { apartmentId: fixture.flats.E101.id, shareUnits: 3_000 },
        { apartmentId: fixture.flats.E103.id, shareUnits: 500 },
      ],
    }),
    assertPreview: (result) => {
      // E101 and E103 are the explicit entries; the rest cross the stored
      // numeric(8,3) shares (1.5 → 1500, 3 → 3000, 1 → 1000, 2.5 → 2500).
      expect(weightsByNumber(result)).toEqual({
        E101: 3_000n,
        E102: 1_500n,
        E103: 500n,
        E104: 3_000n,
        E105: 1_000n,
        E106: 2_500n,
      });
    },
  },
  {
    name: "custom (fixed) — exact amounts, a zero-paise share and exclusion by omission",
    amountPaise: 100_000,
    splitStrategy: "custom",
    splitConfig: (fixture) => ({
      customAmounts: [
        { apartmentId: fixture.flats.E101.id, amountPaise: 40_000 },
        { apartmentId: fixture.flats.E102.id, amountPaise: 30_001 },
        { apartmentId: fixture.flats.E103.id, amountPaise: 0 },
        { apartmentId: fixture.flats.E104.id, amountPaise: 29_999 },
      ],
    }),
    assertPreview: (result) => {
      expect(result.participantCount).toBe(4);
      expect(amountsByNumber(result)).toEqual({
        E101: 40_000n,
        E102: 30_001n,
        E103: 0n,
        E104: 29_999n,
      });
      // A custom split's weight is its stated amount, in paise.
      expect(weightsByNumber(result)).toEqual({
        E101: 40_000n,
        E102: 30_001n,
        E103: 0n,
        E104: 29_999n,
      });
    },
  },
  {
    name: "apartment/per_flat — one share per flat, over the resolved set",
    amountPaise: 100_000,
    splitStrategy: "apartment",
    apartmentBasis: "per_flat",
    assertPreview: (result) => {
      expect(result.participantCount).toBe(6);
      expect(weightsByNumber(result)).toEqual({
        E101: 1n,
        E102: 1n,
        E103: 1n,
        E104: 1n,
        E105: 1n,
        E106: 1n,
      });
      // Identical to equal over the same flats — the basis is the same rule.
      expect(amountsByNumber(result)).toEqual({
        E101: 16_667n,
        E102: 16_667n,
        E103: 16_667n,
        E104: 16_667n,
        E105: 16_666n,
        E106: 16_666n,
      });
    },
  },
  {
    name: "apartment/per_sqft_carpet — real numeric(8,2) areas as exact hundredths",
    amountPaise: 100_003,
    splitStrategy: "apartment",
    apartmentBasis: "per_sqft_carpet",
    assertPreview: (result) => {
      expect(weightsByNumber(result)).toEqual({
        E101: 70_000n,
        E102: 40_000n,
        E103: 35_000n,
        E104: 90_000n,
        E105: 65_000n,
        E106: 65_000n,
      });
      expect(result.warnings).toEqual([]);
    },
  },
  {
    name: "apartment/per_sqft_builtup — a fractional built-up area crosses exactly",
    amountPaise: 100_003,
    splitStrategy: "apartment",
    apartmentBasis: "per_sqft_builtup",
    assertPreview: (result) => {
      expect(weightsByNumber(result)).toEqual({
        E101: 87_500n,
        E102: 50_000n,
        E103: 43_750n,
        E104: 112_500n,
        E105: 81_250n,
        E106: 81_250n,
      });
    },
  },
  {
    name: "apartment/per_bhk — recorded configurations in tenths, including a real 1.5",
    amountPaise: 100_003,
    splitStrategy: "apartment",
    apartmentBasis: "per_bhk",
    assertPreview: (result) => {
      expect(weightsByNumber(result)).toEqual({
        E101: 20n,
        E102: 10n,
        E103: 10n,
        E104: 30n,
        E105: 15n,
        E106: 20n,
      });
    },
  },
  {
    name: "apartment/per_floor_band — a ground-floor exemption persists as a zero-paise row",
    amountPaise: 100_000,
    splitStrategy: "apartment",
    apartmentBasis: "per_floor_band",
    splitConfig: () => ({
      floorBands: [
        { from: -5, to: 0, mult: 0 },
        { from: 1, to: 3, mult: 1 },
        { from: 4, to: 10, mult: 1.5 },
      ],
    }),
    assertPreview: (result) => {
      expect(weightsByNumber(result)).toEqual({
        E101: 1_000n,
        E102: 1_000n,
        E103: 1_000n,
        E104: 1_000n,
        E105: 0n,
        E106: 1_500n,
      });
      expect(amountsByNumber(result).E105).toBe(0n);
    },
  },
  {
    name: "apartment/per_parking_slot — flats with no allotted slot persist at zero paise",
    amountPaise: 100_000,
    splitStrategy: "apartment",
    apartmentBasis: "per_parking_slot",
    assertPreview: (result) => {
      expect(weightsByNumber(result)).toEqual({
        E101: 1n,
        E102: 0n,
        E103: 1n,
        E104: 2n,
        E105: 0n,
        E106: 1n,
      });
      expect(amountsByNumber(result)).toEqual({
        E101: 20_000n,
        E102: 0n,
        E103: 20_000n,
        E104: 40_000n,
        E105: 0n,
        E106: 20_000n,
      });
    },
  },
  {
    name: "owner-only category — the charge moves to the owner and the reason persists",
    amountPaise: 90_000,
    splitStrategy: "equal",
    category: "sinking_fund",
    assertPreview: (result, fixture) => {
      const rented = result.allocations.find(
        (allocation) => allocation.apartmentNumber === "E103",
      );
      // The occupant is a tenant; the owner-only charge is addressed to the owner.
      expect(rented?.memberId).toBe(fixture.flats.E103.ownerMemberId);
      expect(rented?.memberId).not.toBe(fixture.flats.E103.tenantMemberId);
    },
    assertPersisted: (rows, fixture) => {
      for (const row of rows) {
        const number = apartmentNumberOf(row);
        if (number === "E103") {
          expect(row.member_id).toBe(fixture.flats.E103.ownerMemberId);
          expect(row.assigned_reason).toBe("owner_only_category");
        } else {
          // The reason is recorded only when the charge actually moved.
          expect(row.assigned_reason).toBeNull();
        }
      }
    },
  },
];

function draftSpecOf(plan: PlanSpec, fixture: Fixture): DraftSpec {
  return {
    amountPaise: plan.amountPaise,
    splitStrategy: plan.splitStrategy,
    ...(plan.apartmentBasis === undefined
      ? {}
      : { apartmentBasis: plan.apartmentBasis }),
    ...(plan.splitConfig === undefined
      ? {}
      : { splitConfig: plan.splitConfig(fixture) }),
    ...(plan.category === "sinking_fund"
      ? { categoryId: fixture.sinkingFundCategoryId }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The blocking regression
// ─────────────────────────────────────────────────────────────────────────────

describe("T064 — preview ≡ publish for the same unchanged draft, against real PostgreSQL", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  for (const plan of PLANS) {
    it(plan.name, async () => {
      const record = await createDraft(fixture, draftSpecOf(plan, fixture));
      expect(record.status).toBe("draft");
      expect(record.version).toBe(1);

      // The preview writes nothing at all — the acceptance criterion, measured
      // before and after the operation it is about.
      const beforePreview = await financialCounts();
      expect(beforePreview).toMatchObject({
        expense_splits: 0,
        dues: 0,
        expense_revisions: 0,
        expense_gst_details: 0,
      });
      const result = await previewOf(fixture, record);
      expect(await financialCounts()).toEqual(beforePreview);

      // The preview's own arithmetic, hand-checked where the plan says so.
      expect(result.total.paise).toBe(BigInt(plan.amountPaise));
      expect(result.residualPaise).toBe(0n);
      expect(result.participantCount).toBe(result.allocations.length);
      plan.assertPreview?.(result, fixture);

      // Publishing the same unchanged draft, through the real application path.
      const publication = await publishOf(
        fixture,
        record,
        `equality-${plan.splitStrategy}-${String(plan.amountPaise)}`,
      );
      expect(publication.replayed).toBe(false);
      expect(publication.expense.status).toBe("published");
      expect(publication.expense.version).toBe(2);
      expect(publication.expense.publishedAt).not.toBeNull();

      const rows = await splitRows(record.id);
      expectPublishedMatchesPreview(result, rows);
      plan.assertPersisted?.(rows, fixture);

      // The committed row, not the response, is the published state.
      const state = await expenseState(record.id);
      expect(state.status).toBe("published");
      expect(state.version).toBe(2);
      expect(state.publishedAt).not.toBeNull();

      // One publication writes one split set and one audit entry, and the
      // retry record is the half that makes a repeat safe. Nothing else in the
      // financial tables moved: the receivable half is one due per persisted split
      // (T067), and no revision or GST row is invented by publishing.
      expect(rows).toHaveLength(result.participantCount);
      expect(await financialCounts()).toEqual({
        expenses: 1,
        expense_splits: result.participantCount,
        expense_gst_details: 0,
        expense_revisions: 0,
        dues: result.participantCount,
      });
      expect(await publishedAuditCount(record.id)).toBe(1);
      expect(
        await idempotencyRecordCount(
          `equality-${plan.splitStrategy}-${String(plan.amountPaise)}`,
        ),
      ).toBe(1);
    });
  }

  it("publishes a one-paise expense with the single paisa the preview placed", async () => {
    const record = await createDraft(fixture, {
      amountPaise: 1,
      splitStrategy: "equal",
    });

    const result = await previewOf(fixture, record);
    // Six equal weights, one paisa: every remainder is equal, so the tie-break by
    // apartment number ascending decides who owes it.
    expect(amountsByNumber(result)).toEqual({
      E101: 1n,
      E102: 0n,
      E103: 0n,
      E104: 0n,
      E105: 0n,
      E106: 0n,
    });

    await publishOf(fixture, record, "equality-one-paisa");

    expectPublishedMatchesPreview(result, await splitRows(record.id));
  });

  it("keeps the preview and the publication byte-identical when repeated", async () => {
    const record = await createDraft(fixture, {
      amountPaise: 60_000,
      splitStrategy: "equal",
    });
    const result = await previewOf(fixture, record);
    const first = await publishOf(fixture, record, "equality-repeat-key");
    const rowsAfterFirst = await splitRows(record.id);

    expectPublishedMatchesPreview(result, rowsAfterFirst);
    expect(first.replayed).toBe(false);

    // The same idempotent request again: no second split set, no second audit row,
    // no second version bump — the stored response is replayed verbatim.
    const second = await publishOf(fixture, record, "equality-repeat-key");
    expect(second.replayed).toBe(true);
    expect(second.expense.version).toBe(first.expense.version);
    expect(await splitRows(record.id)).toEqual(rowsAfterFirst);
    expect(await publishedAuditCount(record.id)).toBe(1);
    expect(await idempotencyRecordCount("equality-repeat-key")).toBe(1);
    expect((await expenseState(record.id)).version).toBe(2);
  });

  it("records the committed publication in the audit log, with the lifecycle snapshot", async () => {
    const record = await createDraft(fixture, {
      amountPaise: 60_000,
      splitStrategy: "equal",
    });

    await publishOf(fixture, record, "equality-audit-key");

    const audit = await publishedAuditRows(record.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.category).toBe("financial");
    // `before` is the draft the transaction locked; `after` is the row it committed.
    expect(audit[0]?.before).toMatchObject({ status: "draft", version: 1 });
    expect(audit[0]?.after).toMatchObject({ status: "published", version: 2 });
    expect(audit[0]?.after?.["amountPaise"]).toBe("60000");
    expect(audit[0]?.after?.["splitStrategy"]).toBe("equal");
  });

  it("refuses the same financial state to another tenant", async () => {
    const record = await createDraft(fixture, {
      amountPaise: 60_000,
      splitStrategy: "equal",
    });
    await publishOf(fixture, record, "equality-tenant-key");
    const rowsAfterPublish = await splitRows(record.id);

    // The other society's Admin, addressing this expense under *their* society.
    // `not_found` is the answer — not `forbidden`, which would confirm it exists.
    await expect(
      publish.publish(
        fixture.other.adminUserId,
        fixture.other.societyId,
        record.id,
        { expectedVersion: 1, idempotencyKey: "equality-tenant-other" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(await splitRows(record.id)).toEqual(rowsAfterPublish);
    expect(await publishedAuditCount(record.id)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutable inputs between a preview and a publish
// ─────────────────────────────────────────────────────────────────────────────

describe("T064 — what changes between preview and publish is recomputed, not inherited", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("recomputes from a changed carpet area and matches a fresh preview", async () => {
    const record = await createDraft(fixture, {
      amountPaise: 100_000,
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
    });

    const stale = await previewOf(fixture, record);
    const staleE101 = stale.allocations.find(
      (allocation) => allocation.apartmentNumber === "E101",
    );
    expect(staleE101).toBeDefined();

    // The roster move a treasurer can make between two screens: E101's area is
    // corrected from 700 sqft to 100 sqft.
    await owner`
      update public.apartments
         set carpet_area_sqft = 100.00
       where id = ${fixture.flats.E101.id}::uuid
    `;

    const fresh = await previewOf(fixture, record);
    const freshE101 = fresh.allocations.find(
      (allocation) => allocation.apartmentNumber === "E101",
    );
    expect(freshE101?.amount.paise).not.toBe(staleE101?.amount.paise);

    // The draft itself is unchanged, so the same version publishes.
    await publishOf(fixture, record, "equality-area-change");

    const rows = await splitRows(record.id);
    // The persisted set is the *current* state's answer, not the stale preview's.
    expectPublishedMatchesPreview(fresh, rows);
    expect(freshE101?.amount.paise).not.toBe(staleE101?.amount.paise);
  });

  it("re-resolves a flat added between preview and publish and matches a fresh preview", async () => {
    const record = await createDraft(fixture, {
      amountPaise: 70_000,
      splitStrategy: "equal",
    });

    const stale = await previewOf(fixture, record);
    expect(stale.participantCount).toBe(6);

    // A new billable flat joins the society-wide selector between the preview and
    // the publish. Publication resolves the roster at write time.
    const added = await insertFlat(fixture.societyId, fixture.buildingId, {
      number: "E107",
      floor: 6,
      bhk: "2.0",
      carpetAreaSqft: "750.00",
      builtupAreaSqft: "937.50",
      parkingSlots: 1,
      shareUnits: "2.000",
      occupancy: "owner_occupied",
    });
    await insertMember(owner, fixture.societyId, {
      apartmentId: added,
      occupancy: "owner_occupied",
      isPrimary: true,
      displayName: "Owner E107",
    });

    const fresh = await previewOf(fixture, record);
    expect(fresh.participantCount).toBe(7);
    expect(fresh.allocations.map((entry) => entry.apartmentNumber)).toContain(
      "E107",
    );

    await publishOf(fixture, record, "equality-roster-change");

    const rows = await splitRows(record.id);
    expectPublishedMatchesPreview(fresh, rows);
    expect(rows).toHaveLength(7);
    expect(rows.map(apartmentNumberOf)).toContain("E107");
    // The stale preview is information, not a reservation: it never named the new
    // flat, and the publication does not pretend it did.
    expect(
      stale.allocations.map((entry) => entry.apartmentNumber),
    ).not.toContain("E107");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inputs that cannot become a bill
// ─────────────────────────────────────────────────────────────────────────────

describe("T064 — a draft that cannot be priced is refused by preview and publish alike", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("refuses percentages totalling 90% at both doors and writes no splits", async () => {
    const config: PreviewSplitConfig = {
      percentages: [
        { apartmentId: fixture.flats.E101.id, basisPoints: 4_000 },
        { apartmentId: fixture.flats.E102.id, basisPoints: 3_000 },
        { apartmentId: fixture.flats.E103.id, basisPoints: 2_000 },
      ],
    };

    // A draft may be incomplete — T065 deliberately does not price a draft — so
    // creation succeeds and the refusal belongs to the calculation.
    const record = await createDraft(fixture, {
      amountPaise: 90_000,
      splitStrategy: "percentage",
      splitConfig: config,
    });

    await expect(previewOf(fixture, record)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await splitRows(record.id)).toHaveLength(0);

    await expect(
      publishOf(fixture, record, "equality-invalid-percentages"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Fail closed: the draft is still a draft and no financial row was written.
    expect(await splitRows(record.id)).toHaveLength(0);
    expect(await expenseState(record.id)).toMatchObject({
      status: "draft",
      version: 1,
    });
    expect(await publishedAuditCount(record.id)).toBe(0);
  });

  it("fails closed when a selected flat has nobody to charge, before any split row", async () => {
    // E103's tenant and owner are both removed, leaving a billable flat with no
    // member — T063's `unassigned_no_member`.
    await owner`
      delete from public.members
       where apartment_id = ${fixture.flats.E103.id}::uuid
    `;

    const record = await createDraft(fixture, {
      amountPaise: 60_000,
      splitStrategy: "equal",
    });

    const result = await previewOf(fixture, record);
    expect(result.unassigned).toEqual([
      {
        apartmentId: fixture.flats.E103.id,
        apartmentNumber: "E103",
        reason: "unassigned_no_member",
      },
    ]);

    await expect(
      publishOf(fixture, record, "equality-unassigned"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(await splitRows(record.id)).toHaveLength(0);
    expect(await expenseState(record.id)).toMatchObject({
      status: "draft",
      version: 1,
    });
    expect(await publishedAuditCount(record.id)).toBe(0);
  });
});
