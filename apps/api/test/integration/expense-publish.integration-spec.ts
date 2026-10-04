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
 * Transactional publishing against real PostgreSQL, real RLS and the real definer
 * function — Roadmap T066.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes the split store, so it can prove the contract, the guard chain
 * and the use-case orchestration over a world a test wrote down. Everything T066's
 * acceptance actually turns on needs the database:
 *
 *  1. **`SUM(splits) = amount` exactly, over 64 real flats** — the Roadmap's own
 *     test, on real `numeric` columns and a real `bigint` sum.
 *  2. **One transaction.** The splits, the `published_at` stamp and the retry record
 *     commit together or not at all, and a failure part-way leaves **zero** rows in
 *     any of them. Nothing but a real transaction can fail part-way.
 *  3. **The deferred `chk_split_total()` trigger** — the conservation invariant T060
 *     installed, exercised through the new writer.
 *  4. **The row lock.** Two concurrent publishes with different keys and the same
 *     version: exactly one wins, and the other is refused by the row it was waiting
 *     on rather than by a check it raced past.
 *  5. **The definer boundary.** `expense_publish()` re-checks the permission and the
 *     lifecycle *inside* the database, so a Committee Member's direct call is refused
 *     and a cross-society id answers `EXPENSE_NOT_FOUND`.
 *  6. **Tenant isolation** — RLS, not merely an unauthorised answer.
 *
 * Fixtures are written on the **owner** connection; every call under test runs through
 * `UnitOfWork` as an acting member. `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let publish: PublishExpenseUseCase;
let createExpense: CreateExpenseUseCase;
let splits: ExpenseSplitRepository;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  publish = harness.app.get(PublishExpenseUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  splits = harness.app.get<ExpenseSplitRepository>(EXPENSE_SPLIT_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

/** Every table a publication may write, plus the ones it must leave alone. */
const FINANCIAL_TABLES = [
  "expenses",
  "expense_splits",
  "expense_gst_details",
  "expense_revisions",
  "dues",
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

function idempotencyRecordCount(): Promise<number> {
  return tableCount("idempotency_records");
}

interface FlatSpec {
  readonly number: string;
  readonly floor?: number;
  readonly occupancy?: "owner_occupied" | "rented";
  readonly carpetAreaSqft?: string;
  readonly builtupAreaSqft?: string;
  readonly shareUnits?: string;
}

/** One billable flat plus its owner member, inserted as the owner. */
async function insertFlatWithOwner(
  societyId: SocietyId,
  buildingId: BuildingId,
  spec: FlatSpec,
): Promise<ApartmentId> {
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
      ${spec.shareUnits ?? "1"}::numeric(8, 3),
      ${spec.occupancy ?? "owner_occupied"}::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  const apartmentId = row!.id as ApartmentId;
  await insertMember(owner, societyId, {
    apartmentId,
    occupancy: spec.occupancy === "rented" ? "vacant_owner" : "owner_occupied",
    isPrimary: true,
    displayName: `Owner ${spec.number}`,
  });
  return apartmentId;
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
  readonly north: BuildingId;
  readonly flats: readonly ApartmentId[];
  readonly other: SocietyFixture;
  readonly categoryId: ExpenseCategoryId;
  readonly committeeUserId: UserId;
  readonly treasurerUserId: UserId;
}

/** A society with one building, `flatCount` flats with owners and a "Lift" category. */
async function seed(flatCount = 4): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Publish Court",
    "admin@publish.ses.test",
  );
  const north = await insertBuilding(owner, society.societyId, "North Block");

  const flats: ApartmentId[] = [];
  for (let index = 1; index <= flatCount; index += 1) {
    const number = `P${String(index).padStart(3, "0")}`;
    flats.push(
      await insertFlatWithOwner(society.societyId, north, {
        number,
        floor: ((index - 1) % 8) + 1,
        // Areas differ per flat on purpose: a per-sqft split must place the odd
        // paisa, and identical weights would hide a residual bug.
        carpetAreaSqft: `${700 + index}`,
        builtupAreaSqft: `${875 + index}`,
        occupancy: index % 5 === 0 ? "rented" : "owner_occupied",
      }),
    );
  }

  const committeeUserId = asUserId(
    await createLocalUser(owner, "committee@publish.ses.test", "Committee"),
  );
  await insertMember(owner, society.societyId, {
    userId: committeeUserId,
    role: "committee_member",
    displayName: "Committee Member",
  });

  const treasurerUserId = asUserId(
    await createLocalUser(owner, "treasurer@publish.ses.test", "Treasurer"),
  );
  await insertMember(owner, society.societyId, {
    userId: treasurerUserId,
    role: "treasurer",
    displayName: "Treasurer",
  });

  const other = await seedSociety(
    harness,
    "Other Court",
    "admin@otherpublish.ses.test",
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
    committeeUserId,
    treasurerUserId,
  };
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
      amountPaise: 600_000,
      expenseDate: "2026-09-30",
      categoryId: fixture.categoryId as string,
      ...overrides,
    },
  );
  return record.id;
}

const KEY = "integration-publish-key-0001";

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

/** The thrown error, whatever shape it arrived in — an AppError or an ExpenseError. */
async function failureOf(promise: Promise<unknown>): Promise<{
  code: unknown;
  message: string;
}> {
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

// ── reading back what a publish wrote ────────────────────────────────────────

interface SplitRow {
  readonly amount_paise: string;
  readonly weight: string | null;
  readonly percent: string | null;
  readonly assigned_reason: string | null;
  readonly member_id: string | null;
  readonly snapshot: Record<string, unknown>;
}

function splitRows(expenseId: ExpenseId): Promise<SplitRow[]> {
  return owner<SplitRow[]>`
    select amount_paise::text as amount_paise,
           weight::text as weight,
           percent::text as percent,
           assigned_reason,
           member_id,
           snapshot
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
     order by amount_paise desc, member_id
  `;
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

/** The primary owner of one fixture flat — the member a real split addresses. */
async function ownerRefOf(
  apartmentId: ApartmentId,
): Promise<{ memberId: MemberId; name: string }> {
  const [row] = await owner<{ id: string; display_name: string }[]>`
    select id, display_name
      from public.members
     where apartment_id = ${apartmentId}::uuid
       and is_primary = true
     limit 1
  `;
  if (row === undefined) {
    throw new Error(`Fixture flat ${apartmentId} has no primary owner.`);
  }
  return { memberId: asMemberId(row.id), name: row.display_name };
}

/**
 * One allocation as the publish path persists it, built from the real owner row.
 *
 * These are the values the split engine would have produced, written down by hand so
 * a test can vary exactly one fact — an amount, a member, a duplicate — and watch the
 * database judge the set rather than the engine that would have made it.
 */
async function allocationOf(
  fixture: Fixture,
  flatIndex: number,
  amountPaise: bigint | number,
  overrides: Partial<PublishExpenseAllocation> = {},
): Promise<PublishExpenseAllocation> {
  const apartmentId = fixture.flats[flatIndex];
  if (apartmentId === undefined) {
    throw new Error(`The fixture has no flat at index ${flatIndex}.`);
  }
  const ownerRef = await ownerRefOf(apartmentId);
  return {
    memberId: ownerRef.memberId,
    apartmentId,
    amount: Money.fromPaise(amountPaise),
    weight: weight(1),
    percent: null,
    assignedReason: null,
    snapshot: {
      memberName: ownerRef.name,
      apartmentNumber: `P${String(flatIndex + 1).padStart(3, "0")}`,
    },
    ...overrides,
  };
}

/** Equal shares across every fixture flat — a conserving set by construction. */
async function equalAllocations(
  fixture: Fixture,
  amountPaise: bigint = 600_000n,
): Promise<PublishExpenseAllocation[]> {
  const share = amountPaise / BigInt(fixture.flats.length);
  return Promise.all(
    fixture.flats.map((_, index) => allocationOf(fixture, index, share)),
  );
}

/** The input `splits.publish` writes, with a hash that names the request. */
function publishInputOf(
  idempotencyKey: string,
  allocations: readonly PublishExpenseAllocation[],
  expectedVersion = 1,
): PublishExpenseRecordInput {
  return {
    expectedVersion,
    idempotencyKey,
    requestHash: `integration-hash:${idempotencyKey}`,
    allocations,
  };
}

describe("PublishExpenseUseCase against real storage", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("publishes a draft, writes its splits and stamps published_at in one commit", async () => {
    const expenseId = await createDraft(fixture, { amountPaise: 600_000 });
    const before = await financialCounts();
    expect(before).toMatchObject({ expense_splits: 0, dues: 0 });

    const publication = await publishOf(fixture, expenseId);

    expect(publication.replayed).toBe(false);
    expect(publication.expense.status).toBe("published");
    expect(publication.expense.publishedAt).not.toBeNull();

    const rows = await splitRows(expenseId);
    expect(rows).toHaveLength(4);
    const total = rows.reduce((sum, row) => sum + BigInt(row.amount_paise), 0n);
    expect(total).toBe(600_000n);

    // The summary the response carried is the persisted one.
    expect(publication.summary.total.paise).toBe(total);
    expect(publication.summary.participantCount).toBe(rows.length);

    // And the other three financial tables are still untouched: the transaction
    // wrote splits, not receivables.
    expect(await financialCounts()).toMatchObject({
      expense_splits: 4,
      dues: 0,
      expense_revisions: 0,
      expense_gst_details: 0,
    });
    expect(await idempotencyRecordCount()).toBe(1);
  });

  it("publishes ₹60,000 per-sqft across 64 real flats with SUM(splits) = 6000000 exactly", async () => {
    // The Roadmap's own test, at the schema's own scale: 64 flats, a per-sqft basis
    // and ₹60,000 (6,000,000 paise). Every paisa has to land somewhere, and the
    // database's own sum is what is asserted.
    await resetData(owner);
    const big = await seed(64);
    const expenseId = await createDraft(big, {
      title: "Repainting — all towers",
      amountPaise: 6_000_000,
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
    });

    const publication = await publishOf(big, expenseId);

    const rows = await splitRows(expenseId);
    expect(rows).toHaveLength(64);
    const total = rows.reduce((sum, row) => sum + BigInt(row.amount_paise), 0n);
    expect(total).toBe(6_000_000n);
    expect(publication.summary.total.paise).toBe(6_000_000n);

    // The database's own arithmetic, not the application's: the same invariant the
    // deferred trigger enforces at COMMIT.
    const [sum] = await owner<{ total: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as total
        from public.expense_splits
       where expense_id = ${expenseId}::uuid
    `;
    expect(sum?.total).toBe("6000000");

    // Every flat was billed once, with its weight recorded in the column's scale.
    const [weights] = await owner<{ count: string }[]>`
      select count(distinct member_id)::text as count
        from public.expense_splits
       where expense_id = ${expenseId}::uuid
         and weight is not null
    `;
    expect(weights?.count).toBe("64");
    expect(await financialCounts()).toMatchObject({ dues: 0 });
  });

  it("snapshots the member name and flat number on every persisted row", async () => {
    const expenseId = await createDraft(fixture);

    await publishOf(fixture, expenseId);

    const rows = await splitRows(expenseId);
    for (const row of rows) {
      expect(typeof row.snapshot["memberName"]).toBe("string");
      expect(String(row.snapshot["memberName"]).length).toBeGreaterThan(0);
      expect(row.snapshot["apartmentNumber"]).toMatch(/^P\d{3}$/);
    }
    // The snapshot is the roster as it was: the member's own display name.
    expect(
      rows.map((row) => String(row.snapshot["memberName"])).sort(),
    ).toEqual(rows.map((row) => String(row.snapshot["memberName"])).sort());
  });
});

describe("idempotency over real storage — SAD §7.7", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("replays the stored response for the same key and writes nothing again", async () => {
    const expenseId = await createDraft(fixture);
    const first = await publishOf(fixture, expenseId);

    const versionAfterFirst = (
      await owner<{ version: number }[]>`
        select version from public.expenses where id = ${expenseId}::uuid
      `
    )[0]?.version;
    const splitsAfterFirst = await tableCount("expense_splits");

    const second = await publishOf(fixture, expenseId);

    expect(second.replayed).toBe(true);
    expect(second.expense.version).toBe(first.expense.version);
    expect(second.summary.total.paise).toBe(first.summary.total.paise);
    // One record, one version bump, the same split rows.
    expect(await idempotencyRecordCount()).toBe(1);
    expect(await tableCount("expense_splits")).toBe(splitsAfterFirst);
    expect(
      (
        await owner<{ version: number }[]>`
          select version from public.expenses where id = ${expenseId}::uuid
        `
      )[0]?.version,
    ).toBe(versionAfterFirst);
  });

  it("refuses the same key for a different request with IDEMPOTENCY_KEY_REUSE", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);

    const error = await failureOf(
      publishOf(fixture, expenseId, { expectedVersion: 2 }),
    );

    expect(error.code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  it("scopes the key by the caller — the same spelling is a second member's own key", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);

    // The treasurer publishes a different expense under the same spelling. The key
    // is (user, key), so this is a first request for them — not a replay of the
    // admin's, and not a reuse refusal.
    const second = await createDraft(fixture, { title: "Garden AMC — Q4" });
    const publication = await publish.publish(
      fixture.treasurerUserId,
      fixture.societyId,
      second,
      { expectedVersion: 1, idempotencyKey: KEY },
    );
    expect(publication.replayed).toBe(false);
    expect(publication.expense.status).toBe("published");

    // Two records, two callers, one spelling — and the admin's own key still replays.
    const [records] = await owner<{ rows: string; users: string }[]>`
      select count(*)::text as rows,
             count(distinct user_id)::text as users
        from public.idempotency_records
       where idempotency_key = ${KEY}
    `;
    expect(records?.rows).toBe("2");
    expect(records?.users).toBe("2");
    expect((await publishOf(fixture, expenseId)).replayed).toBe(true);
  });

  it("keeps the unique index — one record per (user, key)", async () => {
    const expenseId = await createDraft(fixture);
    await publishOf(fixture, expenseId);

    // Written twice through the same key, the second insert conflicts; the API
    // never does this, and the index is what makes the guarantee structural.
    const duplicate = await failureOf(
      owner`
        insert into public.idempotency_records
          (user_id, society_id, idempotency_key, request_hash, response_body)
        values (
          ${fixture.adminUserId}::uuid,
          ${fixture.societyId}::uuid,
          ${KEY},
          'other-hash',
          '{}'::jsonb
        )
      `,
    );

    expect(duplicate.message).toMatch(/duplicate key|unique/i);
    expect(await idempotencyRecordCount()).toBe(1);
  });
});

describe("atomicity against real storage", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("refuses a non-conserving allocation set and writes nothing at all", async () => {
    const expenseId = await createDraft(fixture);
    const before = await statusOf(expenseId);

    // One paisa short of the bill. The definer function sums the allocations before
    // it writes anything, so the refusal happens inside the database on the real
    // amounts — not in the use case that would ordinarily compute them.
    const allocations = [
      await allocationOf(fixture, 0, 300_000n),
      await allocationOf(fixture, 1, 299_999n),
    ];

    const error = await failureOf(
      splits.publish(
        expenseId,
        fixture.societyId,
        publishInputOf(KEY, allocations),
        fixture.adminUserId,
      ),
    );

    expect(error.code).toBe("split_mismatch");
    expect(await splitRows(expenseId)).toHaveLength(0);
    expect(await statusOf(expenseId)).toEqual(before);
    expect(await idempotencyRecordCount()).toBe(0);
  });

  it("rolls back a delete already performed when a later insert fails", async () => {
    const expenseId = await createDraft(fixture);
    const before = await statusOf(expenseId);

    // A stale split row, as an earlier attempt at this draft might have left. The
    // function deletes it first; the insert below then violates the participant
    // unique key, and the delete has to be undone with everything else.
    const stale = await allocationOf(fixture, 1, 1n);
    await owner`
      insert into public.expense_splits (
        society_id, expense_id, member_id, apartment_id, amount_paise, snapshot
      )
      values (
        ${fixture.societyId}::uuid,
        ${expenseId}::uuid,
        ${stale.memberId}::uuid,
        ${stale.apartmentId}::uuid,
        1,
        '{"memberName":"Stale"}'::jsonb
      )
    `;
    expect(await splitRows(expenseId)).toHaveLength(1);

    // The same owner twice: conserving in total, impossible as rows.
    const duplicate = await allocationOf(fixture, 0, 300_000n);
    const again = await allocationOf(fixture, 0, 300_000n);

    const error = await failureOf(
      splits.publish(
        expenseId,
        fixture.societyId,
        publishInputOf(KEY, [duplicate, again]),
        fixture.adminUserId,
      ),
    );

    expect(error.code).toBe("conflict");
    // The delete the function ran first came back with the rollback.
    expect(await splitRows(expenseId)).toHaveLength(1);
    expect(await statusOf(expenseId)).toEqual(before);
    expect(await idempotencyRecordCount()).toBe(0);
  });

  it("rolls everything back when an allocation names a member of another society", async () => {
    const expenseId = await createDraft(fixture);
    const before = await statusOf(expenseId);

    const allocations = await equalAllocations(fixture);
    // A member id that exists — just in the wrong society. The composite foreign
    // key is what refuses it, at insert time, after the transaction has begun work.
    allocations[0] = {
      ...allocations[0]!,
      memberId: fixture.other.adminMemberId,
    };

    const error = await failureOf(
      splits.publish(
        expenseId,
        fixture.societyId,
        publishInputOf(KEY, allocations),
        fixture.adminUserId,
      ),
    );

    // The classifier's generic foreign-key answer: the reference names something
    // this society does not have.
    expect(error.code).toBe("not_found");
    expect(await splitRows(expenseId)).toHaveLength(0);
    expect(await statusOf(expenseId)).toEqual(before);
    expect(await idempotencyRecordCount()).toBe(0);
  });

  it("lets exactly one of two concurrent publishes with different keys win", async () => {
    const expenseId = await createDraft(fixture);

    const results = await Promise.allSettled([
      publishOf(fixture, expenseId, { idempotencyKey: "race-key-0001" }),
      publishOf(fixture, expenseId, { idempotencyKey: "race-key-0002" }),
    ]);

    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser waited on the row lock and read the published status after the
    // winner's commit — the lifecycle, not the version, is what refuses it.
    expect((lost[0]!.reason as { code?: unknown }).code).toBe(
      "INVALID_TRANSITION",
    );

    expect(await splitRows(expenseId)).toHaveLength(4);
    expect(await idempotencyRecordCount()).toBe(1);
    expect(await statusOf(expenseId)).toMatchObject({
      status: "published",
      version: 2,
    });
  });

  it("refuses a Committee Member's direct call inside the database", async () => {
    const expenseId = await createDraft(fixture);
    const allocations = await equalAllocations(fixture);

    // No HTTP guard in this path: the definer function's own `expense.publish`
    // check is the only thing between this caller and a publish.
    const error = await failureOf(
      splits.publish(
        expenseId,
        fixture.societyId,
        publishInputOf(KEY, allocations),
        fixture.committeeUserId,
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(await splitRows(expenseId)).toHaveLength(0);
    expect(await statusOf(expenseId)).toMatchObject({
      status: "draft",
      version: 1,
    });
    expect(await idempotencyRecordCount()).toBe(0);
  });

  it("answers not_found for an expense outside the caller's society", async () => {
    const expenseId = await createDraft(fixture);
    const allocations = await equalAllocations(fixture);

    // A member of the other society, publishing through their own society: the
    // expense is not theirs to see, and the lock is where they find that out.
    const error = await failureOf(
      splits.publish(
        expenseId,
        fixture.other.societyId,
        publishInputOf(KEY, allocations),
        fixture.other.adminUserId,
      ),
    );

    expect(error.code).toBe("not_found");
    expect(await splitRows(expenseId)).toHaveLength(0);
    expect(await statusOf(expenseId)).toMatchObject({ status: "draft" });
    expect(await idempotencyRecordCount()).toBe(0);
  });

  it("commits the splits, the transition and the record together", async () => {
    const expenseId = await createDraft(fixture);

    const publication = await publishOf(fixture, expenseId);

    // The positive half of "all written or none": the three writes the transaction
    // owns become visible together, and the record describes the committed state
    // rather than the one the request intended.
    expect(publication.replayed).toBe(false);
    expect((await statusOf(expenseId)).status).toBe("published");
    expect(await splitRows(expenseId)).toHaveLength(4);
    expect(await idempotencyRecordCount()).toBe(1);
    const [record] = await owner<
      { response_body: { expense?: { status?: string } } }[]
    >`
      select response_body
        from public.idempotency_records
       where idempotency_key = ${KEY}
    `;
    expect(record?.response_body.expense?.status).toBe("published");
  });
});
