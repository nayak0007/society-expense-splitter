import { asExpenseCommentId, asExpenseId, asUserId } from "@ses/domain";
import type { ExpenseId, MemberId, SocietyId, UserId } from "@ses/domain";
import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";

import { AddCommentUseCase } from "../../src/modules/expenses/application/use-cases/add-comment.use-case";
import { DeleteCommentUseCase } from "../../src/modules/expenses/application/use-cases/delete-comment.use-case";
import { ListCommentsUseCase } from "../../src/modules/expenses/application/use-cases/list-comments.use-case";
import { UpsertGstDetailsUseCase } from "../../src/modules/expenses/application/use-cases/upsert-gst-details.use-case";

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
 * The T072 comment stream and GST details against real PostgreSQL, real RLS and the
 * real grants — Roadmap T072.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes the stores, so it can pin the routes, the guards and the
 * response contracts. Everything T072's acceptance actually turns on is a fact
 * about committed rows and privileges:
 *
 *  - the comment table's **grants** — `body`, `author_id`, `expense_id` and
 *    `society_id` are insertable only, and there is no `INSERT` on `sequence` and no
 *    `UPDATE`/`DELETE` at all, so a direct client statement cannot rewrite the text,
 *    move the row or hard-delete it;
 *  - the **deletion metadata is unforgeable** — the only writer of the tombstone is
 *    `expense_comment_soft_delete()`, which stamps the caller's own membership;
 *  - the **identity sequence orders the stream** and a duplicate position is
 *    unrepresentable, so concurrent inserts all survive with distinct positions;
 *  - the **RLS + FORCE RLS posture** — a Guest inserts nothing, another tenant reads
 *    nothing;
 *  - the `gst_single_regime` constraint refuses a mixed invoice at the database;
 *  - **no financial row changes** when a GST detail or a comment is written.
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

beforeEach(async () => {
  await resetData(owner);
});

interface Fixture extends SocietyFixture {
  readonly other: SocietyFixture;
  readonly treasurerUserId: UserId;
  readonly residentUserId: UserId;
  readonly residentMemberId: MemberId;
  readonly guestUserId: UserId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Comment Court",
    "admin@t072.ses.test",
  );
  const other = await seedSociety(
    harness,
    "Other Court",
    "admin@other072.ses.test",
  );

  const treasurerUserId = asUserId(
    await createLocalUser(owner, "treasurer@t072.ses.test", "Treasurer"),
  );
  await insertMember(owner, society.societyId, {
    userId: treasurerUserId,
    role: "treasurer",
    displayName: "Treasurer",
  });

  const residentUserId = asUserId(
    await createLocalUser(owner, "resident@t072.ses.test", "Resident"),
  );
  const residentMemberId = (await insertMember(owner, society.societyId, {
    userId: residentUserId,
    role: "resident",
    displayName: "Resident",
  })) as unknown as MemberId;

  const guestUserId = asUserId(
    await createLocalUser(owner, "guest@t072.ses.test", "Guest"),
  );
  await insertMember(owner, society.societyId, {
    userId: guestUserId,
    role: "guest",
    displayName: "Guest",
  });

  return {
    ...society,
    other,
    treasurerUserId,
    residentUserId,
    residentMemberId,
    guestUserId,
  };
}

/** One expense of one society, inserted as the owner (bypasses the client grants). */
async function insertExpense(
  societyId: SocietyId,
  createdBy: MemberId,
  overrides: {
    readonly status?: "draft" | "pending_approval" | "published" | "void";
    readonly amountPaise?: string;
  } = {},
): Promise<ExpenseId> {
  const [category] = await owner<{ id: string }[]>`
    select id from public.expense_categories
     where society_id = ${societyId}::uuid
     order by display_order
     limit 1
  `;
  const [row] = await owner<{ id: string }[]>`
    insert into public.expenses (
      society_id, category_id, title, amount_paise, expense_date,
      split_strategy, status, created_by
    )
    values (
      ${societyId}::uuid,
      ${category!.id}::uuid,
      'Lift AMC — Q3',
      ${overrides.amountPaise ?? "4500000"}::bigint,
      '2026-09-30'::date,
      'equal'::public.split_strategy,
      ${overrides.status ?? "draft"}::public.expense_status,
      ${createdBy}::uuid
    )
    returning id
  `;
  return asExpenseId(row!.id);
}

/** Runs one statement as an acting `authenticated` identity and answers its SQLSTATE. */
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
): Promise<{ code: unknown }> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { code: unknown };
  }
  throw new Error("Expected the call to be refused.");
}

async function commentsOf(expenseId: ExpenseId): Promise<
  readonly {
    id: string;
    author_id: string;
    body: string;
    sequence: string;
    deleted_at: string | null;
    deleted_by: string | null;
  }[]
> {
  // `sequence` is both an output column here (`::text as sequence`) and an input
  // column, and a bare `order by sequence` would resolve to the OUTPUT — sorting
  // digits as text. Qualifying pins the sort key to the input `bigint`, exactly as
  // the production repository does.
  return owner`
    select id, author_id, body, sequence::text as sequence,
           deleted_at::text as deleted_at, deleted_by
      from public.expense_comments
     where expense_id = ${expenseId}::uuid
     order by public.expense_comments.sequence asc
  `;
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

// ── schema and privileges ────────────────────────────────────────────────────

describe("expense_comments privileges and RLS", () => {
  it("forces RLS and grants no UPDATE or DELETE to authenticated", async () => {
    const [row] = await owner<
      { rls: boolean; force: boolean; upd: boolean; del: boolean }[]
    >`
      select c.relrowsecurity as rls,
             c.relforcerowsecurity as force,
             has_table_privilege('authenticated', 'public.expense_comments', 'UPDATE') as upd,
             has_table_privilege('authenticated', 'public.expense_comments', 'DELETE') as del
        from pg_class c
       where c.oid = 'public.expense_comments'::regclass
    `;
    expect(row).toMatchObject({
      rls: true,
      force: true,
      upd: false,
      del: false,
    });
  });

  it("inserts only the four client columns and never the sequence", async () => {
    const [row] = await owner<
      {
        seq_insert: boolean;
        deleted_insert: boolean;
        body_insert: boolean;
        deleted_update: boolean;
      }[]
    >`
      select
        has_column_privilege('authenticated', 'public.expense_comments', 'sequence', 'INSERT') as seq_insert,
        has_column_privilege('authenticated', 'public.expense_comments', 'deleted_at', 'INSERT') as deleted_insert,
        has_column_privilege('authenticated', 'public.expense_comments', 'body', 'INSERT') as body_insert,
        has_column_privilege('authenticated', 'public.expense_comments', 'deleted_at', 'UPDATE') as deleted_update
    `;
    expect(row).toMatchObject({
      seq_insert: false,
      deleted_insert: false,
      body_insert: true,
      deleted_update: false,
    });
  });

  it("refuses a direct body rewrite, tenant move, hard delete and forged tombstone", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const useCase = harness.app.get(AddCommentUseCase);
    const comment = await useCase.add(
      fixture.adminUserId,
      fixture.societyId,
      expenseId,
      { body: "Original text" },
    );

    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expense_comments set body = 'rewritten'
             where id = ${comment.id}::uuid`,
      ),
    ).toBe("42501");
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expense_comments
               set deleted_at = now(), deleted_by = ${fixture.residentMemberId}::uuid
             where id = ${comment.id}::uuid`,
      ),
    ).toBe("42501");
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`delete from public.expense_comments where id = ${comment.id}::uuid`,
      ),
    ).toBe("42501");

    const [stored] = await commentsOf(expenseId);
    expect(stored).toMatchObject({ body: "Original text", deleted_at: null });
  });

  it("lets a Guest insert nothing (RLS insert policy)", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );

    const state = await sqlstateAs(
      fixture.guestUserId,
      sql`insert into public.expense_comments (society_id, expense_id, author_id, body)
          values (
            ${fixture.societyId}::uuid,
            ${expenseId}::uuid,
            ${fixture.adminMemberId}::uuid,
            'guest comment'
          )`,
    );
    // A Guest has no `expense.view`, so nothing they write passes the policy. The
    // FK to the row's own society is satisfied; the refusal is the capability.
    expect(["42501", "refused"]).toContain(state);
    expect(await commentsOf(expenseId)).toHaveLength(0);
  });

  it("hides another tenant's comments from a member", async () => {
    const fixture = await seed();
    const foreignExpense = await insertExpense(
      fixture.other.societyId,
      fixture.other.adminMemberId,
    );
    await owner`
      insert into public.expense_comments (society_id, expense_id, author_id, body)
      values (
        ${fixture.other.societyId}::uuid,
        ${foreignExpense}::uuid,
        ${fixture.other.adminMemberId}::uuid,
        'other tenant'
      )
    `;
    const rows = await harness.unitOfWork.transaction(
      { kind: "user", userId: fixture.adminUserId },
      (tx) =>
        tx.execute<{ id: string }>(sql`
          select id from public.expense_comments
           where expense_id = ${foreignExpense}::uuid
        `),
    );
    expect(rows).toHaveLength(0);
  });
});

// ── soft delete through the use case and the definer function ────────────────

describe("comment soft delete", () => {
  it("tombstones the author's own comment, preserving body and position", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const add = harness.app.get(AddCommentUseCase);
    const comment = await add.add(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      { body: "Keep the row" },
    );

    const remove = harness.app.get(DeleteCommentUseCase);
    await remove.softDelete(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      comment.id,
    );

    const [stored] = await commentsOf(expenseId);
    expect(stored).toMatchObject({
      body: "Keep the row",
      deleted_by: fixture.residentMemberId,
    });
    expect(stored!.deleted_at).not.toBeNull();
    // The position is the database's and must survive the tombstone — but it is
    // deliberately NOT asserted to be `1`: `sequence` is a table-wide identity and
    // `resetData` truncates without restarting it, so the value a comment receives
    // depends on how many earlier tests in this same run inserted.
    expect(stored!.sequence).toBe(String(comment.sequence));
  });

  it("is idempotent — a second delete changes nothing", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const add = harness.app.get(AddCommentUseCase);
    const comment = await add.add(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      { body: "Delete me twice" },
    );

    const remove = harness.app.get(DeleteCommentUseCase);
    await remove.softDelete(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      comment.id,
    );
    const first = (await commentsOf(expenseId))[0]!;
    await remove.softDelete(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      comment.id,
    );
    const second = (await commentsOf(expenseId))[0]!;
    expect(second.deleted_at).toBe(first.deleted_at);
  });

  it("lets an Admin delete another member's comment", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const add = harness.app.get(AddCommentUseCase);
    const comment = await add.add(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      { body: "Admin will remove this" },
    );

    const remove = harness.app.get(DeleteCommentUseCase);
    await remove.softDelete(
      fixture.adminUserId,
      fixture.societyId,
      expenseId,
      comment.id,
    );
    expect((await commentsOf(expenseId))[0]!.deleted_by).toBe(
      fixture.adminMemberId,
    );
  });

  it("refuses a member who is neither the author nor an Admin", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const add = harness.app.get(AddCommentUseCase);
    const comment = await add.add(
      fixture.adminUserId,
      fixture.societyId,
      expenseId,
      { body: "Only the author or an Admin" },
    );

    const remove = harness.app.get(DeleteCommentUseCase);
    const failure = await failureOf(
      remove.softDelete(
        fixture.treasurerUserId,
        fixture.societyId,
        expenseId,
        comment.id,
      ),
    );
    expect(failure.code).toBe("FORBIDDEN");
    expect((await commentsOf(expenseId))[0]!.deleted_at).toBeNull();
  });
});

// ── ordering under concurrency ───────────────────────────────────────────────

describe("comment ordering", () => {
  it("keeps every concurrent insert with a distinct, increasing position", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const add = harness.app.get(AddCommentUseCase);

    await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        add.add(fixture.residentUserId, fixture.societyId, expenseId, {
          body: `comment ${index}`,
        }),
      ),
    );

    const rows = await commentsOf(expenseId);
    expect(rows).toHaveLength(8);
    const sequences = rows.map((row) => BigInt(row.sequence));
    expect(new Set(sequences.map((value) => value.toString())).size).toBe(8);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]! > sequences[index - 1]!).toBe(true);
    }
  });

  it("orders a stream that straddles a digit-length boundary numerically, not as text", async () => {
    // Pins the 2026-10-08 defect: `listForExpense` selected
    // `sequence::text as sequence` and sorted it with a bare `order by sequence`,
    // which PostgreSQL resolves to that OUTPUT column — so a stream came back
    // 1, 10, 11, 2. The identity is table-wide, so any real expense reaches this
    // shape the moment its stream crosses 9 → 10 (or 99 → 100). The positions are
    // written explicitly across exactly that boundary, because waiting for the
    // table-wide counter to arrive there would make the guard depend on how many
    // comments every earlier test happened to insert.
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    for (const position of [9, 10, 11, 12]) {
      await owner`
        insert into public.expense_comments (
          society_id, expense_id, author_id, body, sequence
        ) overriding system value
        values (
          ${fixture.societyId}::uuid,
          ${expenseId}::uuid,
          ${fixture.residentMemberId}::uuid,
          ${`position ${position}`},
          ${position}::bigint
        )
      `;
    }

    const list = harness.app.get(ListCommentsUseCase);
    const comments = await list.list(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
    );

    expect(comments.map((comment) => comment.sequence)).toEqual([
      9, 10, 11, 12,
    ]);
  });

  it("lists the stream oldest-first through the use case", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const add = harness.app.get(AddCommentUseCase);
    await add.add(fixture.residentUserId, fixture.societyId, expenseId, {
      body: "first",
    });
    await add.add(fixture.adminUserId, fixture.societyId, expenseId, {
      body: "second",
    });

    const list = harness.app.get(ListCommentsUseCase);
    const comments = await list.list(
      fixture.treasurerUserId,
      fixture.societyId,
      expenseId,
    );
    expect(comments.map((comment) => comment.body)).toEqual([
      "first",
      "second",
    ]);
  });
});

// ── GST details ──────────────────────────────────────────────────────────────

describe("GST details", () => {
  it("upserts a row atomically, replacing on the second write", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const upsert = harness.app.get(UpsertGstDetailsUseCase);

    await upsert.upsert(fixture.adminUserId, fixture.societyId, expenseId, {
      taxableValuePaise: 4_000_000,
      cgstPaise: 250_000,
      sgstPaise: 250_000,
    });
    await upsert.upsert(fixture.adminUserId, fixture.societyId, expenseId, {
      taxableValuePaise: 1_000_000,
    });

    const rows = await owner<
      { taxable_value_paise: string; cgst_paise: string }[]
    >`
      select taxable_value_paise::text, cgst_paise::text
        from public.expense_gst_details
       where expense_id = ${expenseId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taxable_value_paise: "1000000",
      cgst_paise: "0",
    });
  });

  it("refuses a mixed tax regime at the database constraint", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`insert into public.expense_gst_details (
              expense_id, society_id, taxable_value_paise, cgst_paise, igst_paise
            ) values (
              ${expenseId}::uuid, ${fixture.societyId}::uuid, 0, 100, 100
            )`,
      ),
    ).toBe("23514");
  });

  it("does not clear approval stamps (D5)", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
      {
        status: "pending_approval",
      },
    );
    await owner`
      update public.expenses
         set approved_by = ${fixture.adminMemberId}::uuid,
             approved_at = now()
       where id = ${expenseId}::uuid
    `;

    const upsert = harness.app.get(UpsertGstDetailsUseCase);
    await upsert.upsert(fixture.adminUserId, fixture.societyId, expenseId, {
      cgstPaise: 100,
    });

    const [row] = await owner<
      { approved_by: string | null; approved_at: string | null }[]
    >`
      select approved_by, approved_at::text from public.expenses
       where id = ${expenseId}::uuid
    `;
    expect(row?.approved_by).toBe(fixture.adminMemberId);
    expect(row?.approved_at).not.toBeNull();
  });

  it("records the forward migration and touches no financial row", async () => {
    const fixture = await seed();
    const expenseId = await insertExpense(
      fixture.societyId,
      fixture.adminMemberId,
    );
    const before = await financialCounts();

    const upsert = harness.app.get(UpsertGstDetailsUseCase);
    await upsert.upsert(fixture.adminUserId, fixture.societyId, expenseId, {
      cgstPaise: 100,
    });
    const add = harness.app.get(AddCommentUseCase);
    const comment = await add.add(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      { body: "no money moved" },
    );
    const remove = harness.app.get(DeleteCommentUseCase);
    await remove.softDelete(
      fixture.residentUserId,
      fixture.societyId,
      expenseId,
      asExpenseCommentId(comment.id),
    );

    expect(await financialCounts()).toEqual(before);
    const [ledger] = await owner<{ count: string }[]>`
      select count(*)::text as count from ses_meta.migrations
       where name = '20261014120000_expense_comments.sql'
    `;
    expect(ledger?.count).toBe("1");
  });
});
