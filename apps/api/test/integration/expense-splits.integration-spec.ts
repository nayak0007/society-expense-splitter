import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { asExpenseId } from "@ses/domain";
import type {
  ExpenseId,
  ExpenseSplitsReader,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_SPLITS_READER } from "../../src/modules/expenses/application/expense.tokens";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { ListSplitsUseCase } from "../../src/modules/expenses/application/use-cases/list-splits.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import { VoidExpenseUseCase } from "../../src/modules/expenses/application/use-cases/void-expense.use-case";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertApartment,
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
 * `GET /expenses/:expenseId/splits` against real PostgreSQL, real RLS and the real
 * grants — Roadmap T073, PRD §3.5.3.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes the stores, so it can pin the route, the guard and the response
 * contract. Everything this read actually turns on is a fact about committed rows and
 * privileges:
 *
 * ```text
 *   persisted verbatim   the table returned is the one publish wrote, not a
 *                        re-run of the engine and not a revision snapshot
 *   exact conservation   SUM(amount_paise) = the expense's amount, in bigint paise
 *                        with no float anywhere
 *   read-only            `expense_splits` is unwritable by `authenticated`; not one
 *                        financial row moves when the read runs
 *   tenant isolation     another society's member reads nothing; a foreign or
 *                        unknown expense is a 404 (never a 403)
 *   the empty answer     a draft has no splits and says so with `[]`, not an error
 * ```text
 *
 * Fixtures are written on the **owner** connection; every call under test runs through
 * `UnitOfWork` as the acting member, and `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let publish: PublishExpenseUseCase;
let createExpense: CreateExpenseUseCase;
let listSplits: ListSplitsUseCase;
let voidExpense: VoidExpenseUseCase;
let reader: ExpenseSplitsReader;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  publish = harness.app.get(PublishExpenseUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  listSplits = harness.app.get(ListSplitsUseCase);
  voidExpense = harness.app.get(VoidExpenseUseCase);
  reader = harness.app.get<ExpenseSplitsReader>(EXPENSE_SPLITS_READER);
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

interface World extends SocietyFixture {
  readonly categoryId: string;
  readonly otherSocietyId: SocietyId;
  readonly otherAdminUserId: UserId;
}

/**
 * A society with a category, two billable flats with owners, and a second society.
 *
 * The flats are the whole point: publishing resolves its participants from the
 * society's billable flats, so a society of members who live nowhere has no split to
 * publish and this suite would have nothing to read.
 */
async function world(): Promise<World> {
  const society = await seedSociety(harness, "Split Court", "admin@t073.test");
  const [category] = await owner<{ id: string }[]>`
    select id from public.expense_categories
     where society_id = ${society.societyId}::uuid
     order by display_order asc
     limit 1
  `;
  await seedFlats(society.societyId, "North Block", 3);
  const other = await seedSociety(harness, "Split Other", "admin@t073b.test");
  // The other society needs its own billable flats too, so a real publish there can
  // write splits the RLS test can try (and fail) to read across the tenant boundary.
  await seedFlats(other.societyId, "Other Block", 2);
  return {
    ...society,
    categoryId: category!.id,
    otherSocietyId: other.societyId,
    otherAdminUserId: other.adminUserId,
  };
}

/** A building of billable, owner-occupied flats — the participants publish resolves. */
async function seedFlats(
  societyId: SocietyId,
  buildingName: string,
  count: number,
): Promise<void> {
  const buildingId = await insertBuilding(owner, societyId, buildingName);
  for (let index = 1; index <= count; index += 1) {
    const apartmentId = await insertApartment(
      owner,
      societyId,
      buildingId,
      `A${index}`,
      index,
    );
    await insertMember(owner, societyId, {
      apartmentId,
      isPrimary: true,
      displayName: `Owner A${index}`,
    });
  }
}

/** A draft through the real create path. */
async function draftExpense(
  w: World,
  amountPaise = 300_000,
  actor: UserId = w.adminUserId,
): Promise<ExpenseId> {
  const record = await createExpense.create(actor, w.societyId, {
    title: "Lift AMC — Q3",
    amountPaise,
    expenseDate: "2026-10-01",
    categoryId: w.categoryId,
  });
  return record.id;
}

/** A published bill, so `expense_splits` has real rows. */
async function publishedExpense(
  w: World,
  amountPaise = 300_000,
): Promise<ExpenseId> {
  const expenseId = await draftExpense(w, amountPaise);
  await publish.publish(w.adminUserId, w.societyId, expenseId, {
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
  });
  return expenseId;
}

/** The expense's own amount, read as a digit string. */
async function amountOf(expenseId: ExpenseId): Promise<string> {
  const [row] = await owner<{ amount_paise: string }[]>`
    select amount_paise::text as amount_paise from public.expenses
     where id = ${expenseId}::uuid
  `;
  return row!.amount_paise;
}

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

async function failureOf(
  promise: Promise<unknown>,
): Promise<{ code: unknown; status: unknown }> {
  try {
    await promise;
  } catch (error: unknown) {
    const app = error as { code?: unknown; status?: unknown };
    return { code: app.code, status: app.status };
  }
  throw new Error("Expected the call to be refused.");
}

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

// ── privileges ───────────────────────────────────────────────────────────────

describe("expense_splits writes are policy- and invariant-gated", () => {
  it("forces RLS and refuses an insert from a caller with no publish/draft capability", async () => {
    const [row] = await owner<{ rls: boolean; force: boolean }[]>`
      select c.relrowsecurity as rls, c.relforcerowsecurity as force
        from pg_class c
       where c.oid = 'public.expense_splits'::regclass
    `;
    expect(row).toMatchObject({ rls: true, force: true });

    const w = await world();
    const expenseId = await publishedExpense(w);
    const residentUserId = (await createLocalUser(
      owner,
      "resident@t073s.test",
      "Resident",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: residentUserId,
      role: "resident",
    });

    // The insert policy requires `can_publish_expenses` or a draft the caller can edit;
    // a Resident is neither, so the write is a policy refusal (42501).
    const state = await sqlstateAs(
      residentUserId,
      sql`insert into public.expense_splits (
            expense_id, society_id, member_id, apartment_id, amount_paise, assigned_reason
          ) values (
            ${expenseId}::uuid, ${w.societyId}::uuid,
            ${w.adminMemberId}::uuid, null, 1, 'equal_share'
          )`,
    );
    expect(["42501", "refused"]).toContain(state);
  }, 60_000);

  it("refuses a hand-written split that breaks the total at COMMIT", async () => {
    const w = await world();
    const expenseId = await publishedExpense(w);

    // An Admin *can* insert under the publish capability — so the refusal here is not
    // the policy but the table's own conservation guard: `chk_split_total()` is a
    // deferred constraint trigger and raises `P0001` when the sum no longer equals the
    // expense's amount. A client cannot add a row to a bill and leave the ledger short.
    const state = await sqlstateAs(
      w.adminUserId,
      sql`insert into public.expense_splits (
            expense_id, society_id, member_id, apartment_id, amount_paise, assigned_reason
          ) values (
            ${expenseId}::uuid, ${w.societyId}::uuid,
            ${w.adminMemberId}::uuid, null, 1, 'equal_share'
          )`,
    );
    expect(state).toBe("P0001");
  }, 60_000);
});

// ── the persisted rows, verbatim ─────────────────────────────────────────────

describe("the read returns the persisted allocation, not a calculation", () => {
  it("returns one row per published participant, matching the stored rows byte for byte", async () => {
    const w = await world();
    const expenseId = await publishedExpense(w, 300_000);

    const stored = await owner<
      {
        id: string;
        member_id: string | null;
        apartment_id: string | null;
        amount_paise: string;
        weight: string | null;
      }[]
    >`
      select id, member_id, apartment_id, amount_paise::text as amount_paise,
             weight::text as weight
        from public.expense_splits
       where expense_id = ${expenseId}::uuid
       order by created_at asc, id asc
    `;
    expect(stored.length).toBeGreaterThan(0);

    const splits = await listSplits.list(w.adminUserId, w.societyId, expenseId);

    // The number of rows is the number publish wrote, and each value is the row's
    // own — this is the assertion that a recomputation or a snapshot read would fail.
    expect(splits.map((split) => split.id)).toEqual(
      stored.map((row) => row.id),
    );
    expect(splits.map((split) => split.amount.paise.toString())).toEqual(
      stored.map((row) => row.amount_paise),
    );
  });

  it("conserves the exact amount in bigint paise — SUM(splits) === amount", async () => {
    const w = await world();
    // An amount below the society's approval threshold (so publish is permitted) that
    // does not divide evenly by the three flats, so the residual distribution is
    // exercised rather than a clean division.
    const amountPaise = 100_000;
    const expenseId = await publishedExpense(w, amountPaise);

    const splits = await listSplits.list(w.adminUserId, w.societyId, expenseId);
    expect(splits.length).toBe(3);

    // BigInt throughout: no number ever touches a float, so a value near 2^53 could
    // not drift. Compared against the expense's own stored amount, not the input.
    const sum = splits.reduce((total, split) => total + split.amount.paise, 0n);
    expect(sum).toBe(BigInt(await amountOf(expenseId)));
    expect(BigInt(await amountOf(expenseId))).toBe(BigInt(amountPaise));
  }, 60_000);

  it("orders the table oldest-first", async () => {
    const w = await world();
    const expenseId = await publishedExpense(w);

    const stored = await owner<{ id: string }[]>`
      select id from public.expense_splits
       where expense_id = ${expenseId}::uuid
       order by created_at asc, id asc
    `;
    const splits = await listSplits.list(w.adminUserId, w.societyId, expenseId);
    expect(splits.map((split) => split.id)).toEqual(
      stored.map((row) => row.id),
    );
  });

  it("carries the snapshot name and flat number the row was written with", async () => {
    const w = await world();
    const expenseId = await publishedExpense(w);

    const splits = await listSplits.list(w.adminUserId, w.societyId, expenseId);
    // Every split is addressed to a member and a flat, and the snapshot is the label
    // publish recorded — never re-read from `members`.
    for (const split of splits) {
      expect(split.snapshot.apartmentNumber).toMatch(/^A\d$/);
      expect(split.snapshot.memberName).toContain("Owner");
    }
  });
});

// ── the empty answer ─────────────────────────────────────────────────────────

describe("an unallocated expense has no splits", () => {
  it("answers [] for a draft rather than an error", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    const splits = await listSplits.list(w.adminUserId, w.societyId, expenseId);
    expect(splits).toEqual([]);
    expect(
      await owner<{ count: string }[]>`
        select count(*)::text as count from public.expense_splits
         where expense_id = ${expenseId}::uuid
      `,
    ).toEqual([{ count: "0" }]);
  });

  it("answers [] for a pending_approval expense", async () => {
    const w = await world();
    // Above the society's threshold, so create lands it in approval rather than draft.
    const expenseId = await draftExpense(w, 2_000_000);

    const [row] = await owner<{ status: string }[]>`
      select status::text as status from public.expenses where id = ${expenseId}::uuid
    `;
    expect(row!.status).toBe("pending_approval");
    expect(
      await listSplits.list(w.adminUserId, w.societyId, expenseId),
    ).toEqual([]);
  });
});

// ── tenancy and not-found ────────────────────────────────────────────────────

describe("a foreign or unknown expense is a 404, never a 403", () => {
  it("404s for an unknown expense id", async () => {
    const w = await world();
    const failure = await failureOf(
      listSplits.list(w.adminUserId, w.societyId, asExpenseId(randomUUID())),
    );
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.status).toBe(404);
  });

  it("404s for another society's expense", async () => {
    const w = await world();
    // A real expense that lives in the *other* society, addressed with this caller's
    // society id: the load answers 404 because the row is not visible to this caller in
    // this society, which is the same answer an absent id gets. The expense does not
    // need splits — the 404 happens before the reader is reached.
    const otherExpense = await createExpense.create(
      w.otherAdminUserId,
      w.otherSocietyId,
      {
        title: "Other bill",
        amountPaise: 100_000,
        expenseDate: "2026-10-01",
        categoryId: (
          await owner<{ id: string }[]>`
            select id from public.expense_categories
             where society_id = ${w.otherSocietyId}::uuid
             order by display_order asc limit 1
          `
        )[0]!.id,
      },
    );

    const failure = await failureOf(
      listSplits.list(w.adminUserId, w.societyId, otherExpense.id),
    );
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.status).toBe(404);
  }, 60_000);

  it("hides another tenant's split rows from the reader itself (RLS)", async () => {
    const w = await world();
    const otherExpense = await createExpense.create(
      w.otherAdminUserId,
      w.otherSocietyId,
      {
        title: "Other bill",
        amountPaise: 100_000,
        expenseDate: "2026-10-01",
        categoryId: (
          await owner<{ id: string }[]>`
            select id from public.expense_categories
             where society_id = ${w.otherSocietyId}::uuid
             order by display_order asc limit 1
          `
        )[0]!.id,
      },
    );
    await publish.publish(
      w.otherAdminUserId,
      w.otherSocietyId,
      otherExpense.id,
      { expectedVersion: 1, idempotencyKey: randomUUID() },
    );

    // The reader, called directly with the *other* society's own id and expense id but
    // this society's caller, must return nothing: the rows exist and match the
    // society predicate, so only `can_view_expenses` RLS can be what hides them. The
    // `society_id` filter beside `expense_id` is why a caller cannot even address a
    // foreign id, and the policy is why the read returns no rows.
    const rows = await reader.listForExpense(
      otherExpense.id,
      w.otherSocietyId,
      w.adminUserId,
    );
    expect(rows).toEqual([]);

    // And the other society's own member reads them — the split set really was written.
    const visible = await reader.listForExpense(
      otherExpense.id,
      w.otherSocietyId,
      w.otherAdminUserId,
    );
    expect(visible.length).toBeGreaterThan(0);
  }, 60_000);
});

// ── the read mutates nothing ─────────────────────────────────────────────────

describe("the read touches no financial row", () => {
  it("leaves every count and the split table byte-identical", async () => {
    const w = await world();
    const expenseId = await publishedExpense(w, 300_000);

    const before = await financialCounts();
    const splitsBefore = await owner`
      select id::text, amount_paise::text from public.expense_splits order by id
    `;
    const amountsBefore = await owner`
      select id::text, amount_paise::text, status::text, version
        from public.expenses order by id
    `;

    await listSplits.list(w.adminUserId, w.societyId, expenseId);
    await listSplits.list(w.adminUserId, w.societyId, expenseId);

    expect(await financialCounts()).toEqual(before);
    expect(
      await owner`select id::text, amount_paise::text from public.expense_splits order by id`,
    ).toEqual(splitsBefore);
    expect(
      await owner`select id::text, amount_paise::text, status::text, version from public.expenses order by id`,
    ).toEqual(amountsBefore);
  }, 30_000);

  it("keeps a void expense's splits readable and leaves the void untouched", async () => {
    const w = await world();
    const expenseId = await publishedExpense(w);
    await voidExpense.void(w.adminUserId, w.societyId, expenseId, {
      expectedVersion: 2,
      reason: "Posted to the wrong expense account",
    });

    // The splits survive a void (ADR-0010 D1) and remain readable, but the read writes
    // nothing: the expense row is still `void` afterwards and its version did not move.
    const splits = await listSplits.list(w.adminUserId, w.societyId, expenseId);
    expect(splits.length).toBeGreaterThan(0);
    const [row] = await owner<{ status: string; version: number }[]>`
      select status::text as status, version from public.expenses
       where id = ${expenseId}::uuid
    `;
    expect(row!.status).toBe("void");
    expect(row!.version).toBe(3);
  }, 60_000);
});
