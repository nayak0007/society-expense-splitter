import { asUserId } from "@ses/domain";
import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseId,
  MemberId,
  SocietyId,
  UserId,
} from "@ses/domain";
import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import { ApproveExpenseUseCase } from "../../src/modules/expenses/application/use-cases/approve-expense.use-case";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { ListApprovalQueueUseCase } from "../../src/modules/expenses/application/use-cases/list-approval-queue.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import { RejectExpenseUseCase } from "../../src/modules/expenses/application/use-cases/reject-expense.use-case";
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
 * T070's approval workflow against real PostgreSQL, real RLS and the real
 * `expense_approve()`/`expense_reject()`/`expense_publish()` definer functions —
 * ADR-0011.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes storage, so there the gate is a fake's copy of the rule. Here
 * the rule is PostgreSQL's, evaluated against the committed row and the society's
 * **current** settings:
 *
 *  - the **threshold boundary** — 999,999 / 1,000,000 / 1,000,001 paise against a
 *    1,000,000 threshold, at create and at publish;
 *  - the **publication precondition** — a high-value expense without a live
 *    approval refuses with `APPROVAL_REQUIRED` and writes **nothing** financial;
 *    a below-threshold draft still publishes normally;
 *  - the **Committee deadlock fix** — a Committee Member's own above-threshold
 *    expense is submitted by the threshold rule, cannot be approved by a Committee
 *    Member or a Treasurer, can be approved by an Admin and published by a
 *    Treasurer, with the financial rows written exactly once;
 *  - the **stamps** — `approved_by` is the approver's *membership*, `approved_at`
 *    is the database's instant, the version moves and the status does not;
 *  - the **direct-write hardening** — a raw client `UPDATE` cannot publish an
 *    unapproved high-value row nor flip one back to draft, cannot write the
 *    lifecycle stamps at all, and the definer functions refuse a non-Admin with
 *    `42501`;
 *  - the **locking** — two concurrent approvals leave exactly one winner, and
 *    approval serialises against publication;
 *  - **T069's invariants still hold** — approval and rejection write no split, no
 *    due, no balance and no revision, and void behaviour is unchanged.
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

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Fixture extends SocietyFixture {
  readonly north: BuildingId;
  readonly flats: readonly ApartmentId[];
  readonly members: readonly MemberId[];
  readonly other: SocietyFixture;
  readonly categoryId: ExpenseCategoryId;
  readonly committeeUserId: UserId;
  readonly treasurerUserId: UserId;
  readonly residentUserId: UserId;
}

async function insertFlatWithOwner(
  societyId: SocietyId,
  buildingId: BuildingId,
  number: string,
  floor: number,
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
      ${number},
      ${floor}::smallint,
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
    displayName: `Owner ${number}`,
  });
  return { apartmentId, memberId: memberId as MemberId };
}

async function seed(flatCount = 4): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Approval Court",
    "admin@approval.ses.test",
  );
  const north = await insertBuilding(owner, society.societyId, "North Block");

  const flats: ApartmentId[] = [];
  const members: MemberId[] = [];
  for (let index = 1; index <= flatCount; index += 1) {
    const flat = await insertFlatWithOwner(
      society.societyId,
      north,
      `A${String(index).padStart(3, "0")}`,
      ((index - 1) % 8) + 1,
    );
    flats.push(flat.apartmentId);
    members.push(flat.memberId);
  }

  const roleUser = async (
    email: string,
    displayName: string,
    role: "committee_member" | "treasurer" | "resident",
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
    "committee@approval.ses.test",
    "Committee Member",
    "committee_member",
  );
  const treasurerUserId = await roleUser(
    "treasurer@approval.ses.test",
    "Treasurer",
    "treasurer",
  );
  const residentUserId = await roleUser(
    "resident@approval.ses.test",
    "Resident",
    "resident",
  );

  const other = await seedSociety(
    harness,
    "Other Approval Court",
    "admin@otherapproval.ses.test",
  );

  const categories = harness.app.get<ExpenseCategoryRepository>(
    EXPENSE_CATEGORY_REPOSITORY,
  );
  const listed = await categories.listCategories(
    society.societyId,
    society.adminUserId,
  );
  const category = listed.find((entry) => entry.name === "Lift");
  if (category === undefined) throw new Error('The seeded "Lift" is missing.');

  return {
    ...society,
    north,
    flats,
    members,
    other,
    categoryId: category.id,
    committeeUserId,
    treasurerUserId,
    residentUserId,
  };
}

// ── the doors ────────────────────────────────────────────────────────────────

let keyCounter = 0;

interface DraftOptions {
  readonly actor?: UserId;
  readonly amountPaise?: number;
  readonly title?: string;
}

async function createDraft(
  fixture: Fixture,
  options: DraftOptions = {},
): Promise<{ id: ExpenseId; version: number; status: string }> {
  const createExpense = harness.app.get(CreateExpenseUseCase);
  const record = await createExpense.create(
    options.actor ?? fixture.adminUserId,
    fixture.societyId,
    {
      title: options.title ?? "Lift AMC — Q4",
      amountPaise: options.amountPaise ?? 400_000,
      expenseDate: "2026-09-30",
      categoryId: fixture.categoryId as string,
    },
  );
  return { id: record.id, version: record.version, status: record.status };
}

function approvalOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  options: {
    readonly actor?: UserId;
    readonly expectedVersion?: number;
    readonly societyId?: SocietyId;
  } = {},
) {
  const useCase = harness.app.get(ApproveExpenseUseCase);
  return useCase.approve(
    options.actor ?? fixture.adminUserId,
    options.societyId ?? fixture.societyId,
    expenseId,
    { expectedVersion: options.expectedVersion ?? 1 },
  );
}

function rejectionOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  options: {
    readonly actor?: UserId;
    readonly expectedVersion?: number;
    readonly reason?: string;
    readonly societyId?: SocietyId;
  } = {},
) {
  const useCase = harness.app.get(RejectExpenseUseCase);
  return useCase.reject(
    options.actor ?? fixture.adminUserId,
    options.societyId ?? fixture.societyId,
    expenseId,
    {
      expectedVersion: options.expectedVersion ?? 1,
      reason: options.reason ?? REASON,
    },
  );
}

async function publishOf(
  fixture: Fixture,
  expenseId: ExpenseId,
  options: {
    readonly actor?: UserId;
    readonly expectedVersion?: number;
    readonly idempotencyKey?: string;
  } = {},
) {
  const useCase = harness.app.get(PublishExpenseUseCase);
  keyCounter += 1;
  return useCase.publish(
    options.actor ?? fixture.adminUserId,
    fixture.societyId,
    expenseId,
    {
      expectedVersion: options.expectedVersion ?? 1,
      idempotencyKey:
        options.idempotencyKey ??
        `t070-publish-${String(keyCounter).padStart(4, "0")}`,
    },
  );
}

const REASON = "Duplicate bill; cancelled by the vendor.";

/**
 * The thrown failure, as the HTTP layer would render it: the catalogue code, the
 * field a form acts on and the stable detail code (`APPROVAL_REQUIRED`).
 *
 * The use cases translate the definer functions' SQLSTATEs into the module's
 * vocabulary and then into the API catalogue, so a `409` for a missing approval is
 * `CONFLICT` on the envelope and `APPROVAL_REQUIRED` in the details — the same
 * pair a client branches on.
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
      message: String(candidate.message ?? ""),
      field: candidate.payload?.field ?? candidate.field,
      detail: candidate.payload?.details?.[0]?.code,
    };
  }
  throw new Error("Expected the call to be refused.");
}

/** The SQLSTATE a query raises under one identity, or `allowed`. */
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

// ── row readers ──────────────────────────────────────────────────────────────

interface ExpenseRow {
  readonly status: string;
  readonly title: string;
  readonly version: number;
  readonly amount_paise: string;
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly rejected_by: string | null;
  readonly rejected_at: string | null;
  readonly rejection_reason: string | null;
  readonly published_at: string | null;
}

async function rowOf(expenseId: ExpenseId): Promise<ExpenseRow> {
  const [row] = await owner<ExpenseRow[]>`
    select status::text as status, title, version, amount_paise::text,
           approved_by, approved_at, rejected_by, rejected_at,
           rejection_reason, published_at
      from public.expenses
     where id = ${expenseId}::uuid
  `;
  if (row === undefined) throw new Error(`expense ${expenseId} is missing`);
  return row;
}

async function membershipOfUser(
  fixture: Fixture,
  userId: UserId,
): Promise<MemberId> {
  const [row] = await owner<{ id: string }[]>`
    select id from public.members
     where society_id = ${fixture.societyId}::uuid and user_id = ${userId}::uuid
  `;
  if (row === undefined) throw new Error(`member for ${userId} is missing`);
  return row!.id as MemberId;
}

const EXPENSE_TABLES = [
  "expenses",
  "expense_splits",
  "expense_revisions",
  "dues",
  "member_balances",
] as const;

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of EXPENSE_TABLES) {
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.${owner(table)}
    `;
    result[table] = Number(row?.count ?? "0");
  }
  return result;
}

/** Sets the society's current approval threshold — the "current settings" under test. */
async function setThreshold(
  fixture: Fixture,
  thresholdPaise: number,
): Promise<void> {
  await owner`
    update public.society_settings
       set approval_threshold_paise = ${String(thresholdPaise)}::bigint
     where society_id = ${fixture.societyId}::uuid
  `;
}

// ── the threshold rule ───────────────────────────────────────────────────────

describe("the threshold rule", () => {
  it("routes 1,000,001 paise into the queue and 999,999 stays a draft (boundary)", async () => {
    const fixture = await seed();

    const below = await createDraft(fixture, { amountPaise: 999_999 });
    const at = await createDraft(fixture, { amountPaise: 1_000_000 });
    const above = await createDraft(fixture, { amountPaise: 1_000_001 });

    expect((await rowOf(below.id)).status).toBe("draft");
    expect((await rowOf(at.id)).status).toBe("pending_approval");
    expect((await rowOf(above.id)).status).toBe("pending_approval");
  });

  it("publishes a below-threshold draft with no approval at all", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 999_999 });

    const publication = await publishOf(fixture, draft.id);

    expect(publication.expense.status).toBe("published");
    expect(await counts()).toMatchObject({
      expense_splits: 4,
      dues: 4,
      member_balances: 4,
    });
  });

  it("refuses to publish an unapproved at-threshold expense, writing nothing (zero financial writes)", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 1_000_000 });
    const before = await counts();

    const failure = await failureOf(publishOf(fixture, draft.id));

    expect(failure.code).toBe("CONFLICT");
    expect(failure.detail).toBe("APPROVAL_REQUIRED");
    expect(await counts()).toEqual(before);
    const row = await rowOf(draft.id);
    expect(row.status).toBe("pending_approval");
    expect(row.published_at).toBeNull();
  });

  it("re-evaluates against the current threshold, not the one at create time", async () => {
    const fixture = await seed();
    // Created below the old threshold and left a draft…
    const draft = await createDraft(fixture, { amountPaise: 500_000 });
    expect((await rowOf(draft.id)).status).toBe("draft");

    // …and the society tightens its policy before the publication.
    await setThreshold(fixture, 400_000);

    const failure = await failureOf(publishOf(fixture, draft.id));
    expect(failure.code).toBe("CONFLICT");
    expect(failure.detail).toBe("APPROVAL_REQUIRED");
    expect((await rowOf(draft.id)).status).toBe("draft");
  });

  it("publishes an at-threshold expense once approved, and only once", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 1_000_000 });

    await approvalOf(fixture, draft.id, { expectedVersion: 1 });
    const publication = await publishOf(fixture, draft.id, {
      expectedVersion: 2,
    });

    expect(publication.expense.status).toBe("published");
    expect(await counts()).toMatchObject({
      expense_splits: 4,
      dues: 4,
      member_balances: 4,
      expense_revisions: 0,
    });
  });
});

// ── approval semantics ───────────────────────────────────────────────────────

describe("approval", () => {
  it("stamps the approver's membership and the database instant, moving neither the status nor a financial row", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    const before = await counts();

    const approved = await approvalOf(fixture, draft.id, {
      expectedVersion: 1,
    });

    expect(approved.status).toBe("pending_approval");
    expect(approved.approvedBy).toBe(fixture.adminMemberId);
    expect(approved.approvedAt).not.toBeNull();
    // Nothing financial: the decision is workflow state only.
    expect(await counts()).toEqual(before);
    expect(await rowOf(draft.id)).toMatchObject({
      status: "pending_approval",
      version: 2,
      published_at: null,
    });
  });

  it("lets an Admin approve their own expense, exactly once (self-approval, D5)", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, {
      actor: fixture.adminUserId,
      amountPaise: 2_000_000,
    });

    const approved = await approvalOf(fixture, draft.id, {
      expectedVersion: 1,
    });
    expect(approved.approvedBy).toBe(fixture.adminMemberId);

    // A second approval is a refusal, never a quiet success.
    const second = await failureOf(
      approvalOf(fixture, draft.id, { expectedVersion: 2 }),
    );
    expect(second.code).toBe("INVALID_TRANSITION");
    expect((await rowOf(draft.id)).version).toBe(2);
  });

  it("refuses a Treasurer and a Committee Member, and refuses a draft", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    const treasurerDraft = await createDraft(fixture, {
      actor: fixture.treasurerUserId,
      amountPaise: 2_000_000,
    });

    // The refusal is the role rule — including for the Treasurer's own expense.
    const treasurer = await failureOf(
      approvalOf(fixture, treasurerDraft.id, {
        actor: fixture.treasurerUserId,
        expectedVersion: 1,
      }),
    );
    expect(treasurer.code).toBe("FORBIDDEN");

    const committee = await failureOf(
      approvalOf(fixture, draft.id, {
        actor: fixture.committeeUserId,
        expectedVersion: 1,
      }),
    );
    expect(committee.code).toBe("FORBIDDEN");

    const draftExpense = await createDraft(fixture, { amountPaise: 400_000 });
    const notPending = await failureOf(
      approvalOf(fixture, draftExpense.id, { expectedVersion: 1 }),
    );
    expect(notPending.code).toBe("INVALID_TRANSITION");

    expect(await rowOf(draft.id)).toMatchObject({
      approved_by: null,
      approved_at: null,
    });
  });

  it("refuses a stale version with the row's current one, and a cross-society id as not_found", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    const stale = await failureOf(
      approvalOf(fixture, draft.id, { expectedVersion: 7 }),
    );
    expect(stale.code).toBe("VERSION_MISMATCH");

    const foreign = await failureOf(
      approvalOf(fixture, draft.id, {
        actor: fixture.other.adminUserId,
        societyId: fixture.other.societyId,
        expectedVersion: 1,
      }),
    );
    expect(foreign.code).toBe("NOT_FOUND");
  });

  it("clears stale rejection metadata when an approved expense carries one", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await rejectionOf(fixture, draft.id, { expectedVersion: 1 });
    // The creator resubmits, then the Admin approves — the rejection is answered.
    const updateExpense = harness.app.get(UpdateExpenseUseCase);
    await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      draft.id,
      {
        expectedVersion: 2,
        title: "Corrected title",
      },
    );

    const approved = await approvalOf(fixture, draft.id, {
      expectedVersion: 3,
    });

    expect(approved.rejectedBy).toBeNull();
    expect(approved.rejectedAt).toBeNull();
    expect(approved.rejectionReason).toBeNull();
  });
});

// ── rejection semantics ──────────────────────────────────────────────────────

describe("rejection", () => {
  it("returns the expense to draft with the three stamps and the approval cleared", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, draft.id, { expectedVersion: 1 });
    const before = await counts();

    const rejected = await rejectionOf(fixture, draft.id, {
      expectedVersion: 2,
    });

    expect(rejected.status).toBe("draft");
    expect(rejected.rejectedBy).toBe(fixture.adminMemberId);
    expect(rejected.rejectedAt).not.toBeNull();
    expect(rejected.rejectionReason).toBe(REASON);
    expect(rejected.approvedBy).toBeNull();
    expect(rejected.approvedAt).toBeNull();
    expect(await counts()).toEqual(before);
    expect(await rowOf(draft.id)).toMatchObject({ version: 3 });
  });

  it("validates the reason against `reason` before moving the lifecycle", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    const short = await failureOf(
      rejectionOf(fixture, draft.id, {
        expectedVersion: 1,
        reason: "Too short",
      }),
    );
    expect(short.code).toBe("VALIDATION_ERROR");
    expect(short.field).toBe("reason");

    const control = await failureOf(
      rejectionOf(fixture, draft.id, {
        expectedVersion: 1,
        reason: "Duplicate\u0007 bill from the vendor",
      }),
    );
    expect(control.code).toBe("VALIDATION_ERROR");
    expect(control.field).toBe("reason");

    // The row never moved.
    expect(await rowOf(draft.id)).toMatchObject({
      status: "pending_approval",
      version: 1,
      rejected_at: null,
    });
  });

  it("refuses the reason to a non-Admin and refuses a draft", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    const treasurer = await failureOf(
      rejectionOf(fixture, draft.id, {
        actor: fixture.treasurerUserId,
        expectedVersion: 1,
      }),
    );
    expect(treasurer.code).toBe("FORBIDDEN");

    const belowThreshold = await createDraft(fixture, {
      amountPaise: 400_000,
    });
    const notPending = await failureOf(
      rejectionOf(fixture, belowThreshold.id, { expectedVersion: 1 }),
    );
    expect(notPending.code).toBe("INVALID_TRANSITION");
  });

  it("clears the rejection stamps when the creator resubmits", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await rejectionOf(fixture, draft.id, { expectedVersion: 1 });

    const updateExpense = harness.app.get(UpdateExpenseUseCase);
    const edited = await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      draft.id,
      { expectedVersion: 2, title: "Corrected title" },
    );

    expect(edited.expense.status).toBe("pending_approval");
    expect(edited.expense.rejectionReason).toBeNull();
    expect((await rowOf(draft.id)).rejected_by).toBeNull();
  });

  it("answers the definer function's own refusal when reached directly", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    // A Committee Member is a real, active member — the refusal is the capability.
    expect(
      await sqlstateAs(
        fixture.committeeUserId,
        sql`select * from public.expense_reject(
          ${draft.id}::uuid, ${fixture.societyId}::uuid, 1, 'Direct call attempt'
        )`,
      ),
    ).toBe("42501");
    expect(
      await sqlstateAs(
        fixture.committeeUserId,
        sql`select * from public.expense_approve(
          ${draft.id}::uuid, ${fixture.societyId}::uuid, 1
        )`,
      ),
    ).toBe("42501");
    // A non-member cannot even tell the society exists.
    expect(
      await sqlstateAs(
        fixture.other.adminUserId,
        sql`select * from public.expense_approve(
          ${draft.id}::uuid, ${fixture.societyId}::uuid, 1
        )`,
      ),
    ).toBe("P0002");
  });
});

// ── the Committee deadlock fix ───────────────────────────────────────────────

describe("the Committee submission deadlock", () => {
  it("submits, refuses the Committee, refuses the Treasurer, and lets an Admin decide before a Treasurer publishes", async () => {
    const fixture = await seed();

    // 1 · Committee creates an eligible high-value draft; the threshold rule routes it.
    const draft = await createDraft(fixture, {
      actor: fixture.committeeUserId,
      amountPaise: 5_000_000,
    });
    expect(draft.status).toBe("pending_approval");
    const [stored] = await owner<{ created_by: string }[]>`
      select created_by from public.expenses where id = ${draft.id}::uuid
    `;
    expect(stored?.created_by).toBe(
      await membershipOfUser(fixture, fixture.committeeUserId),
    );

    // 2 · Committee cannot approve it…
    const committee = await failureOf(
      approvalOf(fixture, draft.id, {
        actor: fixture.committeeUserId,
        expectedVersion: 1,
      }),
    );
    expect(committee.code).toBe("FORBIDDEN");

    // 3 · …nor can the Treasurer (role rule, not a self-approval rule).
    const treasurer = await failureOf(
      approvalOf(fixture, draft.id, {
        actor: fixture.treasurerUserId,
        expectedVersion: 1,
      }),
    );
    expect(treasurer.code).toBe("FORBIDDEN");

    // 4 · The Admin approves.
    const approved = await approvalOf(fixture, draft.id, {
      expectedVersion: 1,
    });
    expect(approved.approvedBy).toBe(fixture.adminMemberId);

    // 5 · The existing authorized publisher publishes.
    const publication = await publishOf(fixture, draft.id, {
      actor: fixture.treasurerUserId,
      expectedVersion: 2,
    });
    expect(publication.expense.status).toBe("published");

    // 6 · The financial writes happened exactly once.
    expect(await counts()).toMatchObject({
      expenses: 1,
      expense_splits: 4,
      dues: 4,
      member_balances: 4,
      expense_revisions: 0,
    });
    const [splitTotal] = await owner<{ total: string }[]>`
      select coalesce(sum(amount_paise), 0)::text as total
        from public.expense_splits where expense_id = ${draft.id}::uuid
    `;
    expect(splitTotal?.total).toBe("5000000");
  });
});

// ── D8: edit invalidation ────────────────────────────────────────────────────

describe("editing an approved expense", () => {
  it("clears the approval and keeps the row submitted when the amount is still at or above the threshold", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, draft.id, { expectedVersion: 1 });

    const updateExpense = harness.app.get(UpdateExpenseUseCase);
    const edited = await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      draft.id,
      { expectedVersion: 2, title: "A different expense" },
    );

    expect(edited.expense.status).toBe("pending_approval");
    expect(edited.expense.approvedBy).toBeNull();
    expect(edited.expense.approvedAt).toBeNull();
    // …and the stale approval cannot be used to publish: the stamps are gone.
    const failure = await failureOf(
      publishOf(fixture, draft.id, { expectedVersion: 3 }),
    );
    expect(failure.code).toBe("CONFLICT");
    expect(failure.detail).toBe("APPROVAL_REQUIRED");
  });

  it("returns the row to draft when the edit drops it below the current threshold", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, draft.id, { expectedVersion: 1 });

    const updateExpense = harness.app.get(UpdateExpenseUseCase);
    const edited = await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      draft.id,
      { expectedVersion: 2, amountPaise: 500_000 },
    );

    expect(edited.expense.status).toBe("draft");
    expect(edited.expense.approvedBy).toBeNull();
    // No approval is required any more, so it publishes directly.
    const publication = await publishOf(fixture, draft.id, {
      expectedVersion: 3,
    });
    expect(publication.expense.status).toBe("published");
  });

  it("keeps the publication refused for an at-threshold draft whose amount is raised after approval", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 1_000_000 });
    await approvalOf(fixture, draft.id, { expectedVersion: 1 });

    const updateExpense = harness.app.get(UpdateExpenseUseCase);
    await updateExpense.update(
      fixture.adminUserId,
      fixture.societyId,
      draft.id,
      {
        expectedVersion: 2,
        amountPaise: 3_000_000,
      },
    );

    const failure = await failureOf(
      publishOf(fixture, draft.id, { expectedVersion: 3 }),
    );
    expect(failure.code).toBe("CONFLICT");
    expect(failure.detail).toBe("APPROVAL_REQUIRED");
  });
});

// ── direct-write hardening ───────────────────────────────────────────────────

describe("direct-write hardening", () => {
  it("refuses a raw client UPDATE that would publish an unapproved at-threshold expense", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    // `status` IS in the client's UPDATE grant; the guard trigger is what refuses.
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses set status = 'published'
             where id = ${draft.id}::uuid`,
      ),
    ).toBe("P0001");

    expect((await rowOf(draft.id)).status).toBe("pending_approval");
    expect(await counts()).toMatchObject({
      expense_splits: 0,
      dues: 0,
      member_balances: 0,
    });
  });

  it("refuses a raw client flip of a high-value submission back to draft", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses set status = 'draft'
             where id = ${draft.id}::uuid`,
      ),
    ).toBe("P0001");

    expect((await rowOf(draft.id)).status).toBe("pending_approval");
  });

  it("allows the raw flip when the amount is below the current threshold — the D8 direction", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    // Lowering the amount first is a legitimate content edit…
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses set amount_paise = 500000
             where id = ${draft.id}::uuid`,
      ),
    ).toBe("allowed");

    // …and then the flip is the same move `revertToDraft` makes.
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses set status = 'draft'
             where id = ${draft.id}::uuid`,
      ),
    ).toBe("allowed");
    expect((await rowOf(draft.id)).status).toBe("draft");
  });

  it("refuses a raw client write of the approval stamps at the grant level", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    // `approved_by` / `approved_at` are not in the `authenticated` UPDATE grant, so
    // the approval cannot be forged by writing the columns directly.
    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses set approved_at = now()
             where id = ${draft.id}::uuid`,
      ),
    ).toBe("42501");
    expect((await rowOf(draft.id)).approved_at).toBeNull();
  });

  it("invalidates an approval when a raw client edit changes the content", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, draft.id, { expectedVersion: 1 });
    expect((await rowOf(draft.id)).approved_by).not.toBeNull();

    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`update public.expenses set title = 'Directly edited'
             where id = ${draft.id}::uuid`,
      ),
    ).toBe("allowed");

    const row = await rowOf(draft.id);
    expect(row.title).toBe("Directly edited");
    expect(row.approved_by).toBeNull();
    expect(row.approved_at).toBeNull();
  });

  it("still refuses an unexpected high-value draft at the definer function", async () => {
    const fixture = await seed();
    // A genuine draft that became high-value *after* it was created: created below
    // the threshold, then raised by a raw edit — the state the D4 rule must not let
    // through even though no submission ever happened.
    const draft = await createDraft(fixture, { amountPaise: 400_000 });
    expect((await rowOf(draft.id)).status).toBe("draft");
    await owner`
      update public.expenses set amount_paise = 2000000
       where id = ${draft.id}::uuid
    `;

    expect(
      await sqlstateAs(
        fixture.adminUserId,
        sql`select * from public.expense_publish(
          ${draft.id}::uuid, ${fixture.societyId}::uuid, 1, '[]'::jsonb
        )`,
      ),
    ).toBe("P0001");
    // The refusal happened before any financial write.
    expect(await counts()).toMatchObject({ expense_splits: 0, dues: 0 });
    expect((await rowOf(draft.id)).status).toBe("draft");
  });
});

// ── ordering and concurrency ─────────────────────────────────────────────────

describe("ordering and concurrency", () => {
  it("leaves exactly one winner when two approvals race", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    const results = await Promise.allSettled([
      approvalOf(fixture, draft.id, { expectedVersion: 1 }),
      approvalOf(fixture, draft.id, { expectedVersion: 1 }),
    ]);

    expect(
      results.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    const row = await rowOf(draft.id);
    expect(row.version).toBe(2);
    expect(row.approved_by).toBe(fixture.adminMemberId);
  });

  it("serialises approval against publication, one winner", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });

    const results = await Promise.allSettled([
      approvalOf(fixture, draft.id, { expectedVersion: 1 }),
      publishOf(fixture, draft.id, { expectedVersion: 1 }),
    ]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const row = await rowOf(draft.id);
    if (row.status === "published") {
      // The publish won; the approval saw a moved version and refused.
      expect(row.approved_by).toBeNull();
      expect(fulfilled[0]!.status).toBe("fulfilled");
    } else {
      // The approval won; the publish met an unapproved row and refused.
      expect(row.status).toBe("pending_approval");
      expect(row.approved_by).toBe(fixture.adminMemberId);
      const publication = await publishOf(fixture, draft.id, {
        expectedVersion: 2,
      });
      expect(publication.expense.status).toBe("published");
    }
    expect(await counts()).toMatchObject({ expense_splits: 4, dues: 4 });
  });

  it("keeps the approval after a refused publication, with no financial write", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, draft.id, { expectedVersion: 1 });
    const before = await counts();

    // The publication is refused on the lock — the caller held version 1 after the
    // approval committed version 2. Nothing is written and the approval survives,
    // which is what makes the retry a plain publish.
    const failure = await failureOf(
      publishOf(fixture, draft.id, { expectedVersion: 1 }),
    );
    expect(failure.code).toBe("VERSION_MISMATCH");
    expect(await counts()).toEqual(before);
    const row = await rowOf(draft.id);
    expect(row.status).toBe("pending_approval");
    expect(row.approved_by).toBe(fixture.adminMemberId);

    // The retry with the current version publishes.
    const publication = await publishOf(fixture, draft.id, {
      expectedVersion: 2,
    });
    expect(publication.expense.status).toBe("published");
    expect(await counts()).toMatchObject({ expense_splits: 4, dues: 4 });
  });
});

// ── the queue ────────────────────────────────────────────────────────────────

describe("the approval queue", () => {
  it("lists exactly the pending_approval entries, whatever else the filters say", async () => {
    const fixture = await seed();
    const pending = await createDraft(fixture, { amountPaise: 2_000_000 });
    await createDraft(fixture, { amountPaise: 400_000 });

    const queue = harness.app.get(ListApprovalQueueUseCase);
    const page = await queue.list(fixture.adminUserId, fixture.societyId, {
      status: "published",
    });

    expect(page.expenses.map((expense) => expense.id)).toEqual([pending.id]);
    expect(page.expenses[0]).toMatchObject({
      status: "pending_approval",
      createdBy: fixture.adminMemberId,
      approvedBy: null,
    });
  });

  it("shows an approved entry's stamps in the same queue", async () => {
    const fixture = await seed();
    const pending = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, pending.id, { expectedVersion: 1 });

    const queue = harness.app.get(ListApprovalQueueUseCase);
    const page = await queue.list(fixture.adminUserId, fixture.societyId, {});

    expect(page.expenses).toHaveLength(1);
    expect(page.expenses[0]).toMatchObject({
      id: pending.id,
      approvedBy: fixture.adminMemberId,
    });
    expect(page.expenses[0]!.approvedAt).not.toBeNull();
  });
});

// ── RPC safety and T069's invariants ─────────────────────────────────────────

describe("RPC safety and T069's invariants", () => {
  it("records the forward migration in the ledger", async () => {
    const rows = await owner<{ name: string }[]>`
      select name from ses_meta.migrations order by name
    `;
    expect(rows.map((row) => row.name)).toContain(
      "20261009120000_expense_approval.sql",
    );
  });

  it("declares exactly the result types its query returns", async () => {
    const [declared] = await owner<{ result: string }[]>`
      select pg_get_function_result(
        'public.expense_approve(uuid, uuid, integer)'::regprocedure
      ) as result
    `;
    const result = declared?.result ?? "";
    expect(result).toContain("payment_source character varying");
    expect(result).toContain("amount_paise text");
    expect(result).toContain("status text");
    expect(result).toContain("approved_at timestamp with time zone");
    expect(result).toContain("rejection_reason text");

    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    const rows = await harness.unitOfWork.transaction(
      { kind: "user", userId: fixture.adminUserId },
      (tx) =>
        tx.execute<{
          amount_paise: string;
          expense_date: string;
          status: string;
          version: string;
          approved_at: string;
          rejection_reason: string;
        }>(sql`
          select pg_typeof(v.amount_paise)::text as amount_paise,
                 pg_typeof(v.expense_date)::text as expense_date,
                 pg_typeof(v.status)::text as status,
                 pg_typeof(v.version)::text as version,
                 pg_typeof(v.approved_at)::text as approved_at,
                 pg_typeof(v.rejection_reason)::text as rejection_reason
            from public.expense_approve(
              ${draft.id}::uuid, ${fixture.societyId}::uuid, 1
            ) v
        `),
    );
    expect(rows[0]).toEqual({
      amount_paise: "text",
      expense_date: "text",
      status: "text",
      version: "integer",
      approved_at: "timestamp with time zone",
      rejection_reason: "text",
    });
  });

  it("writes no revision, no dues and no balances on approval or rejection", async () => {
    const fixture = await seed();
    const draft = await createDraft(fixture, { amountPaise: 2_000_000 });
    const before = await counts();

    await approvalOf(fixture, draft.id, { expectedVersion: 1 });
    const afterApproval = await counts();
    expect(afterApproval).toEqual(before);

    await rejectionOf(fixture, draft.id, { expectedVersion: 2 });
    expect(await counts()).toEqual(before);
  });

  it("leaves void behaviour and the published rows untouched", async () => {
    const fixture = await seed();
    const published = await createDraft(fixture, { amountPaise: 400_000 });
    await publishOf(fixture, published.id, { expectedVersion: 1 });
    const before = await counts();

    // A separate approval on a separate row writes nothing to the published bill.
    const other = await createDraft(fixture, { amountPaise: 2_000_000 });
    await approvalOf(fixture, other.id, { expectedVersion: 1 });

    expect(await counts()).toMatchObject({
      expenses: before["expenses"]! + 1,
      expense_splits: before["expense_splits"],
      dues: before["dues"],
      member_balances: before["member_balances"],
      expense_revisions: before["expense_revisions"],
    });
    expect((await rowOf(published.id)).status).toBe("published");
  });
});
