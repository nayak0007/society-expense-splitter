import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type postgres from "postgres";

import { resolveMigrationsDir } from "../../src/infrastructure/database/migrations/runner";
import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";

import {
  createLocalUser,
  ownerClient,
  resetData,
} from "../utils/integration-db";
import {
  startIntegrationHarness,
  ownerUrl,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * The expense domain's schema, its default categories and its money invariant —
 * Roadmap T060 (SAD §8.1/§8.3/§8.5/§8.6/§8.7, PRD §7.3, §3.5.3).
 *
 * Why this cannot be a unit test: every claim here is a claim about what PostgreSQL
 * does. `chk_split_total()` is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so
 * "the write is refused" means "the COMMIT is refused" — a distinction no fake can
 * reproduce, and the reason the multi-row test below deliberately leaves the total
 * short mid-transaction and still expects the transaction to commit. The tenancy
 * assertions are the same story: SAD §8.7 makes the policies the primary boundary, so
 * what matters is what a given `auth.uid()` can see, not what a repository intended.
 *
 * The fixture split is the same one in every invariant test — a published ₹100
 * expense (10,000 paise) divided 4,000 / 3,500 / 2,500 across three flats — so a
 * failure is a failure of the invariant and not of the arithmetic a test chose.
 *
 * Fixtures are written on the **owner** connection (RLS-exempt, DDL-capable); the
 * behaviour under test runs either through the owner connection's own transactions
 * (the invariant is not an identity question) or through `UnitOfWork` as a real
 * identity (the policies are).
 */

let harness: IntegrationHarness;
let owner: IntegrationHarness["owner"];
let unitOfWork: IntegrationHarness["unitOfWork"];

afterAll(async () => {
  await harness.stop();
});

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  unitOfWork = harness.unitOfWork;
}, 60_000);

async function rows<T = Record<string, unknown>>(
  tx: TransactionContext,
  query: SQL,
): Promise<readonly T[]> {
  return (await tx.execute(query)) as unknown as readonly T[];
}

/** The nineteen defaults, in the PRD §3.5.3 order the seed uses for `display_order`. */
const DEFAULT_CATEGORIES = [
  "Maintenance",
  "Water",
  "Electricity",
  "Housekeeping",
  "Security",
  "Lift",
  "Gardening",
  "Plumbing",
  "Electrical Repairs",
  "Painting",
  "Pest Control",
  "Generator/Diesel",
  "Festival & Events",
  "Legal & Professional",
  "Insurance",
  "Bank Charges",
  "Sinking Fund",
  "Corpus Fund",
  "Miscellaneous",
] as const;

/** The published expense every invariant test starts from. */
const AMOUNT = 10_000n;
const SPLITS = [4_000n, 3_500n, 2_500n] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface Society {
  readonly societyId: string;
  readonly adminUserId: string;
  readonly adminMemberId: string;
  /** Three flats, because one expense's three splits need three participants. */
  readonly apartmentIds: readonly [string, string, string];
  readonly categoryId: string;
}

/** Creates a society through the real RPC, so `seed_society()` is the seeder. */
async function createSociety(name: string, email: string): Promise<Society> {
  const adminUserId = await createLocalUser(owner, email, "Admin");
  const societyId = await unitOfWork.transaction(
    { kind: "user", userId: adminUserId },
    async (tx) => {
      const [created] = await rows<{ value: string }>(
        tx,
        // The cast is required, not cosmetic: `jsonb_build_object` is variadic `any`, so
        // an untyped bind parameter leaves the server unable to infer its type.
        sql`select (public.society_create(jsonb_build_object(
              'name', ${name}::text, 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
            )))->'society'->>'id' as value`,
      );
      return created!.value;
    },
  );

  const [admin] = await owner<{ id: string }[]>`
    select id from public.members
     where society_id = ${societyId}::uuid and user_id = ${adminUserId}::uuid
  `;
  const [building] = await owner<{ id: string }[]>`
    insert into public.buildings (society_id, name)
    values (${societyId}::uuid, 'Block A')
    returning id
  `;
  const flats = await owner<{ id: string }[]>`
    insert into public.apartments (society_id, building_id, apartment_number, floor)
    values
      (${societyId}::uuid, ${building!.id}::uuid, 'A-101', 1),
      (${societyId}::uuid, ${building!.id}::uuid, 'A-102', 1),
      (${societyId}::uuid, ${building!.id}::uuid, 'A-201', 2)
    returning id
  `;
  const [category] = await owner<{ id: string }[]>`
    select id from public.expense_categories
     where society_id = ${societyId}::uuid and name = 'Maintenance'
  `;

  return {
    societyId,
    adminUserId,
    adminMemberId: admin!.id,
    apartmentIds: [flats[0]!.id, flats[1]!.id, flats[2]!.id],
    categoryId: category!.id,
  };
}

/**
 * A member of `society` with a real account, inserted as the owner.
 *
 * `status = 'active'` is what every policy requires; `is_primary = false` keeps clear
 * of `uq_primary_occupant`, which admits one primary occupant per flat.
 */
async function addMember(
  society: Society,
  email: string,
  role: "resident" | "tenant" | "committee" | "guest" | "treasurer",
  apartmentId: string | null = null,
): Promise<{ readonly memberId: string; readonly userId: string }> {
  const userId = await createLocalUser(owner, email, `${role} user`);
  const [row] = await owner<{ id: string }[]>`
    insert into public.members (
      society_id, user_id, display_name, role, status, occupancy, apartment_id, is_primary
    )
    values (
      ${society.societyId}::uuid, ${userId}::uuid, ${`${role} user`},
      ${role}::public.member_role, 'active', 'owner_occupied',
      ${apartmentId}::uuid, false
    )
    returning id
  `;
  return { memberId: row!.id, userId };
}

/** Inserts a draft expense — no splits needed, and none required by the invariant. */
async function insertDraft(
  society: Society,
  createdBy: string,
  amountPaise: bigint = AMOUNT,
): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.expenses (
      society_id, category_id, title, amount_paise, expense_date,
      split_strategy, status, created_by
    )
    values (
      ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Water tanker',
      ${amountPaise.toString()}::bigint, current_date, 'equal', 'draft', ${createdBy}::uuid
    )
    returning id
  `;
  return row!.id;
}

/**
 * A published expense and its splits, in **one** transaction — which is not a
 * convenience: publishing with a partial split set is exactly what the deferred check
 * refuses at COMMIT, so the fixture has to be built the way the real path will be.
 *
 * Each split goes to a different flat, because `uq_expense_splits_participant` admits
 * one row per participant per expense (and it is `NULLS NOT DISTINCT`, so three
 * member-less rows for one flat would collide).
 */
async function insertPublished(
  society: Society,
  createdBy: string,
  amountPaise: bigint = AMOUNT,
  splits: readonly bigint[] = SPLITS,
): Promise<string> {
  return owner.begin(async (tx) => {
    const [expense] = await tx<{ id: string }[]>`
      insert into public.expenses (
        society_id, category_id, title, amount_paise, expense_date,
        split_strategy, status, published_at, created_by
      )
      values (
        ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Water tanker',
        ${amountPaise.toString()}::bigint, current_date, 'equal', 'published', now(),
        ${createdBy}::uuid
      )
      returning id
    `;
    let index = 0;
    for (const amount of splits) {
      await tx`
        insert into public.expense_splits (
          society_id, expense_id, apartment_id, amount_paise, snapshot
        )
        values (
          ${society.societyId}::uuid, ${expense!.id}::uuid,
          ${society.apartmentIds[index % 3]!}::uuid, ${amount.toString()}::bigint, '{}'::jsonb
        )
      `;
      index += 1;
    }
    return expense!.id;
  });
}

/** The stored split amounts, ascending, as bigints. */
async function storedSplits(expenseId: string): Promise<readonly bigint[]> {
  const result = await owner<{ amount_paise: string }[]>`
    select amount_paise::text as amount_paise
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
     order by amount_paise
  `;
  return result.map((row) => BigInt(row.amount_paise));
}

/** The committed sum of an expense's splits. */
async function storedTotal(expenseId: string): Promise<bigint> {
  const [row] = await owner<{ total: string }[]>`
    select coalesce(sum(amount_paise), 0)::text as total
      from public.expense_splits
     where expense_id = ${expenseId}::uuid
  `;
  return BigInt(row!.total);
}

interface Refusal {
  readonly committed: boolean;
  readonly code: string | null;
  readonly message: string;
}

/** The SQLSTATE, whichever layer of the error carries it. */
function sqlState(error: unknown): string | null {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.cause?.code === "string") return candidate.cause.code;
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `work` in a real transaction and reports what the server decided at COMMIT.
 *
 * The distinction under test is the one a deferred constraint trigger exists to make:
 * a statement may violate the invariant and still be accepted, because what is refused
 * is the *commit* that leaves it violated.
 */
async function attemptCommit(
  work: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<Refusal> {
  try {
    await owner.begin(work);
    return { committed: true, code: null, message: "" };
  } catch (error) {
    return {
      committed: false,
      code: sqlState(error),
      message: messageOf(error),
    };
  }
}

/**
 * The stable identity of a refusal (T060: "decide whether project conventions require
 * an explicit custom ERRCODE").
 *
 * They do not, and the reason is in `apps/api/src/common/database/postgres-errors.ts`:
 * every trigger in this project raises a bare `P0001` and puts a *name* in the message,
 * which is what the API's `SQLSTATE.raised` branch matches on. So the assertion is the
 * SQLSTATE plus the `SPLIT_MISMATCH` prefix — never the interpolated sentence, which
 * carries the expense id and the two totals and is therefore not a stable identity.
 */
function expectSplitMismatch(refusal: Refusal): void {
  expect(refusal.committed).toBe(false);
  expect(refusal.code).toBe("P0001");
  expect(refusal.message).toMatch(/^SPLIT_MISMATCH\b/);
}

/** A statement the policies refuse: the SQLSTATE a row-level security refusal raises. */
async function refusalCode(
  run: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return sqlState(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The default category set
// ─────────────────────────────────────────────────────────────────────────────

describe("the seeded default categories", () => {
  let society: Society;

  beforeEach(async () => {
    await resetData(owner);
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
  });

  it("seeds exactly the nineteen PRD categories, in the document's order", async () => {
    const seeded = await owner<{ name: string; display_order: number }[]>`
      select name, display_order from public.expense_categories
       where society_id = ${society.societyId}::uuid
       order by display_order
    `;

    expect(seeded).toHaveLength(19);
    expect(seeded.map((row) => row.name)).toEqual([...DEFAULT_CATEGORIES]);
    // The order is the picker's order, and it is the PRD's list rather than an
    // alphabetical sort — so the numbers are asserted, not merely the set.
    expect(seeded.map((row) => row.display_order)).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 1),
    );
  });

  it("flags only Sinking Fund and Corpus Fund owner-only and capital", async () => {
    const flagged = await owner<
      { name: string; is_owner_only: boolean; is_capital: boolean }[]
    >`
      select name, is_owner_only, is_capital
        from public.expense_categories
       where society_id = ${society.societyId}::uuid
         and (is_owner_only or is_capital)
       order by name
    `;

    // PRD §2.2: "Charge categories flagged owner_only (sinking fund, capital
    // expenditure, corpus) are excluded from tenant splits", and §3.5.3 defines
    // `is_capital` as "excluded from operating-expense trend charts". Both flags land
    // on the same two funds; no other category is guessed into either.
    expect(flagged).toEqual([
      { name: "Corpus Fund", is_owner_only: true, is_capital: true },
      { name: "Sinking Fund", is_owner_only: true, is_capital: true },
    ]);

    const [counts] = await owner<
      { total: string; owner_only: string; capital: string }[]
    >`
      select count(*)::text as total,
             count(*) filter (where is_owner_only)::text as owner_only,
             count(*) filter (where is_capital)::text as capital
        from public.expense_categories
       where society_id = ${society.societyId}::uuid
    `;
    expect(counts).toEqual({ total: "19", owner_only: "2", capital: "2" });
  });

  it("seeds each society its own set, and refuses a duplicate live name", async () => {
    const second = await createSociety("Beta Court", "admin@beta.ses.test");

    const perSociety = await owner<{ count: string }[]>`
      select count(*)::text as count
        from public.expense_categories
       group by society_id
       order by society_id
    `;
    expect(perSociety.map((row) => row.count)).toEqual(["19", "19"]);

    const [shared] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expense_categories
       where society_id in (${society.societyId}::uuid, ${second.societyId}::uuid)
    `;
    expect(shared!.count).toBe("38");

    // The guard the seed's `ON CONFLICT DO NOTHING` expresses, from the other side: a
    // second `Maintenance` in one society is refused by the live-name index.
    const duplicate = await refusalCode(
      () => owner`
        insert into public.expense_categories (society_id, name, display_order)
        values (${society.societyId}::uuid, 'Maintenance', 99)
      `,
    );
    expect(duplicate).toBe("23505");

    // …and the same name *is* accepted once the first is soft-deleted, because the
    // uniqueness is a partial index on live rows (SAD §8.1's soft-delete convention).
    await owner`
      update public.expense_categories set deleted_at = now()
       where society_id = ${society.societyId}::uuid and name = 'Maintenance'
    `;
    await owner`
      insert into public.expense_categories (society_id, name, display_order)
      values (${society.societyId}::uuid, 'Maintenance', 99)
    `;
    const [live] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expense_categories
       where society_id = ${society.societyId}::uuid
         and name = 'Maintenance' and deleted_at is null
    `;
    expect(live!.count).toBe("1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("chk_split_total", () => {
  let society: Society;
  let expenseId: string;

  beforeEach(async () => {
    await resetData(owner);
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
    expenseId = await insertPublished(society, society.adminMemberId);
  });

  it("commits an exactly-balancing published expense and persists it exactly", async () => {
    expect(await storedTotal(expenseId)).toBe(AMOUNT);
    expect(await storedSplits(expenseId)).toEqual([2_500n, 3_500n, 4_000n]);

    const [expense] = await owner<{ amount_paise: string; status: string }[]>`
      select amount_paise::text, status from public.expenses where id = ${expenseId}::uuid
    `;
    expect(expense).toEqual({ amount_paise: "10000", status: "published" });
  });

  it("refuses a one-paisa shortfall at COMMIT", async () => {
    const refusal = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 2499
         where expense_id = ${expenseId}::uuid and amount_paise = 2500
      `;
    });

    expectSplitMismatch(refusal);
    // The refusal rolled the change back with it: nothing about the bill moved.
    expect(await storedTotal(expenseId)).toBe(AMOUNT);
  });

  it("refuses a one-paisa over-allocation at COMMIT", async () => {
    const refusal = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 2501
         where expense_id = ${expenseId}::uuid and amount_paise = 2500
      `;
    });

    expectSplitMismatch(refusal);
    expect(await storedTotal(expenseId)).toBe(AMOUNT);
  });

  it("refuses a larger mismatch in both directions, not merely one paisa", async () => {
    const under = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 1000
         where expense_id = ${expenseId}::uuid and amount_paise = 4000
      `;
    });
    const over = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 40000
         where expense_id = ${expenseId}::uuid and amount_paise = 4000
      `;
    });

    expectSplitMismatch(under);
    expectSplitMismatch(over);
    expect(await storedTotal(expenseId)).toBe(AMOUNT);
  });

  it("refuses a published expense with no splits at all", async () => {
    // An empty set sums to 0, and `COALESCE(SUM(…), 0)` is what makes that a refusal
    // rather than a NULL that compares as unknown and passes.
    const refusal = await attemptCommit(async (tx) => {
      await tx`
        delete from public.expense_splits where expense_id = ${expenseId}::uuid
      `;
    });

    expectSplitMismatch(refusal);
    expect(await storedSplits(expenseId)).toHaveLength(3);
  });

  it("judges the final state of a multi-row transaction, not its first row", async () => {
    // Deferred semantics, proven from both sides in one transaction: the total is
    // *wrong* after the first split and the transaction still commits, because what
    // the constraint reads is the state at COMMIT.
    const draftId = await insertDraft(society, society.adminMemberId);

    const observations = await owner.begin(async (tx) => {
      await tx`
        update public.expenses
           set status = 'published', published_at = now()
         where id = ${draftId}::uuid
      `;
      const totals: bigint[] = [];
      let index = 0;
      for (const amount of [4_000n, 3_500n, 2_500n]) {
        await tx`
          insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
          values (${society.societyId}::uuid, ${draftId}::uuid,
                  ${society.apartmentIds[index]!}::uuid, ${amount.toString()}::bigint)
        `;
        const [row] = await tx<{ total: string }[]>`
          select coalesce(sum(amount_paise), 0)::text as total
            from public.expense_splits where expense_id = ${draftId}::uuid
        `;
        totals.push(BigInt(row!.total));
        index += 1;
      }
      return totals;
    });

    // 4,000 (short) → 7,500 (short) → 10,000 (exact): the first two were violations
    // the transaction was allowed to hold, because the constraint is deferred and was
    // only ever asked about the end.
    expect(observations).toEqual([4_000n, 7_500n, 10_000n]);
    expect(await storedTotal(draftId)).toBe(AMOUNT);
  });

  it("refuses an update that breaks the total, and allows updates that restore it", async () => {
    const broken = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 3000
         where expense_id = ${expenseId}::uuid and amount_paise = 4000
      `;
    });
    expectSplitMismatch(broken);

    // Two edits in one transaction that land on an exact total: the first alone is
    // short, and that is legal until COMMIT.
    const repaired = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 3000
         where expense_id = ${expenseId}::uuid and amount_paise = 4000
      `;
      await tx`
        update public.expense_splits set amount_paise = 3500
         where expense_id = ${expenseId}::uuid and amount_paise = 2500
      `;
    });
    expect(repaired.committed).toBe(true);
    expect(await storedTotal(expenseId)).toBe(AMOUNT);
  });

  it("refuses deleting a split — the OLD-row correction", async () => {
    // This is the case the SAD's own sketch misses: a DELETE has no NEW row, so a check
    // written against `NEW.expense_id` reads NULL, finds no expense and returns without
    // complaint. The correction resolves the expense as
    // `COALESCE(NEW.expense_id, OLD.expense_id)`, and this test is what proves the
    // deletion arm is live rather than decorative.
    const refusal = await attemptCommit(async (tx) => {
      await tx`
        delete from public.expense_splits
         where expense_id = ${expenseId}::uuid and amount_paise = 2500
      `;
    });

    expectSplitMismatch(refusal);
    expect(await storedSplits(expenseId)).toEqual([2_500n, 3_500n, 4_000n]);

    // Deleting the whole set and putting an exact one back is a legitimate edit
    // (recalculation replaces the bill), so the arm is not a blanket refusal.
    const recalculated = await attemptCommit(async (tx) => {
      await tx`delete from public.expense_splits where expense_id = ${expenseId}::uuid`;
      await tx`
        insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
        values (${society.societyId}::uuid, ${expenseId}::uuid,
                ${society.apartmentIds[0]}::uuid, 10_000::bigint)
      `;
    });
    expect(recalculated.committed).toBe(true);
    expect(await storedTotal(expenseId)).toBe(AMOUNT);
  });

  it("refuses a lone change to the expense amount — the parent-side trigger", async () => {
    // Nothing on `expense_splits` is touched here, which is exactly why a trigger on
    // the splits alone would let this through: the expected side of the equation moved.
    const refusal = await attemptCommit(async (tx) => {
      await tx`
        update public.expenses set amount_paise = 12_000 where id = ${expenseId}::uuid
      `;
    });

    expectSplitMismatch(refusal);
    const [row] = await owner<{ amount_paise: string }[]>`
      select amount_paise::text from public.expenses where id = ${expenseId}::uuid
    `;
    expect(row!.amount_paise).toBe("10000");
  });

  it("allows a new amount when the splits move with it in the same transaction", async () => {
    const committed = await attemptCommit(async (tx) => {
      await tx`
        update public.expenses set amount_paise = 12_000 where id = ${expenseId}::uuid
      `;
      await tx`
        update public.expense_splits set amount_paise = 4500
         where expense_id = ${expenseId}::uuid and amount_paise = 2500
      `;
    });

    expect(committed.committed).toBe(true);
    // 4,000 + 3,500 + 4,500 = 12,000.
    expect(await storedTotal(expenseId)).toBe(12_000n);
  });

  it("refuses publishing a draft whose splits do not balance", async () => {
    const draftId = await insertDraft(society, society.adminMemberId);
    await owner`
      insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
      values (${society.societyId}::uuid, ${draftId}::uuid,
              ${society.apartmentIds[0]}::uuid, 9999::bigint)
    `;

    const refusal = await attemptCommit(async (tx) => {
      await tx`
        update public.expenses set status = 'published', published_at = now()
         where id = ${draftId}::uuid
      `;
    });

    expectSplitMismatch(refusal);
    const [row] = await owner<{ status: string }[]>`
      select status from public.expenses where id = ${draftId}::uuid
    `;
    expect(row!.status).toBe("draft");
  });

  it("publishes a draft whose splits balance exactly", async () => {
    const draftId = await insertDraft(society, society.adminMemberId);
    const committed = await attemptCommit(async (tx) => {
      await tx`
        insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
        values (${society.societyId}::uuid, ${draftId}::uuid,
                ${society.apartmentIds[0]}::uuid, 10_000::bigint)
      `;
      await tx`
        update public.expenses set status = 'published', published_at = now()
         where id = ${draftId}::uuid
      `;
    });

    expect(committed.committed).toBe(true);
    const [row] = await owner<
      { status: string; published_at: string | null }[]
    >`
      select status, published_at::text from public.expenses where id = ${draftId}::uuid
    `;
    expect(row!.status).toBe("published");
    expect(row!.published_at).not.toBeNull();
  });

  it("leaves drafts and voided expenses unconstrained", async () => {
    // A one-paisa draft with no splits at all: not a bill, so nothing to balance.
    const tiny = await insertDraft(society, society.adminMemberId, 1n);

    const committed = await attemptCommit(async (tx) => {
      // Voiding a published expense must not require rewriting its splits: the
      // obligation ends when the status does. The lifecycle stamps are required by
      // `chk_expenses_void_complete` (migration #30), which is orthogonal to the split
      // total this describe block is about — the point here is only that no split row
      // has to move.
      await tx`
        update public.expenses
           set status = 'void', void_reason = 'Duplicate of last month''s bill',
               voided_at = now(), voided_by = ${society.adminMemberId}::uuid
         where id = ${expenseId}::uuid
      `;
    });

    expect(committed.committed).toBe(true);
    expect(await storedTotal(tiny)).toBe(0n);
    const [voided] = await owner<{ status: string }[]>`
      select status from public.expenses where id = ${expenseId}::uuid
    `;
    expect(voided!.status).toBe("void");
  });

  it("scopes the sum to one expense, never to the society", async () => {
    // Two published expenses of the same amount. The sibling is left alone, and a
    // total that leaked across `expense_id` would refuse (or accept) the wrong write.
    const other = await insertPublished(society, society.adminMemberId);

    const refusal = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 6000
         where expense_id = ${other}::uuid and amount_paise = 4000
      `;
    });
    expectSplitMismatch(refusal);
    expect(await storedTotal(other)).toBe(AMOUNT);
    expect(await storedTotal(expenseId)).toBe(AMOUNT);

    // And moving 2,500 paise from one expense to the other leaves the *combined* total
    // right while each expense is wrong: refused, because each is judged alone.
    const moved = await attemptCommit(async (tx) => {
      await tx`
        update public.expense_splits set amount_paise = 0
         where expense_id = ${other}::uuid and amount_paise = 2500
      `;
      await tx`
        update public.expense_splits set amount_paise = 5000
         where expense_id = ${expenseId}::uuid and amount_paise = 2500
      `;
    });
    expectSplitMismatch(moved);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The M12 escaped-defect proof
// ─────────────────────────────────────────────────────────────────────────────

describe("the database as the last line of defence (M12)", () => {
  let society: Society;

  beforeEach(async () => {
    await resetData(owner);
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
  });

  /** The malformed allocations a one-paisa rounding defect would produce. */
  const MALFORMED = [4_000n, 3_500n, 2_499n] as const;

  it("refuses the allocation a one-paisa rounding defect would produce", async () => {
    // T059 proved the property suite catches a `distribute` off-by-one in the split
    // engine. M12 asks for the second half: that the *same class* of escaped defect —
    // an allocation set one paisa short of the amount — cannot reach a published state
    // even when the engine is bypassed entirely, because the write arrives over a
    // connection that never ran the engine.
    //
    // Nothing here imports `@ses/split-engine`: the "bug" is simulated at the only
    // boundary that matters, as an INSERT of the numbers a buggy distributor would have
    // produced (4,000 / 3,500 / 2,499 — the engine's own example total, minus one).
    const refusal = await attemptCommit(async (tx) => {
      const [expense] = await tx<{ id: string }[]>`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, published_at, created_by
        )
        values (
          ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Lift repair',
          10_000::bigint, current_date, 'equal', 'published', now(),
          ${society.adminMemberId}::uuid
        )
        returning id
      `;
      let index = 0;
      for (const amount of MALFORMED) {
        await tx`
          insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
          values (${society.societyId}::uuid, ${expense!.id}::uuid,
                  ${society.apartmentIds[index]!}::uuid, ${amount.toString()}::bigint)
        `;
        index += 1;
      }
    });

    expectSplitMismatch(refusal);

    // Nothing was left behind: the refusal took the expense row with it.
    const [count] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expenses
       where society_id = ${society.societyId}::uuid
    `;
    expect(count!.count).toBe("0");
  });

  it("would have persisted that state without the triggers — the counterfactual", async () => {
    // The load-bearing claim: the same malformed state, written with the two constraint
    // triggers dropped, is *accepted*. Both triggers are dropped inside one transaction
    // that is rolled back at the end, so "this database can do that" is a property of
    // this test and not a change to the committed schema — and it runs on the disposable
    // container only, never against a shared database.
    // The transaction is rolled back on purpose: `owner.begin` commits when its callback
    // resolves, so proving "this state is accepted" and *discarding* it means throwing a
    // sentinel at the end and catching it here. Nothing malformed is left behind, and the
    // triggers are restored by the rollback rather than by a second DDL statement that
    // could itself fail.
    const rollback = new Error("counterfactual: roll the malformed state back");
    let outcome: { total: bigint; id: string } | null = null;
    await expect(
      owner.begin(async (tx) => {
        await tx`drop trigger trg_split_total_write on public.expense_splits`;
        await tx`drop trigger trg_expense_split_total_write on public.expenses`;

        const [expense] = await tx<{ id: string }[]>`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, published_at, created_by
        )
        values (
          ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Lift repair',
          10_000::bigint, current_date, 'equal', 'published', now(),
          ${society.adminMemberId}::uuid
        )
        returning id
      `;
        let index = 0;
        for (const amount of MALFORMED) {
          await tx`
          insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
          values (${society.societyId}::uuid, ${expense!.id}::uuid,
                  ${society.apartmentIds[index]!}::uuid, ${amount.toString()}::bigint)
        `;
          index += 1;
        }
        const [row] = await tx<{ total: string }[]>`
          select coalesce(sum(amount_paise), 0)::text as total
            from public.expense_splits where expense_id = ${expense!.id}::uuid
        `;
        outcome = { total: BigInt(row!.total), id: expense!.id };
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    // The unbalanced published expense was accepted, because nothing was watching.
    expect(outcome!.total).toBe(9_999n);

    // Rolled back: the malformed state is gone…
    const [after] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expenses where id = ${outcome!.id}::uuid
    `;
    expect(after!.count).toBe("0");

    // …and the protection is back, which the same write now fails.
    const refused = await attemptCommit(async (tx) => {
      const [expense] = await tx<{ id: string }[]>`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, published_at, created_by
        )
        values (
          ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Lift repair',
          10_000::bigint, current_date, 'equal', 'published', now(),
          ${society.adminMemberId}::uuid
        )
        returning id
      `;
      await tx`
        insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
        values (${society.societyId}::uuid, ${expense!.id}::uuid,
                ${society.apartmentIds[0]}::uuid, 9_999::bigint)
      `;
    });
    expectSplitMismatch(refused);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Competing writers (SAD §8.6's third correction)
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent split writers", () => {
  let society: Society;
  let expenseId: string;

  beforeEach(async () => {
    await resetData(owner);
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
    expenseId = await insertPublished(society, society.adminMemberId);
  });

  it("makes a second writer wait for the expense row", async () => {
    // The mechanism, asserted deterministically rather than inferred from an outcome: a
    // transaction that holds the expense row cannot be overtaken, because every writer's
    // deferred check must take that row's lock before it reads the splits.
    const blocker = ownerClient(ownerUrl());
    const writer = ownerClient(ownerUrl());
    let pending!: Promise<void>;
    let outcome = "";

    try {
      await blocker.begin(async (tx) => {
        await tx`
          select id from public.expenses where id = ${expenseId}::uuid for update
        `;
        // Two edits that leave the total exactly balanced, so the only reason this
        // writer can be slow is the lock. Both address one flat, so there is no
        // question of an update matching a row its sibling changed.
        pending = writer.begin(async (tx) => {
          await tx`
            update public.expense_splits set amount_paise = 4500
             where expense_id = ${expenseId}::uuid and apartment_id = ${society.apartmentIds[0]}::uuid
          `;
          await tx`
            update public.expense_splits set amount_paise = 2000
             where expense_id = ${expenseId}::uuid and apartment_id = ${society.apartmentIds[2]}::uuid
          `;
        });
        outcome = await Promise.race([
          pending.then(
            () => "committed",
            () => "refused",
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("blocked"), 300),
          ),
        ]);
      });

      // The blocker has committed, releasing the lock: the writer now finishes, and its
      // edits were exact, so it commits rather than being refused.
      expect(outcome).toBe("blocked");
      await expect(pending).resolves.toBeUndefined();
      expect(await storedTotal(expenseId)).toBe(AMOUNT);
    } finally {
      await writer.end({ timeout: 5 });
      await blocker.end({ timeout: 5 });
    }
  });

  it("cannot leave a published expense unbalanced under a real race", async () => {
    // Write skew, the failure the SAD's sketch cannot see: two transactions, each
    // editing a *different* pair of splits, each locally balanced and valid against the
    // state it can see. Under READ COMMITTED with no serialisation they both commit and
    // the merged state is short. With the parent-row lock in the deferred check, the
    // second validator necessarily sees the first writer's committed rows and refuses.
    const first = ownerClient(ownerUrl());
    const second = ownerClient(ownerUrl());

    try {
      // Each writer edits two flats, one of them shared (A-201), and each writer's
      // own view of the bill balances: A's is 3,000 + 3,500 + 3,500 and B's is
      // 4,000 + 4,500 + 1,500. Only the *merged* state is short, which is exactly what
      // makes this write skew rather than a mistake either writer could have caught.
      const race = await Promise.allSettled([
        first.begin(async (tx) => {
          await tx`
            update public.expense_splits set amount_paise = 3000
             where expense_id = ${expenseId}::uuid and apartment_id = ${society.apartmentIds[0]}::uuid
          `;
          await tx`
            update public.expense_splits set amount_paise = 3500
             where expense_id = ${expenseId}::uuid and apartment_id = ${society.apartmentIds[2]}::uuid
          `;
        }),
        second.begin(async (tx) => {
          await tx`
            update public.expense_splits set amount_paise = 4500
             where expense_id = ${expenseId}::uuid and apartment_id = ${society.apartmentIds[1]}::uuid
          `;
          await tx`
            update public.expense_splits set amount_paise = 1500
             where expense_id = ${expenseId}::uuid and apartment_id = ${society.apartmentIds[2]}::uuid
          `;
        }),
      ]);

      const refused = race.filter((result) => result.status === "rejected");
      // At least one loses — that is the serialisation doing its job rather than a
      // coincidence of scheduling.
      expect(refused.length).toBeGreaterThanOrEqual(1);
      for (const result of refused) {
        expect(sqlState((result as PromiseRejectedResult).reason)).toBe(
          "P0001",
        );
      }

      // And whatever interleaving happened, the committed bill still balances.
      expect(await storedTotal(expenseId)).toBe(AMOUNT);
    } finally {
      await first.end({ timeout: 5 });
      await second.end({ timeout: 5 });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rest of the schema
// ─────────────────────────────────────────────────────────────────────────────

describe("the expense schema's own constraints", () => {
  let society: Society;

  beforeEach(async () => {
    await resetData(owner);
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
  });

  it("refuses a zero or negative expense amount", async () => {
    for (const amount of [0n, -1n]) {
      const code = await refusalCode(() =>
        insertDraft(society, society.adminMemberId, amount),
      );
      expect(code).toBe("23514");
    }
  });

  it("refuses a negative split but allows an exempt zero", async () => {
    const expenseId = await insertDraft(society, society.adminMemberId);

    const negative = await refusalCode(
      () => owner`
        insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
        values (${society.societyId}::uuid, ${expenseId}::uuid,
                ${society.apartmentIds[0]}::uuid, -1)
      `,
    );
    expect(negative).toBe("23514");

    // A floor-band exemption is a deliberate ₹0 allocation, not an omission.
    await owner`
      insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
      values (${society.societyId}::uuid, ${expenseId}::uuid,
              ${society.apartmentIds[0]}::uuid, 0)
    `;
    expect(await storedTotal(expenseId)).toBe(0n);
  });

  it("refuses a split that names no participant, and one participant twice", async () => {
    const expenseId = await insertDraft(society, society.adminMemberId);

    const nameless = await refusalCode(
      () => owner`
        insert into public.expense_splits (society_id, expense_id, amount_paise)
        values (${society.societyId}::uuid, ${expenseId}::uuid, 100)
      `,
    );
    expect(nameless).toBe("23514");

    // The same flat twice for one expense: refused because the unique key is NULLS NOT
    // DISTINCT. With the PRD's plain UNIQUE, `member_id` being NULL would make the two
    // rows "different" and the duplicate charge would be accepted.
    await owner`
      insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
      values (${society.societyId}::uuid, ${expenseId}::uuid,
              ${society.apartmentIds[0]}::uuid, 100)
    `;
    const duplicate = await refusalCode(
      () => owner`
        insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
        values (${society.societyId}::uuid, ${expenseId}::uuid,
                ${society.apartmentIds[0]}::uuid, 200)
      `,
    );
    expect(duplicate).toBe("23505");
  });

  it("refuses a published expense with no published_at, and a void one with no reason", async () => {
    const noStamp = await refusalCode(
      () => owner`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, created_by
        )
        values (
          ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Lift repair',
          10_000::bigint, current_date, 'equal', 'published', ${society.adminMemberId}::uuid
        )
      `,
    );
    expect(noStamp).toBe("23514");

    const draftId = await insertDraft(society, society.adminMemberId);
    const noReason = await refusalCode(
      () =>
        owner`update public.expenses set status = 'void' where id = ${draftId}::uuid`,
    );
    expect(noReason).toBe("23514");
  });

  it("keeps dues inside their amount and their kind inside the vocabulary", async () => {
    const [due] = await owner<{ id: string }[]>`
      insert into public.dues (society_id, member_id, apartment_id, amount_paise, due_date)
      values (${society.societyId}::uuid, ${society.adminMemberId}::uuid,
              ${society.apartmentIds[0]}::uuid, 1_000::bigint, current_date)
      returning id
    `;

    const overpaid = await refusalCode(
      () =>
        owner`update public.dues set paid_paise = 1001 where id = ${due!.id}::uuid`,
    );
    const negative = await refusalCode(
      () =>
        owner`update public.dues set paid_paise = -1 where id = ${due!.id}::uuid`,
    );
    const kind = await refusalCode(
      () =>
        owner`update public.dues set kind = 'discount' where id = ${due!.id}::uuid`,
    );
    expect([overpaid, negative, kind]).toEqual(["23514", "23514", "23514"]);

    // A *negative* adjustment is refused too, and that is a finding rather than a
    // coincidence: SAD §8.5's constraint is `paid_paise BETWEEN 0 AND amount_paise`, so
    // an `amount_paise` below zero can satisfy it only if `paid_paise` is negative,
    // which the same constraint forbids. The PRD's `adjustment` kind and its void flow
    // ("payments already made against it convert to an advance credit") therefore cannot
    // settle a credit as a negative due row. T060 implements the documented constraint
    // verbatim and records the tension for the payments task (T067/T068) to resolve —
    // a signed `member_balances.advance_paise`, an amended check, or a credit row of its
    // own — rather than inventing an exception here.
    const credit = await refusalCode(
      () => owner`
        insert into public.dues (society_id, member_id, apartment_id, kind, amount_paise, due_date)
        values (${society.societyId}::uuid, ${society.adminMemberId}::uuid,
                ${society.apartmentIds[0]}::uuid, 'adjustment', -500::bigint, current_date)
      `,
    );
    expect(credit).toBe("23514");
  });

  it("refuses a GST row that is both intra-state and inter-state", async () => {
    const expenseId = await insertPublished(society, society.adminMemberId);

    const both = await refusalCode(
      () => owner`
        insert into public.expense_gst_details (
          expense_id, society_id, taxable_value_paise, cgst_paise, igst_paise
        )
        values (${expenseId}::uuid, ${society.societyId}::uuid, 10000, 900, 1800)
      `,
    );
    expect(both).toBe("23514");

    await owner`
      insert into public.expense_gst_details (
        expense_id, society_id, taxable_value_paise, cgst_paise, sgst_paise
      )
      values (${expenseId}::uuid, ${society.societyId}::uuid, 10000, 900, 900)
    `;
    const [gst] = await owner<{ taxable_value_paise: string }[]>`
      select taxable_value_paise::text from public.expense_gst_details
       where expense_id = ${expenseId}::uuid
    `;
    expect(gst!.taxable_value_paise).toBe("10000");
  });

  it("refuses a row that borrows another society's member, expense or category", async () => {
    const other = await createSociety("Beta Court", "admin@beta.ses.test");
    const foreignExpense = await insertPublished(other, other.adminMemberId);
    const [foreignMember] = await owner<{ id: string }[]>`
      select id from public.members where society_id = ${other.societyId}::uuid limit 1
    `;

    // An expense whose `created_by` is another society's member: the composite key
    // `(created_by, society_id)` refuses it. The id alone would have been perfectly
    // valid — which is the whole point of the composite.
    const createdBy = await refusalCode(
      () => owner`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, created_by
        )
        values (
          ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Lift repair',
          10_000::bigint, current_date, 'equal', 'draft', ${foreignMember!.id}::uuid
        )
      `,
    );
    expect(createdBy).toBe("23503");

    // A split pointing at another society's expense.
    const crossExpense = await refusalCode(
      () => owner`
        insert into public.expense_splits (society_id, expense_id, apartment_id, amount_paise)
        values (${society.societyId}::uuid, ${foreignExpense}::uuid,
                ${society.apartmentIds[0]}::uuid, 100)
      `,
    );
    expect(crossExpense).toBe("23503");

    // A category from another society on an expense in this one.
    const crossCategory = await refusalCode(
      () => owner`
        insert into public.expenses (
          society_id, category_id, title, amount_paise, expense_date,
          split_strategy, status, created_by
        )
        values (
          ${society.societyId}::uuid, ${other.categoryId}::uuid, 'Lift repair',
          10_000::bigint, current_date, 'equal', 'draft', ${society.adminMemberId}::uuid
        )
      `,
    );
    expect(crossCategory).toBe("23503");
  });

  it("has the full-text index and lets the planner use it", async () => {
    await owner`
      insert into public.expenses (
        society_id, category_id, title, description, vendor_name,
        amount_paise, expense_date, split_strategy, status, created_by
      )
      values (
        ${society.societyId}::uuid, ${society.categoryId}::uuid, 'Water tanker',
        'Emergency supply for Block A', 'Sharma Water',
        10_000::bigint, current_date, 'equal', 'draft', ${society.adminMemberId}::uuid
      )
    `;

    // The index exists as an expression index, not a plain column index — the only
    // shape a `tsvector` over three columns can have.
    const [index] = await owner<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = 'public'
         and tablename = 'expenses'
         and indexname = 'idx_expenses_search'
    `;
    expect(index?.indexdef).toContain("USING gin");
    expect(index?.indexdef).toContain("to_tsvector");

    // And the planner will use it. `enable_seqscan = off` makes the choice observable on
    // a table of one row: the claim is that the index *can* answer this query, not that
    // a handful of rows makes it the cheaper plan.
    const plan = await owner.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const lines = await tx<Record<string, string>[]>`
        explain (format text)
        select id from public.expenses
         where to_tsvector(
                 'english',
                 title || ' ' || coalesce(description, '') || ' ' || coalesce(vendor_name, '')
               ) @@ to_tsquery('english', 'water')
      `;
      return lines.map((line) => line["QUERY PLAN"] ?? "").join("\n");
    });

    expect(plan).toContain("idx_expenses_search");
  });

  it("grants no client role the statements the design withholds", async () => {
    // Grants are half of every policy decision, so they are asserted directly rather
    // than inferred from behaviour: a later migration that widened them silently would
    // fail here.
    const [privileges] = await owner<
      {
        dues_update: boolean;
        dues_delete: boolean;
        dues_insert: boolean;
        expenses_delete: boolean;
        revisions_update: boolean;
        revisions_delete: boolean;
        categories_delete: boolean;
      }[]
    >`
      select
        has_table_privilege('authenticated', 'public.dues', 'UPDATE') as dues_update,
        has_table_privilege('authenticated', 'public.dues', 'DELETE') as dues_delete,
        has_table_privilege('authenticated', 'public.dues', 'INSERT') as dues_insert,
        has_table_privilege('authenticated', 'public.expenses', 'DELETE') as expenses_delete,
        has_table_privilege('authenticated', 'public.expense_revisions', 'UPDATE') as revisions_update,
        has_table_privilege('authenticated', 'public.expense_revisions', 'DELETE') as revisions_delete,
        has_table_privilege('authenticated', 'public.expense_categories', 'DELETE') as categories_delete
    `;

    expect(privileges).toEqual({
      dues_update: false,
      dues_delete: false,
      dues_insert: false,
      expenses_delete: false,
      revisions_update: false,
      revisions_delete: false,
      categories_delete: false,
    });

    // The runtime roles have no reach at all, and the internal check function is not
    // callable by a client — it reads an expense regardless of RLS, so a grant would
    // make it a cross-society oracle.
    const [scoped] = await owner<
      { anon_select: boolean; assert_callable: boolean }[]
    >`
      select
        has_table_privilege('anon', 'public.expenses', 'SELECT') as anon_select,
        has_function_privilege(
          'authenticated', 'public.assert_split_total(uuid)', 'EXECUTE'
        ) as assert_callable
    `;
    expect(scoped).toEqual({ anon_select: false, assert_callable: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenancy (SAD §8.7)
// ─────────────────────────────────────────────────────────────────────────────

describe("the expense tables under an identity", () => {
  let society: Society;
  let other: Society;
  let resident: { memberId: string; userId: string };
  let guest: { memberId: string; userId: string };
  let committee: { memberId: string; userId: string };
  let otherResidentUserId: string;
  let publishedId: string;

  beforeEach(async () => {
    await resetData(owner);
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
    other = await createSociety("Beta Court", "admin@beta.ses.test");
    resident = await addMember(
      society,
      "resident@expenses.ses.test",
      "resident",
    );
    guest = await addMember(society, "guard@expenses.ses.test", "guest");
    committee = await addMember(
      society,
      "committee@expenses.ses.test",
      "committee",
    );
    otherResidentUserId = (
      await addMember(other, "resident@beta.ses.test", "resident")
    ).userId;
    publishedId = await insertPublished(society, society.adminMemberId);
  });

  it("shows a member their own society's expenses and nothing else", async () => {
    const visible = await unitOfWork.transaction(
      { kind: "user", userId: resident.userId },
      (tx) => rows<{ id: string }>(tx, sql`select id from public.expenses`),
    );
    expect(visible.map((row) => row.id)).toEqual([publishedId]);

    // The other society's resident sees none of Alpha's — the fixture exists and is
    // simply not returned.
    const stranger = await unitOfWork.transaction(
      { kind: "user", userId: otherResidentUserId },
      (tx) => rows<{ id: string }>(tx, sql`select id from public.expenses`),
    );
    expect(stranger).toEqual([]);
  });

  it("shows a guest no financial row at all", async () => {
    // PRD §2.2: a security guard has "No financial visibility whatsoever" — not
    // expenses, not splits, not categories, not dues.
    const seen = await unitOfWork.transaction(
      { kind: "user", userId: guest.userId },
      async (tx) => ({
        expenses: await rows(tx, sql`select id from public.expenses`),
        splits: await rows(tx, sql`select id from public.expense_splits`),
        categories: await rows(
          tx,
          sql`select id from public.expense_categories`,
        ),
        dues: await rows(tx, sql`select id from public.dues`),
      }),
    );

    expect(seen).toEqual({
      expenses: [],
      splits: [],
      categories: [],
      dues: [],
    });
  });

  it("lets a committee member draft but not publish, and an admin do both", async () => {
    // `expense.create` is Admin/Treasurer full and Committee scoped to drafts. The
    // policy cannot see who is writing except through the role and the row's status, so
    // the draft IS the whole difference.
    const draftId = await unitOfWork.transaction(
      { kind: "user", userId: committee.userId },
      async (tx) => {
        const inserted = await rows<{ id: string }>(
          tx,
          sql`insert into public.expenses
                (society_id, category_id, title, amount_paise, expense_date,
                 split_strategy, status, created_by)
              values (${society.societyId}::uuid, ${society.categoryId}::uuid,
                      'Plumber', 5000::bigint, current_date, 'equal', 'draft',
                      ${committee.memberId}::uuid)
              returning id`,
        );
        return inserted[0]!.id;
      },
    );
    expect(draftId).toEqual(expect.any(String));

    // Creating a *published* row is refused by the policy's WITH CHECK (an INSERT
    // refusal raises rather than matching zero rows), and so is promoting the draft.
    const publishAttempt = await refusalCode(() =>
      unitOfWork.transaction({ kind: "user", userId: committee.userId }, (tx) =>
        rows(
          tx,
          sql`insert into public.expenses
                (society_id, category_id, title, amount_paise, expense_date,
                 split_strategy, status, published_at, created_by)
              values (${society.societyId}::uuid, ${society.categoryId}::uuid,
                      'Plumber', 5000::bigint, current_date, 'equal', 'published',
                      now(), ${committee.memberId}::uuid)
              returning id`,
        ),
      ),
    );
    expect(publishAttempt).toBe("42501");

    // An UPDATE is refused differently from an INSERT: the USING clause decides which
    // rows the writer may address at all (the committee member's own draft passes), and
    // the WITH CHECK then judges the row being written — so this one raises rather than
    // matching zero rows, which is the louder and therefore better outcome.
    const promoteAttempt = await refusalCode(() =>
      unitOfWork.transaction({ kind: "user", userId: committee.userId }, (tx) =>
        rows(
          tx,
          sql`update public.expenses
                 set status = 'published', published_at = now()
               where id = ${draftId}::uuid
               returning id`,
        ),
      ),
    );
    expect(promoteAttempt).toBe("42501");

    // An Admin is permitted the write a committee member is not — and a client-side
    // *publish* is still refused, by the column grants rather than by a policy: the
    // lifecycle stamps (`published_at`, `voided_at`, `approved_at`) are deliberately not
    // writable, so "this expense became billable at time T" is not a field a client can
    // send. The transition belongs to T066's publish path, which — like
    // `society_update()` and the other privileged writes in this project — has to be a
    // SECURITY DEFINER function rather than a naked UPDATE. This test asserts today's
    // boundary so that a future migration which grants `published_at` has to move it
    // deliberately.
    const adminPublishNoSplits = await refusalCode(() =>
      unitOfWork.transaction(
        { kind: "user", userId: society.adminUserId },
        (tx) =>
          rows(
            tx,
            sql`insert into public.expenses
                (society_id, category_id, title, amount_paise, expense_date,
                 split_strategy, status, published_at, created_by)
              values (${society.societyId}::uuid, ${society.categoryId}::uuid,                      'Security', 10000::bigint, current_date, 'equal', 'published',
                      now(), ${society.adminMemberId}::uuid)
              returning id`,
          ),
      ),
    );
    expect(adminPublishNoSplits).toBe("42501");

    // A draft is what an Admin's write looks like, and it succeeds.
    const draftByAdmin = await unitOfWork.transaction(
      { kind: "user", userId: society.adminUserId },
      (tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into public.expenses
                (society_id, category_id, title, amount_paise, expense_date,
                 split_strategy, status, created_by)
              values (${society.societyId}::uuid, ${society.categoryId}::uuid,
                      'Security', 10000::bigint, current_date, 'equal', 'draft',
                      ${society.adminMemberId}::uuid)
              returning id`,
        ),
    );
    expect(draftByAdmin).toHaveLength(1);

    // The same Admin CAN write a split onto the committee member's draft — the
    // draft-scoped write policy admits them — while the status change that would turn it
    // into a bill still needs the publish path.
    const splitOnDraft = await unitOfWork.transaction(
      { kind: "user", userId: society.adminUserId },
      (tx) =>
        rows<{ id: string }>(
          tx,
          sql`insert into public.expense_splits
                (society_id, expense_id, apartment_id, amount_paise)
              values (${society.societyId}::uuid, ${draftId}::uuid,
                      ${society.apartmentIds[0]}::uuid, 5000::bigint)
              returning id`,
        ),
    );
    expect(splitOnDraft).toHaveLength(1);

    // Left as a draft with a balancing split, the owner connection can publish it —
    // which is the shape T066's definer function will have.
    await owner`
      update public.expenses set status = 'published', published_at = now()
       where id = ${draftId}::uuid
    `;

    // A resident writes nothing.
    const residentAttempt = await refusalCode(() =>
      unitOfWork.transaction({ kind: "user", userId: resident.userId }, (tx) =>
        rows(
          tx,
          sql`insert into public.expenses
                (society_id, category_id, title, amount_paise, expense_date,
                 split_strategy, status, created_by)
              values (${society.societyId}::uuid, ${society.categoryId}::uuid,
                      'Painting', 5000::bigint, current_date, 'equal', 'draft',
                      ${resident.memberId}::uuid)
              returning id`,
        ),
      ),
    );
    expect(residentAttempt).toBe("42501");
  });

  it("shows a resident their own dues and the manager everyone's", async () => {
    // PRD §2.2: a resident sees other residents' *aggregate* payment status, never the
    // individual rows — `defaulter_list_public` is off by default for dignity. So the
    // policy is own-row-or-manager, and this asserts both halves.
    await owner`
      insert into public.dues (society_id, member_id, apartment_id, amount_paise, due_date)
      values
        (${society.societyId}::uuid, ${resident.memberId}::uuid,
         ${society.apartmentIds[0]}::uuid, 1_000::bigint, current_date),
        (${society.societyId}::uuid, ${society.adminMemberId}::uuid,
         ${society.apartmentIds[1]}::uuid, 2_000::bigint, current_date)
    `;

    const own = await unitOfWork.transaction(
      { kind: "user", userId: resident.userId },
      (tx) =>
        rows<{ amount_paise: string }>(
          tx,
          sql`select amount_paise::text from public.dues`,
        ),
    );
    expect(own.map((row) => row.amount_paise)).toEqual(["1000"]);

    const admin = await unitOfWork.transaction(
      { kind: "user", userId: society.adminUserId },
      (tx) =>
        rows<{ amount_paise: string }>(
          tx,
          sql`select amount_paise::text from public.dues`,
        ),
    );
    expect([...admin.map((row) => row.amount_paise)].sort()).toEqual([
      "1000",
      "2000",
    ]);

    const guestSees = await unitOfWork.transaction(
      { kind: "user", userId: guest.userId },
      (tx) => rows(tx, sql`select id from public.dues`),
    );
    expect(guestSees).toEqual([]);
  });

  it("writes its own society's expense and matches no row in another's", async () => {
    // Positive control first: an Admin *can* edit their own society's expense, so the
    // refusal below is the tenancy boundary rather than a blanket read-only rule.
    await unitOfWork.transaction(
      { kind: "user", userId: society.adminUserId },
      (tx) =>
        rows(
          tx,
          sql`update public.expenses set title = 'Water tanker (edited)'
               where id = ${publishedId}::uuid`,
        ),
    );
    const [own] = await owner<{ title: string }[]>`
      select title from public.expenses where id = ${publishedId}::uuid
    `;
    expect(own!.title).toBe("Water tanker (edited)");

    // The same Admin against the other society's expense matches nothing, and the owner
    // read afterwards is what proves the row did not move.
    const foreignExpense = await insertPublished(other, other.adminMemberId);
    const attempt = await unitOfWork.transaction(
      { kind: "user", userId: society.adminUserId },
      (tx) =>
        rows(
          tx,
          sql`update public.expenses set title = 'Crossed' where id = ${foreignExpense}::uuid`,
        ),
    );
    expect(attempt).toEqual([]);

    const [untouched] = await owner<{ title: string }[]>`
      select title from public.expenses where id = ${foreignExpense}::uuid
    `;
    expect(untouched!.title).toBe("Water tanker");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reversibility (Roadmap T060: "`down` migration tested")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The migration's own `Down` block, read out of the file rather than copied into this
 * test, so the two cannot drift: a statement added to the block is executed here, and
 * one removed from it stops being executed.
 *
 * The runner is forward-only (ADR-0008 — a checksum ledger, a prefix-discipline rule
 * and no down command at all), and every migration in this history answers that with a
 * by-hand `Down` block in its header. `20260920130000_society_core.sql` and the other
 * seventeen each carry one. That is the convention this tests, and it is why the test
 * executes the block *inside a transaction that is rolled back*: the point is that the
 * statements are valid, complete and re-appliable, not that this suite mutates the
 * schema it shares with ten other spec files.
 */
function extractDownStatements(source: string): readonly string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes("Down (run by hand"));
  const statements: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    // The block ends at the first line that is not a comment.
    if (!line.startsWith("--")) break;
    const stripped = line.replace(/^--\s?/, "").trim();
    // Prose lines ("and restore the previous body of …") are not statements.
    if (stripped.endsWith(";")) statements.push(stripped);
  }
  return statements;
}

describe("the documented Down block", () => {
  const filename = "20261001120000_expense_schema.sql";
  let source: string;

  beforeAll(() => {
    source = readFileSync(join(resolveMigrationsDir(), filename), "utf8");
  });

  let society: Society;

  beforeEach(async () => {
    await resetData(owner);
    // A society created *before* the file is replayed. Its categories are what the
    // backfill assertion below proves: the seeding trigger fires on INSERT into
    // `societies`, and that insert already happened.
    society = await createSociety("Alpha Court", "admin@expenses.ses.test");
  });

  it("is present, executable, complete, and the file re-applies over it", async () => {
    const statements = extractDownStatements(source);

    // A block that named nothing would make the assertions below vacuous.
    expect(statements.length).toBeGreaterThanOrEqual(15);
    expect(
      statements.some((line) =>
        line.startsWith("DROP TABLE IF EXISTS public.dues"),
      ),
    ).toBe(true);
    expect(
      statements.some((line) =>
        line.includes("DROP TYPE IF EXISTS public.expense_status"),
      ),
    ).toBe(true);

    await owner.begin(async (tx) => {
      // Later migrations' objects that hold a reference to an anchor this block drops
      // have to come off first, because Postgres refuses `DROP FUNCTION
      // can_view_expenses(uuid)` with `2BP01` while any policy or function still calls
      // it. They are not dropped by `DROP TABLE` the way #19's own policies are —
      // `attachments` is a table #19 has never heard of — so they are named here, and
      // the later-file loop below puts every one of them back. This is the same
      // mechanism, for the same reason, as the note further down about T067's index and
      // trigger on `dues`: a Down block for migration N is executable from HEAD only
      // once the objects of migrations > N are removed, and only their own files can
      // restore them. Measured: without these four statements the block dies on
      // `can_view_expenses` before it drops a single table.
      //
      // The list is T071's and is deliberately exhaustive rather than clever. If a later
      // task adds another object referencing these predicates, this rehearsal fails
      // loudly on the `DROP FUNCTION` below — which is how T071 itself found this — and
      // the fix is one more line here, not a weakened assertion.
      await tx.unsafe(`drop table if exists public.attachments`);
      await tx.unsafe(
        `drop function if exists public.can_delete_attachment(uuid, uuid, uuid)`,
      );
      await tx.unsafe(
        `drop function if exists public.attachment_expense_is_attachable(uuid, uuid)`,
      );
      await tx.unsafe(
        `drop function if exists public.attachment_presign_lock(uuid)`,
      );

      for (const statement of statements) {
        await tx.unsafe(statement);
      }

      // Everything the migration created is gone: the six tables, both enums, the three
      // functions, both constraint triggers, and the `members` anchor the composite
      // keys needed.
      const [objects] = await tx<
        {
          expenses: string | null;
          dues: string | null;
          categories: string | null;
        }[]
      >`
        select to_regclass('public.expenses')::text as expenses,
               to_regclass('public.dues')::text as dues,
               to_regclass('public.expense_categories')::text as categories
      `;
      expect(objects).toEqual({ expenses: null, dues: null, categories: null });

      const [functions] = await tx<{ count: string }[]>`
        select count(*)::text as count from pg_proc
         where proname in ('assert_split_total', 'chk_split_total', 'chk_expense_split_total',
                           'can_view_expenses', 'can_draft_expenses', 'can_publish_expenses')
      `;
      expect(functions!.count).toBe("0");

      const [enums] = await tx<{ count: string }[]>`
        select count(*)::text as count from pg_type
         where typname in ('expense_status', 'due_status')
      `;
      expect(enums!.count).toBe("0");

      const [anchor] = await tx<{ count: string }[]>`
        select count(*)::text as count from pg_constraint
         where conname = 'uq_members_id_society'
      `;
      expect(anchor!.count).toBe("0");

      // …and the forward half re-applies over the reversed schema, in one statement, the
      // way the runner applies it (`tx.unsafe(file)`). This is the property that makes a
      // forward-only history safe to rehearse: the file is idempotent because every
      // object it creates is guarded, so apply → down → apply is a cycle and not a
      // one-way door.
      await tx.unsafe(source);

      // Replaying #21 at HEAD means replaying **every later file over it**, because
      // the forward-only history has objects attached to the tables the block just
      // dropped: T067's `uq_dues_split` index and `trg_due_billable_write` trigger
      // live on `dues`, so `DROP TABLE public.dues` removes them and only the files
      // that created them can put them back. Without this the rehearsal would leave
      // this shared container at a schema no migration describes, and any spec that
      // ran after it would fail (measured: T067's own suite did, before this loop
      // existed).
      const laterFiles = readdirSync(resolveMigrationsDir())
        .filter((entry) => entry > filename && entry.endsWith(".sql"))
        .sort();
      for (const later of laterFiles) {
        await tx.unsafe(
          readFileSync(join(resolveMigrationsDir(), later), "utf8"),
        );
      }

      const [restored] = await tx<
        {
          expenses: string | null;
          dues: string | null;
          categories: string | null;
        }[]
      >`
        select to_regclass('public.expenses')::text as expenses,
               to_regclass('public.dues')::text as dues,
               to_regclass('public.expense_categories')::text as categories
      `;
      expect(restored).toEqual({
        expenses: "expenses",
        dues: "dues",
        categories: "expense_categories",
      });

      const [trigger] = await tx<{ count: string }[]>`
        select count(*)::text as count from pg_trigger
         where tgname in ('trg_split_total_write', 'trg_expense_split_total_write')
           and not tgisinternal
      `;
      expect(trigger!.count).toBe("2");

      // And the seeding is live again: the categories insert is back in the function
      // body, which is the piece a `DROP`-only down block could silently lose.
      const [seeder] = await tx<{ found: boolean }[]>`
        select (pg_get_functiondef('public.seed_society()'::regprocedure)
                like '%expense_categories%') as found
      `;
      expect(seeder!.found).toBe(true);

      // The expand step (SAD §8.8): a society that predates the migration gets its
      // nineteen categories from the backfill, because no other path can give them to
      // it — the `expense_categories` table was dropped by the down block a few
      // statements ago, and its rows went with it. Two of them are the owner-only,
      // capital funds, which is the same set the trigger seeds.
      const [seeded] = await tx<{ count: string; owner_only: string }[]>`
        select count(*)::text as count,
               count(*) filter (where is_owner_only)::text as owner_only
          from public.expense_categories
         where society_id = ${society.societyId}::uuid
      `;
      expect(seeded).toEqual({ count: "19", owner_only: "2" });

      // Re-applying a second time changes nothing: the backfill fills gaps, it does not
      // reset a set.
      await tx.unsafe(source);
      const [again] = await tx<{ count: string }[]>`
        select count(*)::text as count from public.expense_categories
         where society_id = ${society.societyId}::uuid
      `;
      expect(again!.count).toBe("19");

      // …and re-apply every later file **again**, because the re-application just above
      // restored migration #19's own policies. `source` unconditionally drops and
      // recreates `expenses_insert_author`/`expenses_update_author`, so applying it a
      // second time undoes what #31 widened them to; and because postgres.js *commits*
      // a `begin()` whose callback resolves (it rolls back only on a throw), this
      // rehearsal is not rolled back — the container keeps whatever this block left.
      // Without this final re-apply the shared schema would end one migration behind
      // HEAD, and a spec that ran afterwards would see the narrowed insert policy and
      // refuse a Committee Member's `pending_approval` insert (measured:
      // `expense-draft.integration-spec.ts` did, in every full-suite run).
      for (const later of laterFiles) {
        await tx.unsafe(
          readFileSync(join(resolveMigrationsDir(), later), "utf8"),
        );
      }

      // …and the objects taken off above are back, *with their policies* — which is the
      // property that matters and is not obvious: `DROP TABLE` removed them, and only
      // re-applying their own file can put them back, because a policy is created by a
      // statement and not by the table it hangs on. A rehearsal that restored the table
      // but not its policies would leave this shared container enforcing nothing on it
      // for every spec that ran afterwards.
      const [attachments] = await tx<
        { table_exists: boolean; policies: string; helpers: string }[]
      >`
        select to_regclass('public.attachments') is not null as table_exists,
               (select count(*)::text from pg_policy
                 where polrelid = 'public.attachments'::regclass) as policies,
               (select count(*)::text from pg_proc
                 where proname in ('can_delete_attachment',
                                   'attachment_expense_is_attachable',
                                   'attachment_presign_lock')) as helpers
      `;
      expect(attachments!.table_exists).toBe(true);
      expect(attachments!.policies).toBe("4");
      expect(attachments!.helpers).toBe("3");
    });

    // The rehearsal commits (see the note above), so this asserts it left the shared
    // schema at HEAD: the three tables exist for the specs that follow.
    const [catalogue] = await owner<{ count: string }[]>`
      select count(*)::text as count from pg_class
       where relname in ('expenses', 'expense_splits', 'expense_categories')
    `;
    expect(catalogue!.count).toBe("3");
  });
});
