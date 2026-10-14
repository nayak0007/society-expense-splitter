import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  AUDIT_REDACTED,
  Expense,
  Money,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  attachmentError,
  paise,
  parseGstin,
  systemClock,
  weight,
} from "@ses/domain";
import type {
  ApartmentId,
  ApartmentRepository,
  AttachmentMembershipReader,
  AttachmentRepository,
  AuditEntry,
  BuildingRepository,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseCommentRepository,
  ExpenseDraftFields,
  ExpenseGstDetailsRepository,
  ExpenseId,
  ExpenseRepository,
  ExpenseSplitRepository,
  Gstin,
  InvitationRepository,
  MemberId,
  MemberRepository,
  MemberRole,
  PublishExpenseAllocation,
  SocietyId,
  SocietyRepository,
  StorageProvider,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { MEMBERSHIP_READER } from "../../src/common/authorization/membership-reader";
import { RequestContext } from "../../src/common/context/request-context";
import { buildAuditEntry } from "../../src/common/audit/audit-context";
import { AppConfig } from "../../src/config/app-config";
import { resolveMigrationsDir } from "../../src/infrastructure/database/migrations/runner";
import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";
import { STORAGE_PROVIDER } from "../../src/infrastructure/storage/storage.tokens";
import { ATTACHMENT_REPOSITORY } from "../../src/modules/attachments/application/attachment.tokens";
import { CompleteUploadUseCase } from "../../src/modules/attachments/application/use-cases/complete-upload.use-case";
import { PresignUploadUseCase } from "../../src/modules/attachments/application/use-cases/presign-upload.use-case";
import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import {
  EXPENSE_COMMENT_REPOSITORY,
  EXPENSE_GST_DETAILS_REPOSITORY,
  EXPENSE_REPOSITORY,
  EXPENSE_SPLIT_REPOSITORY,
} from "../../src/modules/expenses/application/expense.tokens";
import { DeleteDraftUseCase } from "../../src/modules/expenses/application/use-cases/delete-draft.use-case";
import { INVITATION_REPOSITORY } from "../../src/modules/invitations/application/invitation.tokens";
import { MEMBER_REPOSITORY } from "../../src/modules/members/application/member.tokens";
import { SOCIETY_REPOSITORY } from "../../src/modules/societies/application/society.tokens";
import {
  APARTMENT_REPOSITORY,
  BUILDING_REPOSITORY,
} from "../../src/modules/structure/application/structure.tokens";

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
 * The audit trail against real PostgreSQL — T050 Stage A, ADR-0014.
 *
 * ## What only this suite can prove
 *
 * The unit suite proves the redaction rule and the `@Audited()` declaration. Four
 * claims need a server:
 *
 *  1. **The privilege boundary.** `authenticated` holds no `INSERT`/`UPDATE`/
 *     `DELETE` on `audit_logs` and no `EXECUTE` on `write_audit_logs`; the writer
 *     is `ses_api`'s alone. A grant is only real in the catalog of a live server,
 *     and `has_table_privilege` against the running database is the assertion.
 *  2. **Transactional coupling.** The audit row and the business change commit
 *     together and roll back together, including when the *audit* write is the one
 *     that fails — which is the fail-closed direction ADR-0014 D1 requires.
 *  3. **Fail-closed duplicates.** A replay of an `operation_id` raises `23505` and
 *     takes the transaction with it, rather than silently de-duplicating.
 *  4. **Tenant isolation.** The read policy answers Admin / Treasurer / stranger
 *     differently, evaluated by a real `auth.uid()` under a real `SET ROLE`.
 *
 * Fixtures are written on the **owner** connection (they must exist before any
 * identity does); everything asserted about behaviour runs through `UnitOfWork` as
 * a real identity.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let unitOfWork: IntegrationHarness["unitOfWork"];

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  unitOfWork = harness.unitOfWork;
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

/** Reads one scalar from a transaction. */
async function scalar<T = string>(
  tx: TransactionContext,
  query: SQL,
): Promise<T | undefined> {
  const rows = (await tx.execute(query)) as unknown as readonly Record<
    string,
    unknown
  >[];
  return rows[0]?.["value"] as T | undefined;
}

/**
 * The message chain of a rejection, joined.
 *
 * `tx.execute` failures arrive as a Drizzle wrapper whose own message is
 * "Failed query: …" and whose `cause` is the real `PostgresError` — so asserting a
 * pattern against `error.message` alone would never see `permission denied` or a
 * constraint name. Walking the cause chain is what makes the assertion about the
 * database's answer rather than Drizzle's wrapper.
 */
async function rejectionMessage(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/**
 * The runtime-capability guard, read from the migration that ships it.
 *
 * The hosted-topology test below must exercise the **exact** SQL the migration
 * applies, not a restatement of it — a copy would be free to drift from what
 * ships and the test would pass while the migration did something else. The block
 * is fenced by `>>> audit-writer-membership-guard` / `<<< …` markers in
 * `supabase/migrations/20261015120000_audit_logs.sql` for exactly this. A missing
 * marker fails loudly rather than silently testing nothing.
 */
function readMembershipGuard(): string {
  const file = join(resolveMigrationsDir(), "20261015120000_audit_logs.sql");
  const text = readFileSync(file, "utf8");
  const openMark = ">>> audit-writer-membership-guard";
  const closeMark = "<<< audit-writer-membership-guard";
  const openAt = text.indexOf(openMark);
  const closeAt = text.indexOf(closeMark);
  if (openAt < 0 || closeAt < 0 || closeAt < openAt) {
    throw new Error(
      `audit-writer-membership-guard markers not found in ${file}: the migration changed shape and this test must change with it.`,
    );
  }
  return text
    .slice(text.indexOf("\n", openAt) + 1, text.lastIndexOf("\n", closeAt))
    .trim();
}

/** How many audit rows the owner sees — the truth, independent of any policy. */
async function auditRowCount(): Promise<number> {
  const [row] = await owner<{ count: string }[]>`
    select count(*)::text as count from public.audit_logs
  `;
  return Number(row?.count ?? "0");
}

function entryFor(
  societyId: string,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    operationId: randomUUID(),
    societyId,
    // Deliberately a lie: `UnitOfWork` overwrites the actor with the transaction's
    // identity, which is one half of what the writer's check makes structural.
    actorUserId: null,
    actorRole: null,
    category: "other",
    action: "society.updated",
    entityType: "society",
    entityId: societyId,
    before: null,
    after: null,
    metadata: {},
    ...overrides,
  };
}

/** Creates a society and returns its id, as the given user. */
async function createSociety(
  tx: TransactionContext,
  name: string,
): Promise<string | undefined> {
  return scalar<string>(
    tx,
    // `::text` is load-bearing: `jsonb_build_object` is variadic `any`, so an
    // untyped bind parameter gives `could not determine data type of parameter $1`.
    sql`select (public.society_create(jsonb_build_object(
      'name', ${name}::text, 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
    )))->'society'->>'id' as value`,
  );
}

describe("the privilege boundary (asserted against the live catalog)", () => {
  it("gives `authenticated` read and nothing else on audit_logs", async () => {
    const [row] = await owner<
      { ins: boolean; upd: boolean; del: boolean; sel: boolean }[]
    >`
      select has_table_privilege('authenticated','public.audit_logs','INSERT') as ins,
             has_table_privilege('authenticated','public.audit_logs','UPDATE') as upd,
             has_table_privilege('authenticated','public.audit_logs','DELETE') as del,
             has_table_privilege('authenticated','public.audit_logs','SELECT') as sel
    `;

    expect(row).toEqual({ ins: false, upd: false, del: false, sel: true });
  });

  it("grants the writer to `ses_api` alone", async () => {
    const [row] = await owner<
      {
        authenticated: boolean;
        anon: boolean;
        service_role: boolean;
        ses_api: boolean;
        authenticated_is_member: boolean;
        authenticator_is_member: boolean;
      }[]
    >`
      select has_function_privilege('authenticated','public.write_audit_logs(jsonb)','EXECUTE') as authenticated,
             has_function_privilege('anon','public.write_audit_logs(jsonb)','EXECUTE') as anon,
             has_function_privilege('service_role','public.write_audit_logs(jsonb)','EXECUTE') as service_role,
             has_function_privilege('ses_api','public.write_audit_logs(jsonb)','EXECUTE') as ses_api,
             pg_has_role('authenticated','ses_api','MEMBER') as authenticated_is_member,
             pg_has_role('authenticator','ses_api','MEMBER') as authenticator_is_member
    `;

    expect(row?.authenticated).toBe(false);
    expect(row?.anon).toBe(false);
    // The platform's BYPASSRLS admin role is deliberately locked out too
    // (ADR-0014 D8) — REVOKEd from `service_role` where every other table keeps it.
    expect(row?.service_role).toBe(false);
    expect(row?.ses_api).toBe(true);
    // The regression guard for the hosted trap ADR-0014 records: a stray
    // `GRANT ses_api TO authenticated` would silently open the writer.
    expect(row?.authenticated_is_member).toBe(false);
    // On a stock host (this suite's topology) the API's login holds the capability,
    // so the write path works; the hosted topology revokes it (next test).
    expect(row?.authenticator_is_member).toBe(true);
  });

  it("owns the table and the writer with the audit role, and enables RLS without forcing it", async () => {
    const [row] = await owner<
      {
        tableowner: string;
        writer_owner: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >`
      select (select tableowner from pg_tables
               where schemaname = 'public' and tablename = 'audit_logs') as tableowner,
             (select pg_get_userbyid(proowner) from pg_proc
               where proname = 'write_audit_logs') as writer_owner,
             (select relrowsecurity from pg_class where relname = 'audit_logs') as relrowsecurity,
             (select relforcerowsecurity from pg_class where relname = 'audit_logs') as relforcerowsecurity
    `;

    expect(row?.tableowner).toBe("ses_audit_owner");
    expect(row?.writer_owner).toBe("ses_audit_owner");
    expect(row?.relrowsecurity).toBe(true);
    // FORCE would lock the definer's own insert out; the write control is the
    // function privilege, not a policy.
    expect(row?.relforcerowsecurity).toBe(false);
  });

  it("refuses a direct INSERT as the business role, in a real transaction", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "inserter@audit.ses.test", "Inserter"),
    );

    const message = await rejectionMessage(
      unitOfWork.transaction({ kind: "user", userId }, (tx) =>
        tx.execute(sql`
          insert into public.audit_logs (society_id, category, action, entity_type, operation_id)
          values (gen_random_uuid(), 'other', 'society.updated', 'society', gen_random_uuid())
        `),
      ),
    );
    expect(message).toMatch(/permission denied for table audit_logs/i);
  });

  it("refuses a direct writer call as the business role", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "caller@audit.ses.test", "Caller"),
    );

    const message = await rejectionMessage(
      unitOfWork.transaction({ kind: "user", userId }, (tx) =>
        tx.execute(sql`select public.write_audit_logs('[]'::jsonb)`),
      ),
    );
    expect(message).toMatch(/permission denied for function write_audit_logs/i);
  });
});

/**
 * The capability grant is decided by **role topology**, not by a hostname or an
 * environment variable — the same discriminator `bootstrap.sql` uses. These two
 * tests pin both end states against the live catalog, the second by replaying the
 * migration's own guard block (read from the file) under a simulated hosted role
 * set, so the shipped SQL itself is what is exercised.
 */
describe("the runtime-capability guard under both role topologies", () => {
  it("revokes the writer from `authenticator` under the hosted topology", async () => {
    const guard = readMembershipGuard();

    // Materialise the hosted discriminator: the platform's auth role. Nothing else
    // is needed — the guard keys only on this role's presence, so this is the exact
    // condition a hosted project presents when the migration runs.
    await owner.unsafe("create role supabase_auth_admin nologin");
    try {
      await owner.unsafe(guard);

      const [row] = await owner<{ execute: boolean; member: boolean }[]>`
        select has_function_privilege('authenticator','public.write_audit_logs(jsonb)','EXECUTE') as execute,
               pg_has_role('authenticator','ses_api','MEMBER') as member
      `;
      // Hosted `authenticator` is PostgREST's login too: it must hold neither the
      // membership nor the EXECUTE, or a suitably-signed token could write audit rows.
      expect(row?.member).toBe(false);
      expect(row?.execute).toBe(false);

      // And the business/platform roles are still locked out under this topology.
      const [roles] = await owner<
        { authenticated: boolean; anon: boolean; service_role: boolean }[]
      >`
        select has_function_privilege('authenticated','public.write_audit_logs(jsonb)','EXECUTE') as authenticated,
               has_function_privilege('anon','public.write_audit_logs(jsonb)','EXECUTE') as anon,
               has_function_privilege('service_role','public.write_audit_logs(jsonb)','EXECUTE') as service_role
      `;
      expect(roles).toEqual({
        authenticated: false,
        anon: false,
        service_role: false,
      });
    } finally {
      // Converge back to the stock-host topology, so every other test in this file
      // sees the state the suite's own migrations established.
      await owner.unsafe("drop role if exists supabase_auth_admin");
      await owner.unsafe(guard);
    }
  });
});

describe("the transactional seam", () => {
  it("commits the business change and its audit entry together", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "together@audit.ses.test", "Together"),
    );

    const societyId = await unitOfWork.transaction(
      { kind: "user", userId },
      (tx) => createSociety(tx, "Together Court"),
      (id) => [entryFor(id as string, { after: { name: "Together Court" } })],
    );

    expect(societyId).toBeTruthy();
    expect(await auditRowCount()).toBe(1);
  });

  it("records several operations in one transaction", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "many@audit.ses.test", "Many"),
    );

    await unitOfWork.transaction(
      { kind: "user", userId },
      (tx) => createSociety(tx, "Many Court"),
      (id) => [
        entryFor(id as string, { action: "expense.created" }),
        entryFor(id as string, { action: "expense.updated" }),
        entryFor(id as string, { action: "expense.deleted" }),
      ],
    );

    expect(await auditRowCount()).toBe(3);
  });

  it("rolls the business change back when the audit write fails", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "failclosed@audit.ses.test", "FailClosed"),
    );

    // The society exists, but the audit entry names a different one — a foreign key
    // violation the writer raises. The transaction must lose *both* writes.
    const message = await rejectionMessage(
      unitOfWork.transaction(
        { kind: "user", userId },
        (tx) => createSociety(tx, "Doomed Court"),
        () => [entryFor(randomUUID())],
      ),
    );
    expect(message).toMatch(/audit_logs_society_id_fkey/);

    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.societies where name = 'Doomed Court'
    `;
    expect(Number(row?.count)).toBe(0);
    expect(await auditRowCount()).toBe(0);
  });

  it("records nothing when the business change itself fails", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "nobusiness@audit.ses.test", "NoBusiness"),
    );

    await expect(
      unitOfWork.transaction(
        { kind: "user", userId },
        async () => {
          throw new Error("business refusal");
        },
        () => [entryFor(randomUUID())],
      ),
    ).rejects.toThrow("business refusal");

    expect(await auditRowCount()).toBe(0);
  });

  it("fails closed on a duplicate operation id and does not de-duplicate silently", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "dupe@audit.ses.test", "Dupe"),
    );
    const operationId = randomUUID();

    const societyId = await unitOfWork.transaction(
      { kind: "user", userId },
      (tx) => createSociety(tx, "Dupe Court"),
      (id) => [entryFor(id as string, { operationId })],
    );

    // A replay of the same operation, with a *new* business write: the unique
    // constraint must take the whole transaction down.
    const message = await rejectionMessage(
      unitOfWork.transaction(
        { kind: "user", userId },
        (tx) => createSociety(tx, "Replayed Court"),
        (id) => [entryFor(id as string, { operationId })],
      ),
    );
    expect(message).toMatch(/uq_audit_logs_operation_id|duplicate key/i);

    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.societies where name = 'Replayed Court'
    `;
    expect(Number(row?.count)).toBe(0);
    // One row, not two: the replay created no duplicate.
    expect(await auditRowCount()).toBe(1);
    expect(societyId).toBeTruthy();
  });

  it("refuses an entry whose actor is not the transaction's identity", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "forger@audit.ses.test", "Forger"),
    );
    const rogue = {
      operationId: randomUUID(),
      societyId: randomUUID(),
      actorUserId: randomUUID(),
      category: "other",
      action: "society.updated",
      entityType: "society",
    };

    // The writer is not reachable as `authenticated`, so the check is exercised the
    // only way a holder of `ses_api` could: switch to the capability and call it
    // with somebody else's id.
    const message = await rejectionMessage(
      unitOfWork.transaction({ kind: "user", userId }, async (tx) => {
        await createSociety(tx, "Forged Court");
        await tx.execute(sql`reset role`);
        await tx.execute(sql`set local role ses_api`);
        await tx.execute(
          sql`select public.write_audit_logs(${JSON.stringify([rogue])}::jsonb)`,
        );
      }),
    );
    expect(message).toMatch(/AUDIT_ACTOR_MISMATCH/);

    expect(await auditRowCount()).toBe(0);
  });

  it("persists the redacted payload, never the original", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "redact@audit.ses.test", "Redact"),
    );

    await unitOfWork.transaction(
      { kind: "user", userId },
      (tx) => createSociety(tx, "Redact Court"),
      (id) => [
        entryFor(id as string, {
          action: "expense.created",
          after: { title: "Water bill", refreshToken: "leak-me" },
          metadata: { phone: "+91 90000 00000" },
        }),
      ],
    );

    const [row] = await owner<
      { after: Record<string, unknown>; metadata: Record<string, unknown> }[]
    >`
      select "after", metadata from public.audit_logs limit 1
    `;
    expect(row?.after).toEqual({
      title: "Water bill",
      refreshToken: AUDIT_REDACTED,
    });
    expect(row?.metadata?.["phone"]).toBe(AUDIT_REDACTED);
    // The literal secret is nowhere in the row.
    expect(JSON.stringify(row)).not.toContain("leak-me");
  });

  it("takes the actor and request facts from the server-side context", async () => {
    const userId = asUserId(
      await createLocalUser(owner, "context@audit.ses.test", "Context"),
    );

    await RequestContext.run(
      {
        requestId: "req-integration",
        userId,
        member: undefined,
        ip: "198.51.100.9",
        userAgent: "Resident360/test",
        audited: [],
      },
      () =>
        unitOfWork.transaction(
          { kind: "user", userId },
          (tx) => createSociety(tx, "Context Court"),
          (id) => [
            buildAuditEntry({
              societyId: id as string,
              category: "other",
              action: "society.updated",
              entityType: "society",
              entityId: id as string,
            }),
          ],
        ),
    );

    const [row] = await owner<
      {
        actor_user_id: string;
        metadata: Record<string, unknown>;
      }[]
    >`
      select actor_user_id, metadata from public.audit_logs limit 1
    `;
    expect(row?.actor_user_id).toBe(userId);
    expect(row?.metadata).toEqual({
      requestId: "req-integration",
      ip: "198.51.100.9",
      userAgent: "Resident360/test",
    });
  });

  it("represents an anonymous transaction with a null actor", async () => {
    // A public, unauthenticated path that records something: the actor is null and
    // the writer's check passes because the transaction has no identity either.
    const creator = await createLocalUser(
      owner,
      "anon-creator@audit.ses.test",
      "Creator",
    );
    const [society] = await owner<{ id: string }[]>`
      insert into public.societies (name, city, state, join_code, created_by)
      values ('Anon Court', 'Pune', 'MH', 'T5KAN2', ${creator}::uuid)
      returning id
    `;

    await unitOfWork.transaction(
      { kind: "anonymous" },
      async (tx) => {
        await tx.execute(sql`select 1`);
      },
      () => [entryFor(society!.id)],
    );

    const [written] = await owner<{ actor_user_id: string | null }[]>`
      select actor_user_id from public.audit_logs limit 1
    `;
    expect(written?.actor_user_id).toBeNull();
  });
});

describe("tenant isolation and the read policy", () => {
  interface Fixture {
    readonly society: SocietyFixture;
    readonly treasurerUserId: UserId;
    readonly strangerUserId: UserId;
    readonly other: SocietyFixture;
  }

  async function seed(): Promise<Fixture> {
    const society = await seedSociety(
      harness,
      "Audit Court",
      "admin@audit.ses.test",
    );
    const treasurerUserId = asUserId(
      await createLocalUser(owner, "treasurer@audit.ses.test", "Treasurer"),
    );
    await insertMember(owner, society.societyId, {
      userId: treasurerUserId,
      role: "treasurer",
      displayName: "Treasurer",
    });
    const strangerUserId = asUserId(
      await createLocalUser(owner, "stranger@audit.ses.test", "Stranger"),
    );
    const other = await seedSociety(
      harness,
      "Other Audit Court",
      "admin@other-audit.ses.test",
    );

    // Fixtures written as the owner — this is setup, not the behaviour under test.
    await owner`
      insert into public.audit_logs (society_id, category, action, entity_type, operation_id)
      values
        (${society.societyId}::uuid, 'financial', 'expense.created', 'expense', gen_random_uuid()),
        (${society.societyId}::uuid, 'other', 'member.role_assigned', 'member', gen_random_uuid()),
        (${other.societyId}::uuid, 'financial', 'expense.created', 'expense', gen_random_uuid())
    `;

    return { society, treasurerUserId, strangerUserId, other };
  }

  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seed();
  });

  async function visible(userId: UserId): Promise<number> {
    const count = await unitOfWork.transaction({ kind: "user", userId }, (tx) =>
      scalar<string>(
        tx,
        sql`select count(*)::text as value from public.audit_logs`,
      ),
    );
    return Number(count ?? "0");
  }

  it("shows an Admin the whole of their own society's log and no other", async () => {
    await expect(visible(fixture.society.adminUserId)).resolves.toBe(2);
  });

  it("shows a Treasurer the financial half only", async () => {
    await expect(visible(fixture.treasurerUserId)).resolves.toBe(1);
  });

  it("shows a stranger nothing", async () => {
    await expect(visible(fixture.strangerUserId)).resolves.toBe(0);
  });

  it("shows another society's Admin nothing of this one", async () => {
    await expect(visible(fixture.other.adminUserId)).resolves.toBe(1);
  });
});

describe("society deletion", () => {
  it("is refused while audit history exists", async () => {
    const society = await seedSociety(
      harness,
      "Restic Court",
      "admin@restrict.ses.test",
    );
    await owner`
      insert into public.audit_logs (society_id, category, action, entity_type, operation_id)
      values (${society.societyId}::uuid, 'other', 'society.updated', 'society', gen_random_uuid())
    `;

    // RESTRICT raises `23001`, not the generic `23503`, so the assertion is on the
    // constraint name rather than only the SQLSTATE class.
    await expect(
      owner`delete from public.societies where id = ${society.societyId}::uuid`,
    ).rejects.toThrow(/audit_logs_society_id_fkey/);
  });
});

describe("the audit trail of the representative mutations", () => {
  let fixture: SocietyFixture;
  let members: MemberRepository;
  let expenses: ExpenseRepository;
  let categories: ExpenseCategoryRepository;

  beforeAll(() => {
    members = harness.app.get<MemberRepository>(MEMBER_REPOSITORY);
    expenses = harness.app.get<ExpenseRepository>(EXPENSE_REPOSITORY);
    categories = harness.app.get<ExpenseCategoryRepository>(
      EXPENSE_CATEGORY_REPOSITORY,
    );
  });

  beforeEach(async () => {
    fixture = await seedSociety(
      harness,
      "Repo Court",
      "admin@repo-audit.ses.test",
    );
  });

  /**
   * Runs a repository call inside a request context, as the admin.
   *
   * The role on the audit row comes from the server-side context (ADR-0014 D5), not
   * from the caller's arguments — so a test that called the repository without one
   * would record `null` and prove nothing about where the role is read from.
   */
  function asAdminRequest<T>(work: () => Promise<T>): Promise<T> {
    return RequestContext.run(
      {
        requestId: "req-repo-audit",
        userId: fixture.adminUserId,
        member: {
          membershipId: fixture.adminMemberId,
          societyId: fixture.societyId,
          role: "admin",
          status: "active",
        },
        ip: undefined,
        userAgent: undefined,
        audited: [],
      },
      work,
    );
  }

  async function auditRows(): Promise<
    readonly {
      action: string;
      before: unknown;
      after: unknown;
      actor_role: string | null;
    }[]
  > {
    return (await owner`
      select action, "before", "after", actor_role::text as actor_role
        from public.audit_logs
       order by id
    `) as unknown as readonly {
      action: string;
      before: unknown;
      after: unknown;
      actor_role: string | null;
    }[];
  }

  it("records a role assignment with the before and after role", async () => {
    const memberId = await insertMember(owner, fixture.societyId, {
      role: "resident",
      displayName: "Role Target",
    });

    await asAdminRequest(() =>
      members.setRole(
        asMemberId(memberId),
        fixture.societyId,
        "treasurer",
        fixture.adminUserId,
      ),
    );

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("member.role_assigned");
    expect(rows[0]?.["before"]).toMatchObject({ role: "resident" });
    expect(rows[0]?.["after"]).toMatchObject({ role: "treasurer" });
    expect(rows[0]?.actor_role).toBe("admin");
  });

  it("records a revocation as a revocation, not as an assignment", async () => {
    const memberId = await insertMember(owner, fixture.societyId, {
      role: "treasurer",
      displayName: "Revoke Target",
    });

    await asAdminRequest(() =>
      members.setRole(
        asMemberId(memberId),
        fixture.societyId,
        "resident",
        fixture.adminUserId,
      ),
    );

    const rows = await auditRows();
    expect(rows[0]?.action).toBe("member.role_revoked");
  });

  it("records a removal with the status it replaced", async () => {
    const memberId = await insertMember(owner, fixture.societyId, {
      role: "resident",
      displayName: "Remove Target",
    });

    await members.remove(
      asMemberId(memberId),
      fixture.societyId,
      fixture.adminUserId,
    );

    const rows = await auditRows();
    expect(rows[0]?.action).toBe("member.removed");
    expect(rows[0]?.["after"]).toMatchObject({ status: "removed" });
  });

  it("records the draft lifecycle, and records nothing for a refused update", async () => {
    const categoryId = await categoryIdOf(
      fixture.societyId,
      fixture.adminUserId,
      "Lift",
    );

    const created = await expenses.create(
      {
        expense: expenseFor(fixture, categoryId, "Audited Lift"),
        fields: fieldsFor(),
      },
      fixture.adminUserId,
    );

    const updated = await expenses.update(
      created.id,
      fixture.societyId,
      created.version,
      {
        expense: expenseFor(fixture, categoryId, "Audited Lift (revised)"),
        fields: fieldsFor(),
      },
      fixture.adminUserId,
    );

    // A stale version: the write matches no row, answers a domain error, and the
    // transaction carries no audit entry with it.
    await expect(
      expenses.update(
        created.id,
        fixture.societyId,
        created.version,
        {
          expense: expenseFor(fixture, categoryId, "Lost race"),
          fields: fieldsFor(),
        },
        fixture.adminUserId,
      ),
    ).rejects.toThrow();

    await expenses.deleteDraft(
      updated.id,
      fixture.societyId,
      fixture.adminUserId,
    );

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      "expense.created",
      "expense.updated",
      "expense.deleted",
    ]);
    expect(rows[0]?.["before"]).toBeNull();
    expect(rows[1]?.["before"]).toMatchObject({ title: "Audited Lift" });
    expect(rows[1]?.["after"]).toMatchObject({
      title: "Audited Lift (revised)",
    });
    expect(rows[2]?.["after"]).toBeNull();
  });

  async function categoryIdOf(
    societyId: SocietyId,
    actor: UserId,
    name: string,
  ): Promise<ExpenseCategoryId> {
    const listed = await categories.listCategories(societyId, actor);
    const category = listed.find((entry) => entry.name === name);
    if (category === undefined) {
      throw new Error(`The seeded category "${name}" is missing.`);
    }
    return category.id;
  }

  function expenseFor(
    society: SocietyFixture,
    categoryId: ExpenseCategoryId,
    title: string,
  ): Expense {
    const result = Expense.create({
      id: asExpenseId(randomUUID()),
      societyId: society.societyId,
      categoryId: asExpenseCategoryId(categoryId),
      title,
      amount: Money.fromPaise(paise(450_000n)),
      expenseDate: "2026-09-30",
      createdBy: asMemberId(society.adminMemberId),
      clock: systemClock,
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  function fieldsFor(
    overrides: Partial<ExpenseDraftFields> = {},
  ): ExpenseDraftFields {
    return {
      description: null,
      vendorName: null,
      paymentSource: "society_account",
      paidByMemberId: null,
      splitStrategy: "equal",
      apartmentBasis: null,
      splitConfig: {},
      participantSelector: {
        scope: "society",
        includeVacant: null,
        ownerOnly: false,
      },
      ...overrides,
    };
  }
});

describe("the audit trail of the financial lifecycle", () => {
  let fixture: SocietyFixture & { readonly categoryId: ExpenseCategoryId };
  let splits: ExpenseSplitRepository;
  let expenses: ExpenseRepository;

  beforeAll(() => {
    splits = harness.app.get<ExpenseSplitRepository>(EXPENSE_SPLIT_REPOSITORY);
    expenses = harness.app.get<ExpenseRepository>(EXPENSE_REPOSITORY);
  });

  beforeEach(async () => {
    const society = await seedSociety(
      harness,
      "Ledger Court",
      "admin@ledger-audit.ses.test",
    );
    const categories = harness.app.get<ExpenseCategoryRepository>(
      EXPENSE_CATEGORY_REPOSITORY,
    );
    const listed = await categories.listCategories(
      society.societyId,
      society.adminUserId,
    );
    const category = listed.find((entry) => entry.name === "Lift");
    if (category === undefined) {
      throw new Error('The seeded category "Lift" is missing.');
    }
    fixture = { ...society, categoryId: category.id };
  });

  /** A billable flat plus its owner, inserted as the owner. */
  async function insertFlat(): Promise<{
    readonly apartmentId: ApartmentId;
    readonly memberId: MemberId;
  }> {
    const buildingId = await insertBuilding(
      owner,
      fixture.societyId,
      "Block A",
    );
    const apartmentId = await insertApartment(
      owner,
      fixture.societyId,
      buildingId,
      "A-101",
    );
    const memberId = asMemberId(
      await insertMember(owner, fixture.societyId, {
        apartmentId,
        occupancy: "owner_occupied",
        isPrimary: true,
        displayName: "Owner A-101",
      }),
    );
    return { apartmentId, memberId };
  }

  /** An expense row in the requested lifecycle state, inserted as the owner. */
  async function insertExpense(
    status: "draft" | "pending_approval",
    amountPaise: bigint,
  ): Promise<ExpenseId> {
    const [row] = await owner<{ id: string }[]>`
      insert into public.expenses (
        society_id, category_id, title, amount_paise, expense_date,
        split_strategy, apartment_basis, status, created_by, version
      )
      values (
        ${fixture.societyId}::uuid,
        ${fixture.categoryId}::uuid,
        'Ledger Bill',
        ${amountPaise.toString()}::bigint,
        '2026-09-30'::date,
        'equal'::public.split_strategy,
        null,
        ${status}::public.expense_status,
        ${fixture.adminMemberId}::uuid,
        1
      )
      returning id
    `;
    return asExpenseId(row!.id);
  }

  function allocationFor(
    flat: { readonly apartmentId: ApartmentId; readonly memberId: MemberId },
    amountPaise: bigint,
  ): PublishExpenseAllocation {
    return {
      memberId: flat.memberId,
      apartmentId: flat.apartmentId,
      amount: Money.fromPaise(paise(amountPaise)),
      weight: weight(1),
      percent: null,
      assignedReason: null,
      snapshot: { memberName: "Owner A-101", apartmentNumber: "A-101" },
    };
  }

  let keyCounter = 0;
  function nextKey(): string {
    keyCounter += 1;
    return `ledger-audit-key-${String(keyCounter)}`;
  }

  async function actions(): Promise<readonly string[]> {
    const rows = await owner<{ action: string }[]>`
      select action from public.audit_logs order by id
    `;
    return rows.map((row) => row.action);
  }

  async function rowFor(
    action: string,
  ): Promise<{ before: unknown; after: unknown }> {
    const [row] = await owner<{ before: unknown; after: unknown }[]>`
      select "before", "after" from public.audit_logs
       where action = ${action} order by id limit 1
    `;
    if (row === undefined) throw new Error(`No audit row for ${action}.`);
    return row;
  }

  it("records a publication with its pre- and post-publication state", async () => {
    const flat = await insertFlat();
    const expenseId = await insertExpense("draft", 450_000n);

    await splits.publish(
      expenseId,
      fixture.societyId,
      {
        expectedVersion: 1,
        idempotencyKey: nextKey(),
        requestHash: "ledger-hash",
        allocations: [allocationFor(flat, 450_000n)],
      },
      fixture.adminUserId,
    );

    expect(await actions()).toEqual(["expense.published"]);
    const row = await rowFor("expense.published");
    expect(row.before).toMatchObject({ status: "draft" });
    expect(row.after).toMatchObject({ status: "published" });
  });

  it("writes no second row when the same publication key is replayed", async () => {
    const flat = await insertFlat();
    const expenseId = await insertExpense("draft", 450_000n);
    const input = {
      expectedVersion: 1,
      idempotencyKey: nextKey(),
      requestHash: "ledger-hash",
      allocations: [allocationFor(flat, 450_000n)],
    };

    const first = await splits.publish(
      expenseId,
      fixture.societyId,
      input,
      fixture.adminUserId,
    );
    const replay = await splits.publish(
      expenseId,
      fixture.societyId,
      input,
      fixture.adminUserId,
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(await actions()).toEqual(["expense.published"]);
  });

  it("records a recalculation and a void as their own actions", async () => {
    const flat = await insertFlat();
    const expenseId = await insertExpense("draft", 450_000n);

    const published = await splits.publish(
      expenseId,
      fixture.societyId,
      {
        expectedVersion: 1,
        idempotencyKey: nextKey(),
        requestHash: "ledger-hash",
        allocations: [allocationFor(flat, 450_000n)],
      },
      fixture.adminUserId,
    );

    await splits.recalculate(
      expenseId,
      fixture.societyId,
      {
        expectedVersion: published.expense.version,
        fields: { title: "Ledger Bill (revised)" },
        allocations: [allocationFor(flat, 450_000n)],
      },
      fixture.adminUserId,
    );

    const [recalculated] = await owner<{ version: number }[]>`
      select version from public.expenses where id = ${expenseId}::uuid
    `;
    await splits.voidExpense(
      expenseId,
      fixture.societyId,
      {
        expectedVersion: recalculated!.version,
        reason: "Duplicate charge raised by mistake.",
      },
      fixture.adminUserId,
    );

    expect(await actions()).toEqual([
      "expense.published",
      "expense.recalculated",
      "expense.voided",
    ]);
  });

  it("records an approval and a rejection through the decision RPCs", async () => {
    const approveId = await insertExpense("pending_approval", 1_500_000n);
    await expenses.approve(
      approveId,
      fixture.societyId,
      { expectedVersion: 1 },
      fixture.adminUserId,
    );

    const rejectId = await insertExpense("pending_approval", 1_500_000n);
    await expenses.reject(
      rejectId,
      fixture.societyId,
      { expectedVersion: 1, reason: "Not approved in this cycle." },
      fixture.adminUserId,
    );

    expect(await actions()).toEqual(["expense.approved", "expense.rejected"]);
    expect((await rowFor("expense.rejected")).after).toMatchObject({
      status: "draft",
    });
  });

  it("records nothing when the business change is refused", async () => {
    const flat = await insertFlat();
    const expenseId = await insertExpense("draft", 450_000n);
    await splits.publish(
      expenseId,
      fixture.societyId,
      {
        expectedVersion: 1,
        idempotencyKey: nextKey(),
        requestHash: "ledger-hash",
        allocations: [allocationFor(flat, 450_000n)],
      },
      fixture.adminUserId,
    );

    // A second publish with a fresh key meets a terminal published row: a refusal
    // that must leave no audit row behind.
    await expect(
      splits.publish(
        expenseId,
        fixture.societyId,
        {
          expectedVersion: 2,
          idempotencyKey: nextKey(),
          requestHash: "ledger-hash-2",
          allocations: [allocationFor(flat, 450_000n)],
        },
        fixture.adminUserId,
      ),
    ).rejects.toThrow();
    expect(await actions()).toEqual(["expense.published"]);
  });
});

// ── Stage B: the remaining mandated mutations ───────────────────────────────

describe("the audit trail of memberships, invitations and structure", () => {
  let fixture: SocietyFixture;
  let members: MemberRepository;
  let invitations: InvitationRepository;
  let buildings: BuildingRepository;
  let apartments: ApartmentRepository;

  beforeAll(() => {
    members = harness.app.get<MemberRepository>(MEMBER_REPOSITORY);
    invitations = harness.app.get<InvitationRepository>(INVITATION_REPOSITORY);
    buildings = harness.app.get<BuildingRepository>(BUILDING_REPOSITORY);
    apartments = harness.app.get<ApartmentRepository>(APARTMENT_REPOSITORY);
  });

  beforeEach(async () => {
    fixture = await seedSociety(
      harness,
      "Stage B Court",
      "admin@stage-b-audit.ses.test",
    );
  });

  /**
   * The admin's request context, for the same reason the block above needs one:
   * the role and `requestId` on the row come from the server-side context.
   */
  function asAdminRequest<T>(work: () => Promise<T>): Promise<T> {
    return RequestContext.run(
      {
        requestId: "req-stage-b-audit",
        userId: fixture.adminUserId,
        member: {
          membershipId: fixture.adminMemberId,
          societyId: fixture.societyId,
          role: "admin",
          status: "active",
        },
        ip: undefined,
        userAgent: undefined,
        audited: [],
      },
      work,
    );
  }

  /** Every persisted action, in insertion order — the log's own order. */
  async function actions(): Promise<readonly string[]> {
    const rows = await owner<{ action: string }[]>`
      select action from public.audit_logs order by id
    `;
    return rows.map((row) => row.action);
  }

  async function beforeOf(action: string): Promise<unknown> {
    const [row] = await owner<{ before: unknown }[]>`
      select "before" from public.audit_logs where action = ${action} order by id
    `;
    if (row === undefined) throw new Error(`No audit row for ${action}.`);
    return row.before;
  }

  it("records a creation, an edit, a suspension and a reactivation as four actions", async () => {
    const created = await asAdminRequest(() =>
      members.create(
        fixture.societyId,
        { displayName: "Audited Resident", phone: "+919000000101" },
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      members.update(
        created.id,
        fixture.societyId,
        { displayName: "Audited Resident (renamed)" },
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      members.setStatus(
        created.id,
        fixture.societyId,
        "inactive",
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      members.setStatus(
        created.id,
        fixture.societyId,
        "active",
        fixture.adminUserId,
      ),
    );

    expect(await actions()).toEqual([
      "member.created",
      "member.updated",
      "member.suspended",
      "member.reactivated",
    ]);
    // The edit's `before` is the pre-edit state, read inside the same transaction.
    expect(await beforeOf("member.updated")).toMatchObject({
      status: "active",
      role: "resident",
    });
  });

  it("records a building and each of its flats as its own row", async () => {
    const building = await asAdminRequest(() =>
      buildings.create(
        fixture.societyId,
        { name: "Block Z" },
        fixture.adminUserId,
      ),
    );

    const apartment = await asAdminRequest(() =>
      apartments.create(
        building.id,
        fixture.societyId,
        { apartmentNumber: "Z-101" },
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      apartments.update(
        apartment.id,
        fixture.societyId,
        { floor: 3 },
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      apartments.remove(apartment.id, fixture.societyId, fixture.adminUserId),
    );

    expect(await actions()).toEqual([
      "building.created",
      "apartment.created",
      "apartment.updated",
      "apartment.deleted",
    ]);
    expect(await beforeOf("apartment.updated")).toMatchObject({
      apartmentNumber: "Z-101",
      floor: null,
    });
  });

  it("records each flat of a bulk create individually, and the batch shares one request id", async () => {
    const building = await asAdminRequest(() =>
      buildings.create(
        fixture.societyId,
        { name: "Block Y" },
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      apartments.createMany(
        building.id,
        fixture.societyId,
        [{ apartmentNumber: "Y-101" }, { apartmentNumber: "Y-102" }],
        fixture.adminUserId,
      ),
    );

    expect(await actions()).toEqual([
      "building.created",
      "apartment.created",
      "apartment.created",
    ]);

    // `requestId` lives in `metadata` (T050 put the trusted request facts there
    // rather than in three columns), so the batch identifier is that key.
    const rows = await owner<
      { request_id: string | null; entity_id: string }[]
    >`
      select metadata ->> 'requestId' as request_id,
             entity_id::text as entity_id
        from public.audit_logs
       where action = 'apartment.created'
       order by id
    `;
    expect(rows).toHaveLength(2);
    // Distinct entities, one shared request id: that pair *is* the batch.
    expect(new Set(rows.map((row) => row.entity_id)).size).toBe(2);
    expect(rows.every((row) => row.request_id === "req-stage-b-audit")).toBe(
      true,
    );
  });

  it("records an invitation's creation and revocation, never its token digest", async () => {
    const digest = "deadbeef".repeat(8);

    const created = await asAdminRequest(() =>
      invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "resident",
          email: "invitee@stage-b-audit.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: digest,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        fixture.adminUserId,
      ),
    );

    await asAdminRequest(() =>
      invitations.revoke(created.id, fixture.societyId, fixture.adminUserId),
    );

    expect(await actions()).toEqual([
      "invitation.created",
      "invitation.revoked",
    ]);
    expect(await beforeOf("invitation.revoked")).toMatchObject({
      status: "sent",
    });

    // The credential is not in the log, in any field: the adapter never reads the
    // digest back and the redaction rule would strip it if it did.
    const payloads = await owner<{ payload: string }[]>`
      select coalesce("before", 'null'::jsonb)::text
             || coalesce("after", 'null'::jsonb)::text
             || coalesce(metadata, 'null'::jsonb)::text as payload
        from public.audit_logs
    `;
    expect(payloads.every((row) => !row.payload.includes(digest))).toBe(true);
  });

  it("records nothing when the mutation itself is refused", async () => {
    // A member id nothing addresses: the update matches no row, answers
    // `not_found`, and the transaction carries no audit entry with it.
    await expect(
      asAdminRequest(() =>
        members.update(
          asMemberId(randomUUID()),
          fixture.societyId,
          { displayName: "Ghost" },
          fixture.adminUserId,
        ),
      ),
    ).rejects.toThrow();

    expect(await actions()).toEqual([]);
  });
});

// ── Stage C: the society lifecycle ──────────────────────────────────────────

/**
 * The society lifecycle's audit rows against real PostgreSQL — T050 Stage C.
 *
 * ## What this block adds over the generic tests above
 *
 * The mechanism (commit-together, rollback-together, redaction, tenant isolation)
 * is proven generically. What only these cases can prove is that each **society
 * mutation** is wired to it: the society lifecycle's writes go through
 * `SECURITY DEFINER` RPCs (`society_create`, `society_update`,
 * `society_rotate_join_code`, `society_soft_delete`) or direct RLS-governed DML
 * (join/leave). Each case drives the repository as a real identity and reads the
 * row the writer persisted.
 *
 * The claims, one per acceptance bullet: a creation is keyed to the newly minted
 * society and never carries the join code; an edit's `before` is the pre-edit state
 * read inside the same transaction; a rotation records that it happened without the
 * old or the new code; a soft delete keeps the row (financial history's owner) while
 * leaving the log intact; a join records the membership transition as the requester,
 * with `status: "pending"` in its snapshot; a leave records the reverse; and a
 * refused mutation leaves no row at all.
 */
describe("the audit trail of the society lifecycle (Stage C)", () => {
  let societies: SocietyRepository;

  beforeAll(() => {
    societies = harness.app.get<SocietyRepository>(SOCIETY_REPOSITORY);
  });

  /**
   * Runs `work` inside a request context as `userId`.
   *
   * The `actorRole` on the row comes from this context, never from the repository's
   * arguments (ADR-0014 D5), so a call without one would record `null` and prove
   * nothing about where the role is read from.
   */
  function asRequest<T>(
    userId: UserId,
    role: MemberRole,
    work: () => Promise<T>,
  ): Promise<T> {
    return RequestContext.run(
      {
        requestId: "req-stage-c-audit",
        userId,
        member: {
          membershipId: asMemberId(randomUUID()),
          societyId: asSocietyId(randomUUID()),
          role,
          status: "active",
        },
        ip: undefined,
        userAgent: undefined,
        audited: [],
      },
      work,
    );
  }

  /** Every persisted action, in insertion order — the log's own order. */
  async function actions(): Promise<readonly string[]> {
    const rows = await owner<{ action: string }[]>`
      select action from public.audit_logs order by id
    `;
    return rows.map((row) => row.action);
  }

  interface AuditRow {
    readonly action: string;
    readonly society_id: string;
    readonly actor_user_id: string | null;
    readonly actor_role: string | null;
    readonly entity_type: string;
    readonly entity_id: string | null;
    readonly before: unknown;
    readonly after: unknown;
  }

  async function rowFor(action: string): Promise<AuditRow> {
    const [row] = await owner<AuditRow[]>`
      select action,
             society_id::text as society_id,
             actor_user_id::text as actor_user_id,
             actor_role::text as actor_role,
             entity_type,
             entity_id::text as entity_id,
             "before",
             "after"
        from public.audit_logs
       where action = ${action}
       order by id
    `;
    if (row === undefined) throw new Error(`No audit row for ${action}.`);
    return row;
  }

  const newUser = (email: string): Promise<UserId> =>
    createLocalUser(owner, email, "Stage C").then((id) => asUserId(id));

  it("records a creation keyed to the new society, with the join code absent", async () => {
    const creator = await newUser("creator@stage-c-audit.ses.test");

    const created = await asRequest(creator, "admin", () =>
      societies.create(
        {
          name: "Stage C Court",
          type: "apartment",
          city: "Pune",
          state: "MH",
          billingDay: 1,
          dueDay: 10,
          approvalThresholdPaise: paise(1_000_000n),
        },
        creator,
      ),
    );

    expect(await actions()).toEqual(["society.created"]);
    const row = await rowFor("society.created");
    // The audit row belongs to the society the same transaction created — the
    // `society_id` foreign key is satisfied by the row this operation wrote.
    expect(row.society_id).toBe(created.society.id);
    expect(row.actor_user_id).toBe(creator);
    expect(row.actor_role).toBe("admin");
    expect(row.entity_type).toBe("society");
    expect(row.entity_id).toBe(created.society.id);
    expect(row.before).toBeNull();
    expect(row.after).toMatchObject({ name: "Stage C Court", city: "Pune" });
    // The generated join code is a live credential; it is in no part of the row.
    expect(JSON.stringify(row)).not.toContain(created.society.joinCode);
  });

  it("rolls back both the society and its audit row when creation is refused", async () => {
    const creator = await newUser("refused@stage-c-audit.ses.test");

    // `billing_day BETWEEN 1 AND 28`: the settings insert is refused at the database,
    // which aborts the whole transaction — including the audit entry the flush had
    // not yet written.
    await expect(
      asRequest(creator, "admin", () =>
        societies.create(
          {
            name: "Doomed Court",
            type: "apartment",
            city: "Pune",
            state: "MH",
            billingDay: 99,
            dueDay: 10,
            approvalThresholdPaise: paise(1_000_000n),
          },
          creator,
        ),
      ),
    ).rejects.toThrow();

    const [count] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.societies where name = 'Doomed Court'
    `;
    expect(Number(count?.count)).toBe(0);
    expect(await actions()).toEqual([]);
  });

  it("records an edit with the pre-edit state as its before snapshot", async () => {
    const fixture = await seedSociety(
      harness,
      "Edit Court",
      "admin@stage-c-edit.ses.test",
    );

    await asRequest(fixture.adminUserId, "admin", () =>
      societies.update(
        fixture.societyId,
        { name: "Edit Court (renamed)", graceDays: 7 },
        fixture.adminUserId,
      ),
    );

    expect(await actions()).toEqual(["society.updated"]);
    const row = await rowFor("society.updated");
    expect(row.society_id).toBe(fixture.societyId);
    expect(row.entity_id).toBe(fixture.societyId);
    expect(row.before).toMatchObject({ name: "Edit Court" });
    expect(row.after).toMatchObject({ name: "Edit Court (renamed)" });
    expect(
      (row.after as { settings: { graceDays: number } }).settings,
    ).toMatchObject({ graceDays: 7 });
  });

  it("records a join-code rotation without persisting either code", async () => {
    const fixture = await seedSociety(
      harness,
      "Rotate Court",
      "admin@stage-c-rotate.ses.test",
    );

    const rotated = await asRequest(fixture.adminUserId, "admin", () =>
      societies.regenerateJoinCode(fixture.societyId, fixture.adminUserId),
    );

    expect(await actions()).toEqual(["society.join_code_rotated"]);
    expect(rotated.joinCode).not.toBe(fixture.joinCode);

    // The rotation is recorded as a fact; the credential is not. Neither the
    // superseded code nor the new one appears anywhere in the row.
    const [payload] = await owner<{ payload: string }[]>`
      select coalesce("before", 'null'::jsonb)::text
             || coalesce("after", 'null'::jsonb)::text
             || coalesce(metadata, 'null'::jsonb)::text as payload
        from public.audit_logs
       where action = 'society.join_code_rotated'
    `;
    expect(payload?.payload).not.toContain(fixture.joinCode);
    expect(payload?.payload).not.toContain(rotated.joinCode);
  });

  it("records a soft delete while keeping the society row and its history", async () => {
    const fixture = await seedSociety(
      harness,
      "Delete Court",
      "admin@stage-c-delete.ses.test",
    );

    await asRequest(fixture.adminUserId, "admin", () =>
      societies.remove(fixture.societyId, fixture.adminUserId),
    );

    expect(await actions()).toEqual(["society.deleted"]);
    const row = await rowFor("society.deleted");
    expect(row.entity_id).toBe(fixture.societyId);
    expect(row.before).toMatchObject({ name: "Delete Court", deletedAt: null });
    expect(row.after).toMatchObject({ deletedAt: true });

    // The row survives (financial history keeps its owner) and the log is intact:
    // a soft delete is not a purge.
    const [society] = await owner<{ deleted_at: string | null }[]>`
      select deleted_at from public.societies where id = ${fixture.societyId}::uuid
    `;
    expect(society?.deleted_at).not.toBeNull();
    expect(await actions()).toEqual(["society.deleted"]);
  });

  it("records a join as the requester, snapshotting the pending membership", async () => {
    const fixture = await seedSociety(
      harness,
      "Join Court",
      "admin@stage-c-join.ses.test",
    );
    const joiner = await newUser("joiner@stage-c-audit.ses.test");

    const membership = await asRequest(joiner, "resident", () =>
      societies.join(
        {
          code: fixture.joinCode,
          occupancyType: "owner",
          apartmentId: null,
          note: null,
        },
        joiner,
      ),
    );

    expect(await actions()).toEqual(["society.joined"]);
    const row = await rowFor("society.joined");
    expect(row.society_id).toBe(fixture.societyId);
    expect(row.actor_user_id).toBe(joiner);
    expect(row.entity_type).toBe("member");
    expect(row.entity_id).toBe(membership.id);
    expect(row.before).toBeNull();
    // The row is honest that this is a *request*: approval is a separate action.
    expect(row.after).toMatchObject({
      role: "resident",
      status: "pending",
      occupancy: "owner",
    });
  });

  it("records a re-ask with the previous rejected state as its before", async () => {
    const fixture = await seedSociety(
      harness,
      "Reask Court",
      "admin@stage-c-reask.ses.test",
    );
    const joiner = await newUser("reask@stage-c-audit.ses.test");
    await insertMember(owner, fixture.societyId, {
      userId: joiner,
      status: "rejected",
      rejectionReason: "No proof of ownership.",
    });

    await asRequest(joiner, "resident", () =>
      societies.join(
        {
          code: fixture.joinCode,
          occupancyType: "owner",
          apartmentId: null,
          note: "Asked again",
        },
        joiner,
      ),
    );

    expect(await actions()).toEqual(["society.joined"]);
    const row = await rowFor("society.joined");
    expect(row.before).toMatchObject({ status: "removed" });
    expect(row.after).toMatchObject({ status: "pending" });
  });

  it("records a leave as the member, snapshotting the removed transition", async () => {
    const fixture = await seedSociety(
      harness,
      "Leave Court",
      "admin@stage-c-leave.ses.test",
    );
    const leaver = await newUser("leaver@stage-c-audit.ses.test");
    const memberId = await insertMember(owner, fixture.societyId, {
      userId: leaver,
      role: "resident",
      status: "active",
    });

    await asRequest(leaver, "resident", () =>
      societies.leave(fixture.societyId, leaver),
    );

    expect(await actions()).toEqual(["society.left"]);
    const row = await rowFor("society.left");
    expect(row.society_id).toBe(fixture.societyId);
    expect(row.actor_user_id).toBe(leaver);
    expect(row.entity_type).toBe("member");
    expect(row.entity_id).toBe(memberId);
    expect(row.before).toMatchObject({ status: "active", role: "resident" });
    expect(row.after).toMatchObject({ status: "removed" });
  });

  it("records nothing when a society mutation is refused", async () => {
    const fixture = await seedSociety(
      harness,
      "Refused Court",
      "admin@stage-c-refused.ses.test",
    );
    const outsider = await newUser("outsider@stage-c-audit.ses.test");

    // A non-member's edit: the RPC's membership check refuses it before any write.
    await expect(
      asRequest(outsider, "resident", () =>
        societies.update(fixture.societyId, { name: "Hijacked" }, outsider),
      ),
    ).rejects.toThrow();

    // A join with a code no live society has: refused before storage.
    await expect(
      asRequest(outsider, "resident", () =>
        societies.join(
          {
            code: "AAAAAA",
            occupancyType: "owner",
            apartmentId: null,
            note: null,
          },
          outsider,
        ),
      ),
    ).rejects.toThrow();

    expect(await actions()).toEqual([]);

    // And the refused edit changed nothing in the row it named.
    const [society] = await owner<{ name: string }[]>`
      select name from public.societies where id = ${fixture.societyId}::uuid
    `;
    expect(society?.name).toBe("Refused Court");
  });
});

/**
 * The audit trail of the expense sub-resources and the attachment lifecycle — T050
 * Stage D.
 *
 * ## What only these cases can prove
 *
 * The mechanism is already proven generically (Stage A) and per-module for the core
 * expense lifecycle, members, invitations, structure (Stage B) and the society
 * lifecycle (Stage C). Stage D's nine routes are the last of T050's write surface, and
 * what each case here adds is that the **specific mutation** is wired to the same seam:
 *
 *  - **categories** — a birth keyed to the minted id, an edit whose `before` is the
 *    pre-edit state read in the same transaction, and a soft delete that keeps the row
 *    and records the flag that changed;
 *  - **comments** — an addition that records the author, the stream position and the
 *    body's *length* and never the text, and a tombstone that is a real transition while
 *    a replay of it is not;
 *  - **GST** — a tax row recorded as a birth and then as a change, in the column's own
 *    exact paise strings, with the split and ledger tables untouched;
 *  - **attachments** — a reservation recorded without the upload URL, the storage key or
 *    any bucket credential; completion recorded as a transition with the pre-state
 *    reconstructed from the statement's own predicate; and a deletion whose `before`
 *    comes out of the `DELETE`'s `RETURNING` and whose `after` is `null`.
 *
 * Two no-op cases are here because the alternative is a log that lies: an
 * already-tombstoned comment and a replayed completion each write **nothing**, since
 * neither is a second transition (ADR-0014 D4). Both are asserted by comparing the whole
 * action list before and after the second call, not by counting a single action.
 *
 * The refusals asserted here are the database's own: a cross-society id, a category an
 * expense still references, a comment the caller may neither author nor administer, and
 * a write from outside the tenant. Each leaves the log exactly as it was, which is the
 * half of the guarantee that a happy-path test cannot reach.
 */
/**
 * The real store adapter with **one** method replaced: `presignUpload` refuses.
 *
 * Controlled fault injection at the signing boundary, and deliberately nothing more.
 * The rejection is the same `storage_unavailable` an S3 5xx, 408, 429 or timeout
 * produces (`S3StorageProvider`'s own classification), so the contract asserted below
 * is the shipping one rather than a fixture's invention; every other method delegates,
 * so a suite using this still reads and deletes real objects. It exists as a wrapper
 * rather than a Nest override because only the *signing* half should fail — the
 * database half has to be the real adapter for the reservation to commit.
 */
class FailingSigningStorage implements StorageProvider {
  constructor(private readonly inner: StorageProvider) {}

  presignUpload(): Promise<never> {
    return Promise.reject(
      attachmentError("storage_unavailable", "the store is unreachable"),
    );
  }

  head(storageKey: string) {
    return this.inner.head(storageKey);
  }

  readObject(storageKey: string) {
    return this.inner.readObject(storageKey);
  }

  presignDownload(storageKey: string, ttlSeconds: number) {
    return this.inner.presignDownload(storageKey, ttlSeconds);
  }

  copy(fromKey: string, toKey: string) {
    return this.inner.copy(fromKey, toKey);
  }

  delete(storageKey: string) {
    return this.inner.delete(storageKey);
  }
}

describe("the audit trail of the expense sub-resources and attachments (Stage D)", () => {
  let world: SocietyFixture & {
    readonly categoryId: ExpenseCategoryId;
    readonly expenseId: ExpenseId;
  };
  let categories: ExpenseCategoryRepository;
  let comments: ExpenseCommentRepository;
  let gstDetails: ExpenseGstDetailsRepository;
  let attachments: AttachmentRepository;
  let storage: StorageProvider;
  let presignUpload: PresignUploadUseCase;
  let completeUpload: CompleteUploadUseCase;
  let deleteDraft: DeleteDraftUseCase;

  beforeAll(() => {
    categories = harness.app.get<ExpenseCategoryRepository>(
      EXPENSE_CATEGORY_REPOSITORY,
    );
    comments = harness.app.get<ExpenseCommentRepository>(
      EXPENSE_COMMENT_REPOSITORY,
    );
    gstDetails = harness.app.get<ExpenseGstDetailsRepository>(
      EXPENSE_GST_DETAILS_REPOSITORY,
    );
    attachments = harness.app.get<AttachmentRepository>(ATTACHMENT_REPOSITORY);
    storage = harness.app.get<StorageProvider>(STORAGE_PROVIDER);
    presignUpload = harness.app.get(PresignUploadUseCase);
    completeUpload = harness.app.get(CompleteUploadUseCase);
    deleteDraft = harness.app.get(DeleteDraftUseCase);
  });

  beforeEach(async () => {
    const society = await seedSociety(
      harness,
      "Stage D Court",
      "admin@stage-d-audit.ses.test",
    );
    const listed = await categories.listCategories(
      society.societyId,
      society.adminUserId,
    );
    const category = listed.find((entry) => entry.name === "Lift");
    if (category === undefined) {
      throw new Error('The seeded category "Lift" is missing.');
    }
    world = {
      ...society,
      categoryId: category.id,
      expenseId: await insertDraftExpense(
        society.societyId,
        category.id,
        society.adminMemberId,
      ),
    };
  });

  /** Runs `work` inside a request context as `userId`, so the role is the trusted one. */
  function asRequest<T>(
    userId: UserId,
    role: MemberRole,
    work: () => Promise<T>,
  ): Promise<T> {
    return RequestContext.run(
      {
        requestId: "req-stage-d-audit",
        userId,
        member: {
          membershipId: asMemberId(randomUUID()),
          societyId: asSocietyId(randomUUID()),
          role,
          status: "active",
        },
        ip: undefined,
        userAgent: undefined,
        audited: [],
      },
      work,
    );
  }

  const asAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    asRequest(world.adminUserId, "admin", work);

  /** Every persisted action, in insertion order — the log's own order. */
  async function actions(): Promise<readonly string[]> {
    const rows = await owner<{ action: string }[]>`
      select action from public.audit_logs order by id
    `;
    return rows.map((row) => row.action);
  }

  interface AuditRow {
    readonly action: string;
    readonly society_id: string;
    readonly actor_user_id: string | null;
    readonly actor_role: string | null;
    readonly category: string;
    readonly entity_type: string;
    readonly entity_id: string | null;
    readonly before: unknown;
    readonly after: unknown;
    readonly metadata: unknown;
  }

  /** Every row for one action, in insertion order. */
  async function rowsFor(action: string): Promise<readonly AuditRow[]> {
    return owner<AuditRow[]>`
      select action,
             society_id::text as society_id,
             actor_user_id::text as actor_user_id,
             actor_role::text as actor_role,
             category,
             entity_type,
             entity_id::text as entity_id,
             "before",
             "after",
             metadata
        from public.audit_logs
       where action = ${action}
       order by id
    `;
  }

  async function rowFor(action: string): Promise<AuditRow> {
    const [row] = await rowsFor(action);
    if (row === undefined) throw new Error(`No audit row for ${action}.`);
    return row;
  }

  /**
   * Everything the row persisted, as one string.
   *
   * The assertion this exists for is an *absence* — a comment's text, an upload URL, an
   * S3 signature, a storage key — and an absence has to be checked against every column,
   * not against the one a guess says it would be in. Stage C used the same shape for the
   * join code (D11), and the reasoning is identical: a snapshot that merely *kept* the
   * value somewhere else would pass a narrower test.
   */
  async function payloadTextFor(action: string): Promise<string> {
    const [row] = await owner<{ payload: string }[]>`
      select coalesce("before", 'null'::jsonb)::text
             || coalesce("after", 'null'::jsonb)::text
             || coalesce(metadata, 'null'::jsonb)::text as payload
        from public.audit_logs
       where action = ${action}
       order by id desc
       limit 1
    `;
    return row?.payload ?? "";
  }

  const newUser = (email: string): Promise<UserId> =>
    createLocalUser(owner, email, "Stage D").then((id) => asUserId(id));

  /** A live category of this society that nothing references yet. */
  async function insertCategory(name: string): Promise<ExpenseCategoryId> {
    const [row] = await owner<{ id: string }[]>`
      insert into public.expense_categories (society_id, name, display_order)
      values (${world.societyId}::uuid, ${name}::varchar, 99::smallint)
      returning id
    `;
    return asExpenseCategoryId(row!.id);
  }

  /** A draft expense, inserted as the owner — no audit row, and no repository involved. */
  async function insertDraftExpense(
    societyId: SocietyId,
    categoryId: ExpenseCategoryId,
    memberId: MemberId,
  ): Promise<ExpenseId> {
    const [row] = await owner<{ id: string }[]>`
      insert into public.expenses (
        society_id, category_id, title, amount_paise, expense_date,
        split_strategy, apartment_basis, status, created_by, version
      )
      values (
        ${societyId}::uuid,
        ${categoryId}::uuid,
        'Stage D Bill',
        '250000'::bigint,
        '2026-09-30'::date,
        'equal'::public.split_strategy,
        null,
        'draft'::public.expense_status,
        ${memberId}::uuid,
        1
      )
      returning id
    `;
    return asExpenseId(row!.id);
  }

  /** A checksum-valid GSTIN, through the domain's own parser rather than a cast. */
  function gstin(value: string): Gstin {
    const parsed = parseGstin(value);
    if (!parsed.ok) throw new Error(`Invalid fixture GSTIN: ${value}`);
    return parsed.value;
  }

  function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /** Bytes whose signature and digest are genuinely those of a JPEG. */
  function jpegBytes(payload = 0x41, size = 64): Buffer {
    const body = Buffer.alloc(size, payload);
    body[0] = 0xff;
    body[1] = 0xd8;
    body[2] = 0xff;
    body[3] = 0xe0;
    return body;
  }

  /** A real PUT of the exact bytes the signature pinned, through the real presigned URL. */
  async function putObject(
    url: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<number> {
    const response = await fetch(url, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": contentType },
    });
    return response.status;
  }

  /**
   * Spend `bytes` of the society's attachment quota on completed rows.
   *
   * Free is 500 MB and the per-object cap is 10 MB (`chk_attachments_size_max`), so a
   * quota boundary cannot be reached with one row — the table refuses it. Filling in
   * 10 MB rows is also the honest shape of the data: a society at its cap *is* a long
   * list of bills. The rows go in as the owner, so the fixture writes no audit entry
   * of its own and the only rows the log can hold are the ones under test.
   */
  async function fillPlan(expenseId: ExpenseId, bytes: number): Promise<void> {
    const perRow = 10 * 1024 * 1024;
    for (let remaining = bytes; remaining > 0; remaining -= perRow) {
      const size = Math.min(perRow, remaining);
      await owner`
        insert into public.attachments (
          society_id, entity_type, entity_id, storage_key, original_filename,
          mime_type, size_bytes, checksum, uploaded_by, completed_at
        ) values (
          ${world.societyId}::uuid, 'expense', ${expenseId}::uuid,
          ${`societies/${world.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`},
          'filler.jpg', 'image/jpeg', ${size}, ${"a".repeat(64)},
          ${world.adminMemberId}::uuid, now()
        )
      `;
    }
  }

  interface Refusal {
    readonly code: string | undefined;
    readonly status: number | undefined;
    readonly message: string | undefined;
    readonly detailCodes: readonly string[];
  }

  /**
   * The thrown `AppError`, reduced to what a client branches on.
   *
   * Read off the error the use case raises rather than off an HTTP response, because these
   * three paths are driven at the use-case boundary — but the fields are the same ones the
   * filter renders and the e2e suite asserts, so the *contract* under test is unchanged.
   */
  async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
    try {
      await run();
    } catch (error: unknown) {
      const app = error as {
        code?: string;
        status?: number;
        message?: string;
        payload?: { details?: readonly { code?: string }[] };
      };
      return {
        code: app.code,
        status: app.status,
        message: app.message,
        detailCodes: (app.payload?.details ?? []).map(
          (detail) => detail.code ?? "",
        ),
      };
    }
    throw new Error("Expected the call to be refused.");
  }

  // ── categories ───────────────────────────────────────────────────────────

  it("records a category creation as a birth keyed to the row it minted", async () => {
    const created = await asAdmin(() =>
      categories.create(
        world.societyId,
        { name: "Solar Panels", displayOrder: 21 },
        world.adminUserId,
      ),
    );

    expect(await actions()).toEqual(["expense.category_created"]);
    const row = await rowFor("expense.category_created");
    expect(row.society_id).toBe(world.societyId);
    expect(row.actor_user_id).toBe(world.adminUserId);
    expect(row.actor_role).toBe("admin");
    // A category's flags decide how an expense in it is split and taxed, so it sits in
    // the financial half a Treasurer reads (PRD §2.1).
    expect(row.category).toBe("financial");
    expect(row.entity_type).toBe("expense_category");
    expect(row.entity_id).toBe(created.id);
    // A birth: nothing was there before, and the id in `after` is the database's.
    expect(row.before).toBeNull();
    expect(row.after).toMatchObject({
      name: "Solar Panels",
      displayOrder: 21,
      isActive: true,
      gstApplicable: false,
    });
  });

  it("records an edit with the pre-edit state as its before", async () => {
    await asAdmin(() =>
      categories.update(
        world.categoryId,
        world.societyId,
        { name: "Lift Maintenance", isCapital: true },
        world.adminUserId,
      ),
    );

    expect(await actions()).toEqual(["expense.category_updated"]);
    const row = await rowFor("expense.category_updated");
    expect(row.entity_id).toBe(world.categoryId);
    // The `before` is the state this transaction replaced, read ahead of the `UPDATE`.
    expect(row.before).toMatchObject({ name: "Lift", isCapital: false });
    expect(row.after).toMatchObject({
      name: "Lift Maintenance",
      isCapital: true,
    });
  });

  it("records a soft delete that keeps the row and names the flag that changed", async () => {
    const categoryId = await insertCategory("Deletable");

    await asAdmin(() =>
      categories.remove(categoryId, world.societyId, world.adminUserId),
    );

    expect(await actions()).toEqual(["expense.category_deleted"]);
    const row = await rowFor("expense.category_deleted");
    expect(row.entity_id).toBe(categoryId);
    expect(row.before).toMatchObject({ name: "Deletable" });
    // A soft delete: the row survives as the subject of the expenses filed under it, so
    // the `after` is the flag rather than a missing entity (the same shape `society.deleted`
    // takes).
    expect(row.after).toEqual({ deletedAt: true });

    const [stored] = await owner<{ name: string; deleted_at: string | null }[]>`
      select name, deleted_at::text as deleted_at
        from public.expense_categories
       where id = ${categoryId}::uuid
    `;
    expect(stored?.name).toBe("Deletable");
    expect(stored?.deleted_at).not.toBeNull();
  });

  it("records nothing when a category write is refused", async () => {
    const outsider = await newUser("category-outsider@stage-d-audit.ses.test");
    const otherSociety = await seedSociety(
      harness,
      "Other Court",
      "admin@stage-d-other.ses.test",
    );

    // A category of one society, addressed with another's id: RLS scopes the update to
    // nothing, so it raises `not_found` and the flush never runs.
    await expect(
      asAdmin(() =>
        categories.update(
          world.categoryId,
          otherSociety.societyId,
          { name: "Hijacked" },
          world.adminUserId,
        ),
      ),
    ).rejects.toThrow();

    // A category an expense still references: the definer function refuses it.
    await expect(
      asAdmin(() =>
        categories.remove(world.categoryId, world.societyId, world.adminUserId),
      ),
    ).rejects.toThrow();

    // And a caller outside the tenant entirely.
    await expect(
      asRequest(outsider, "resident", () =>
        categories.create(world.societyId, { name: "Contraband" }, outsider),
      ),
    ).rejects.toThrow();

    expect(await actions()).toEqual([]);

    // The row the refused edit named is untouched, and the referenced category is live.
    const [category] = await owner<
      { name: string; deleted_at: string | null }[]
    >`
      select name, deleted_at::text as deleted_at
        from public.expense_categories
       where id = ${world.categoryId}::uuid
    `;
    expect(category?.name).toBe("Lift");
    expect(category?.deleted_at).toBeNull();
  });

  // ── comments ─────────────────────────────────────────────────────────────

  it("records a comment's author and length, and never its text", async () => {
    const body = "The lift invoice is attached.";

    const added = await asAdmin(() =>
      comments.add(
        {
          expenseId: world.expenseId,
          societyId: world.societyId,
          authorId: world.adminMemberId,
          body,
        },
        world.adminUserId,
      ),
    );

    expect(await actions()).toEqual(["expense.comment_added"]);
    const row = await rowFor("expense.comment_added");
    expect(row.society_id).toBe(world.societyId);
    expect(row.actor_user_id).toBe(world.adminUserId);
    // A comment is discussion, not financial state, so it stays out of the half a
    // Treasurer's `audit.view` narrows to.
    expect(row.category).toBe("other");
    expect(row.entity_type).toBe("expense_comment");
    expect(row.entity_id).toBe(added.id);
    expect(row.before).toBeNull();
    expect(row.after).toMatchObject({
      authorId: world.adminMemberId,
      sequence: added.sequence,
      bodyLength: body.length,
    });
    expect(row.metadata).toMatchObject({ expenseId: world.expenseId });

    // The minimal-allowlist decision, asserted rather than assumed: the words never reach
    // a table no `DELETE` can reach.
    const text = await payloadTextFor("expense.comment_added");
    expect(text).not.toContain("lift invoice");
  });

  it("records a tombstone once, and a replay of it writes nothing", async () => {
    const added = await asAdmin(() =>
      comments.add(
        {
          expenseId: world.expenseId,
          societyId: world.societyId,
          authorId: world.adminMemberId,
          body: "Removed later.",
        },
        world.adminUserId,
      ),
    );

    await asAdmin(() =>
      comments.softDelete(
        added.id,
        world.expenseId,
        world.societyId,
        world.adminUserId,
      ),
    );

    expect(await actions()).toEqual([
      "expense.comment_added",
      "expense.comment_deleted",
    ]);
    const row = await rowFor("expense.comment_deleted");
    expect(row.entity_type).toBe("expense_comment");
    expect(row.entity_id).toBe(added.id);
    expect(row.before).toMatchObject({
      authorId: world.adminMemberId,
      bodyLength: "Removed later.".length,
    });
    expect(row.after).toEqual({ deletedAt: true });

    // The definer function is idempotent and returns the tombstoned row unchanged. That is
    // a no-op, not a second transition, so the log is byte-identical afterwards.
    await asAdmin(() =>
      comments.softDelete(
        added.id,
        world.expenseId,
        world.societyId,
        world.adminUserId,
      ),
    );
    expect(await actions()).toEqual([
      "expense.comment_added",
      "expense.comment_deleted",
    ]);
    expect(await rowsFor("expense.comment_deleted")).toHaveLength(1);
  });

  it("records nothing when the comment's author or an Admin refuses the delete", async () => {
    const added = await asAdmin(() =>
      comments.add(
        {
          expenseId: world.expenseId,
          societyId: world.societyId,
          authorId: world.adminMemberId,
          body: "Admin's words.",
        },
        world.adminUserId,
      ),
    );

    const resident = await newUser("commenter@stage-d-audit.ses.test");
    await insertMember(owner, world.societyId, {
      userId: resident,
      role: "resident",
      status: "active",
    });

    // Neither the author nor an Admin: the definer function raises before any write.
    await expect(
      asRequest(resident, "resident", () =>
        comments.softDelete(
          added.id,
          world.expenseId,
          world.societyId,
          resident,
        ),
      ),
    ).rejects.toThrow();

    expect(await actions()).toEqual(["expense.comment_added"]);
  });

  // ── GST ──────────────────────────────────────────────────────────────────

  it("records the tax row as a birth, then as a change in exact paise", async () => {
    const [splitsBefore] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expense_splits
    `;

    await asAdmin(() =>
      gstDetails.upsertForExpense(
        world.expenseId,
        world.societyId,
        {
          gstin: gstin("27AAPFU0939F1ZV"),
          invoiceNumber: "INV-1",
          invoiceDate: "2026-09-28",
          taxableValuePaise: paise(100_000n),
          cgstPaise: paise(9_000n),
          sgstPaise: paise(9_000n),
          igstPaise: paise(0n),
          cessPaise: paise(0n),
          hsnSac: "995461",
          placeOfSupply: "27",
          isReverseCharge: false,
          itcEligible: true,
        },
        world.adminUserId,
      ),
    );

    expect(await actions()).toEqual(["expense.gst_updated"]);
    const birth = await rowFor("expense.gst_updated");
    expect(birth.society_id).toBe(world.societyId);
    expect(birth.category).toBe("financial");
    // The entity is the tax row, and this table's primary key *is* the expense id.
    expect(birth.entity_type).toBe("expense_gst_details");
    expect(birth.entity_id).toBe(world.expenseId);
    expect(birth.before).toBeNull();
    expect(birth.after).toMatchObject({
      gstin: "27AAPFU0939F1ZV",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-09-28",
      // The column's own type, digit for digit — never a rounded number.
      taxableValuePaise: "100000",
      cgstPaise: "9000",
      sgstPaise: "9000",
      igstPaise: "0",
      cessPaise: "0",
      hsnSac: "995461",
      placeOfSupply: "27",
      isReverseCharge: false,
      itcEligible: true,
    });

    // A second save is a change, and it names the row it replaced — the difference between
    // "GST was recorded" and "GST was corrected".
    await asAdmin(() =>
      gstDetails.upsertForExpense(
        world.expenseId,
        world.societyId,
        {
          gstin: gstin("27AAPFU0939F1ZV"),
          invoiceNumber: "INV-2",
          invoiceDate: "2026-09-29",
          taxableValuePaise: paise(250_000n),
          cgstPaise: paise(22_500n),
          sgstPaise: paise(22_500n),
          igstPaise: paise(0n),
          cessPaise: paise(0n),
          hsnSac: "995461",
          placeOfSupply: "27",
          isReverseCharge: false,
          itcEligible: true,
        },
        world.adminUserId,
      ),
    );

    const rows = await rowsFor("expense.gst_updated");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.before).toMatchObject({
      invoiceNumber: "INV-1",
      taxableValuePaise: "100000",
      cgstPaise: "9000",
    });
    expect(rows[1]?.after).toMatchObject({
      invoiceNumber: "INV-2",
      taxableValuePaise: "250000",
      cgstPaise: "22500",
    });

    // Nothing financial moved: recording tax detail writes one table and no split.
    const [splitsAfter] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.expense_splits
    `;
    expect(splitsAfter?.count).toBe(splitsBefore?.count);
  });

  it("records nothing when the GST write is refused", async () => {
    const outsider = await newUser("gst-outsider@stage-d-audit.ses.test");

    // Outside the tenant: the row is invisible and the insert policy refuses it.
    await expect(
      asRequest(outsider, "resident", () =>
        gstDetails.upsertForExpense(
          world.expenseId,
          world.societyId,
          {
            gstin: null,
            invoiceNumber: "INV-X",
            invoiceDate: null,
            taxableValuePaise: paise(1n),
            cgstPaise: paise(0n),
            sgstPaise: paise(0n),
            igstPaise: paise(0n),
            cessPaise: paise(0n),
            hsnSac: null,
            placeOfSupply: null,
            isReverseCharge: false,
            itcEligible: false,
          },
          outsider,
        ),
      ),
    ).rejects.toThrow();

    expect(await actions()).toEqual([]);
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count
        from public.expense_gst_details
       where expense_id = ${world.expenseId}::uuid
    `;
    expect(row?.count).toBe("0");
  });

  // ── attachments ──────────────────────────────────────────────────────────

  it("records a reservation without the upload URL, the storage key or a credential", async () => {
    const bytes = Buffer.alloc(2048, 0x41);

    const reserved = await asAdmin(() =>
      presignUpload.presign(
        world.adminUserId,
        world.societyId,
        world.expenseId,
        {
          fileName: "lift-bill.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        },
      ),
    );

    expect(await actions()).toEqual(["attachment.created"]);
    const row = await rowFor("attachment.created");
    expect(row.society_id).toBe(world.societyId);
    expect(row.actor_user_id).toBe(world.adminUserId);
    // A bill is financial evidence, so its creation sits in the Treasurer's half.
    expect(row.category).toBe("financial");
    expect(row.entity_type).toBe("attachment");
    expect(row.entity_id).toBe(reserved.attachment.id);
    expect(row.before).toBeNull();
    expect(row.after).toMatchObject({
      expenseId: world.expenseId,
      originalFilename: "lift-bill.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      checksum: sha256(bytes),
      uploadedBy: world.adminMemberId,
      // A reservation, not a bill: nothing has been verified or scanned yet.
      scanStatus: "pending",
      completedAt: null,
    });

    // The three things a presign response carries that must never be persisted: the signed
    // URL, the key it addresses, and the object store's credential material.
    const text = await payloadTextFor("attachment.created");
    expect(text).not.toContain("X-Amz-Signature");
    expect(text).not.toContain("X-Amz-Credential");
    expect(text).not.toContain("http");
    expect(text).not.toContain(reserved.storageKey);

    // And the reservation really is only a reservation: the bucket holds nothing yet, which
    // is what makes the object store's absence from this transaction the documented model
    // rather than an omission.
    expect(await storage.head(reserved.storageKey)).toBeNull();
  });

  it("records completion as a transition, and a replay of it writes nothing", async () => {
    const bytes = Buffer.alloc(1024, 0x42);
    const reserved = await asAdmin(() =>
      presignUpload.presign(
        world.adminUserId,
        world.societyId,
        world.expenseId,
        {
          fileName: "receipt.png",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        },
      ),
    );

    const completed = await asAdmin(() =>
      attachments.markComplete(
        reserved.attachment.id,
        world.societyId,
        world.adminUserId,
      ),
    );
    expect(completed.ok).toBe(true);

    expect(await actions()).toEqual([
      "attachment.created",
      "attachment.completed",
    ]);
    const row = await rowFor("attachment.completed");
    expect(row.entity_type).toBe("attachment");
    expect(row.entity_id).toBe(reserved.attachment.id);
    expect(row.metadata).toMatchObject({ expenseId: world.expenseId });
    // The `before` is the pre-completion row, reconstructed from the statement's own
    // `WHERE completed_at IS NULL` — the predicate is the evidence that the flag was unset.
    expect(row.before).toMatchObject({
      originalFilename: "receipt.png",
      completedAt: null,
    });
    expect(row.after).toMatchObject({
      originalFilename: "receipt.png",
    });
    expect(
      (row.after as { completedAt: string | null }).completedAt,
    ).not.toBeNull();

    // ADR-0012: completing an already-complete upload answers the same success and writes
    // nothing. A second entry here would be a second record of one transition.
    const replayed = await asAdmin(() =>
      attachments.markComplete(
        reserved.attachment.id,
        world.societyId,
        world.adminUserId,
      ),
    );
    expect(replayed.ok).toBe(true);
    expect(await actions()).toEqual([
      "attachment.created",
      "attachment.completed",
    ]);
    expect(await rowsFor("attachment.completed")).toHaveLength(1);
  });

  it("records a deletion with the removed row and a null after", async () => {
    const bytes = Buffer.alloc(512, 0x43);
    const reserved = await asAdmin(() =>
      presignUpload.presign(
        world.adminUserId,
        world.societyId,
        world.expenseId,
        {
          fileName: "doomed.pdf",
          mimeType: "application/pdf",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        },
      ),
    );

    await asAdmin(() =>
      attachments.deleteById(
        reserved.attachment.id,
        world.societyId,
        world.adminUserId,
      ),
    );

    expect(await actions()).toEqual([
      "attachment.created",
      "attachment.deleted",
    ]);
    const row = await rowFor("attachment.deleted");
    expect(row.entity_type).toBe("attachment");
    expect(row.entity_id).toBe(reserved.attachment.id);
    // The `before` is the `DELETE`'s own `RETURNING` — the row as it was, from the
    // statement that removed it — and the `after` is `null`, because the entity is gone.
    expect(row.before).toMatchObject({
      expenseId: world.expenseId,
      originalFilename: "doomed.pdf",
      checksum: sha256(bytes),
    });
    expect(row.after).toBeNull();

    // The audit row survives the row it describes: `audit_logs` references the **society**,
    // not the attachment, so the history is not a dependent row.
    const [stored] = await owner<{ count: string }[]>`
      select count(*)::text as count
        from public.attachments
       where id = ${reserved.attachment.id}::uuid
    `;
    expect(stored?.count).toBe("0");
  });

  it("records nothing when an attachment write is refused", async () => {
    const bytes = Buffer.alloc(256, 0x44);
    const reserved = await asAdmin(() =>
      presignUpload.presign(
        world.adminUserId,
        world.societyId,
        world.expenseId,
        {
          fileName: "private.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        },
      ),
    );

    const outsider = await newUser(
      "attachment-outsider@stage-d-audit.ses.test",
    );

    // Outside the tenant: the reservation is invisible, so `markComplete` reports the row
    // it could not see and flushes nothing.
    const refused = await asRequest(outsider, "resident", () =>
      attachments.markComplete(
        reserved.attachment.id,
        world.societyId,
        outsider,
      ),
    );
    expect(refused.ok).toBe(false);

    await expect(
      asRequest(outsider, "resident", () =>
        attachments.deleteById(
          reserved.attachment.id,
          world.societyId,
          outsider,
        ),
      ),
    ).rejects.toThrow();

    // Only the reservation is in the log — no refused completion and no refused deletion.
    expect(await actions()).toEqual(["attachment.created"]);

    // And the reservation itself is untouched by either refusal.
    const remaining = await asAdmin(() =>
      attachments.findById(
        reserved.attachment.id,
        world.societyId,
        world.adminUserId,
      ),
    );
    expect(remaining?.completedAt).toBeNull();
  });

  // ── the quota boundary (a refusal, not a mutation) ────────────────────────

  it("records nothing when the plan's storage is full", async () => {
    // Free is 500 MB, filled to the byte in 10 MB rows.
    await fillPlan(world.expenseId, 500 * 1024 * 1024);

    const refusal = await refusalOf(() =>
      asAdmin(() =>
        presignUpload.presign(
          world.adminUserId,
          world.societyId,
          world.expenseId,
          {
            fileName: "over.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1,
            checksum: sha256(jpegBytes()),
          },
        ),
      ),
    );

    // The existing contract, unmoved: the catalogue's 402 and its stable detail code.
    expect(refusal.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(refusal.status).toBe(402);
    expect(refusal.detailCodes).toContain("ATTACHMENT_QUOTA_EXCEEDED");

    // The refusal happens **before** the insert (`quotaVerdict` runs at step 8, the row is
    // written at step 12), so no reservation was committed — the only rows in the society
    // are the fixture's filler.
    const [over] = await owner<{ count: string }[]>`
      select count(*)::text as count
        from public.attachments
       where society_id = ${world.societyId}::uuid
         and original_filename = 'over.jpg'
    `;
    expect(over?.count).toBe("0");

    // And no successful `attachment.created` was recorded: a refusal is not a transition.
    expect(await actions()).toEqual([]);
    expect(await rowsFor("attachment.created")).toHaveLength(0);
  });

  // ── the signing boundary (a committed pair, then a compensation) ──────────

  it("audits both transitions when the store cannot sign, and keeps the 503 contract", async () => {
    // The real repository and the real use case; only the store's signing half fails.
    const useCase = new PresignUploadUseCase(
      attachments,
      new FailingSigningStorage(storage),
      harness.app.get<AttachmentMembershipReader>(MEMBERSHIP_READER),
      harness.app.get(AppConfig),
    );

    const bytes = jpegBytes();
    const refusal = await refusalOf(() =>
      asAdmin(() =>
        useCase.presign(world.adminUserId, world.societyId, world.expenseId, {
          fileName: "unsigned.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        }),
      ),
    );

    // The error contract is unchanged: a store that cannot mint a URL is a 503, not a 500.
    expect(refusal.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(refusal.status).toBe(503);

    // **Both** database transitions committed and are audited. The reservation really did
    // commit — writing the row before the URL exists *is* the quota's enforcement — and the
    // compensation removed it explicitly. Suppressing the second entry would leave a
    // `created` naming a row that no longer exists.
    expect(await actions()).toEqual([
      "attachment.created",
      "attachment.deleted",
    ]);

    const created = await rowFor("attachment.created");
    const deleted = await rowFor("attachment.deleted");
    expect(deleted.entity_id).toBe(created.entity_id);
    expect(created.before).toBeNull();
    expect(created.after).toMatchObject({
      originalFilename: "unsigned.jpg",
      completedAt: null,
    });
    expect(deleted.before).toMatchObject({
      originalFilename: "unsigned.jpg",
    });
    expect(deleted.after).toBeNull();

    // No URL, signature material, credential or storage key in **either** row.
    for (const action of ["attachment.created", "attachment.deleted"]) {
      const text = await payloadTextFor(action);
      expect(text).not.toContain("X-Amz-Signature");
      expect(text).not.toContain("X-Amz-Credential");
      expect(text).not.toContain("storageKey");
      expect(text).not.toContain("http");
    }

    // The pair is not a phantom: the row really is gone.
    const [gone] = await owner<{ count: string }[]>`
      select count(*)::text as count
        from public.attachments
       where id = ${created.entity_id}::uuid
    `;
    expect(gone?.count).toBe("0");
  });

  // ── the real MinIO round trip ────────────────────────────────────────────

  it("records exactly one completion for a verified MinIO upload, and none on replay", async () => {
    const bytes = jpegBytes(0x7a, 4096);

    const reserved = await asAdmin(() =>
      presignUpload.presign(
        world.adminUserId,
        world.societyId,
        world.expenseId,
        {
          fileName: "verified.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        },
      ),
    );

    // The object really is in the store, written through the real presigned URL.
    const putStatus = await putObject(reserved.uploadUrl, bytes, "image/jpeg");
    expect(putStatus).toBe(200);
    const metadata = await storage.head(reserved.storageKey);
    expect(metadata).not.toBeNull();
    expect(metadata?.contentLength).toBe(bytes.byteLength);

    // Completion re-verifies existence, length, SHA-256 and the magic number against the
    // reservation, then stamps the row. Nothing here weakens that.
    const completed = await asAdmin(() =>
      completeUpload.complete(
        world.adminUserId,
        world.societyId,
        reserved.attachment.id,
        { checksum: sha256(bytes) },
      ),
    );
    expect(completed.status).toBe("processing");

    expect(await actions()).toEqual([
      "attachment.created",
      "attachment.completed",
    ]);
    const rows = await rowsFor("attachment.completed");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The row names the right attachment, expense, society and actor.
    expect(row.society_id).toBe(world.societyId);
    expect(row.actor_user_id).toBe(world.adminUserId);
    expect(row.actor_role).toBe("admin");
    expect(row.category).toBe("financial");
    expect(row.entity_type).toBe("attachment");
    expect(row.entity_id).toBe(reserved.attachment.id);
    expect(row.metadata).toMatchObject({ expenseId: world.expenseId });
    expect(row.before).toMatchObject({ completedAt: null });
    expect(row.after).toMatchObject({
      expenseId: world.expenseId,
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      checksum: sha256(bytes),
      uploadedBy: world.adminMemberId,
    });

    // The replay answers the same success and adds nothing: one transition, one record.
    const replayed = await asAdmin(() =>
      completeUpload.complete(
        world.adminUserId,
        world.societyId,
        reserved.attachment.id,
        { checksum: sha256(bytes) },
      ),
    );
    expect(replayed.status).toBe("processing");
    expect(await rowsFor("attachment.completed")).toHaveLength(1);
    expect(await actions()).toEqual([
      "attachment.created",
      "attachment.completed",
    ]);

    // The object is still there — a replay must not have disturbed it.
    expect(await storage.head(reserved.storageKey)).not.toBeNull();
  });

  // ── the draft-deletion cascade, pinned as an aggregate ───────────────────

  it("records a draft's removal as one expense.deleted entry, not per cascaded attachment", async () => {
    const bytes = jpegBytes(0x55, 512);
    const reserved = await asAdmin(() =>
      presignUpload.presign(
        world.adminUserId,
        world.societyId,
        world.expenseId,
        {
          fileName: "draft-bill.jpg",
          mimeType: "image/jpeg",
          sizeBytes: bytes.byteLength,
          checksum: sha256(bytes),
        },
      ),
    );

    await asAdmin(() =>
      deleteDraft.delete(world.adminUserId, world.societyId, world.expenseId),
    );

    // `expense_draft_delete()` removes the draft's attachment rows in the same
    // transaction that removes the draft, so the row is gone...
    const [cascaded] = await owner<{ count: string }[]>`
      select count(*)::text as count
        from public.attachments
       where id = ${reserved.attachment.id}::uuid
    `;
    expect(cascaded?.count).toBe("0");

    // ...and the log records the **expense's** removal only: no attachment-level entry,
    // and nothing in the expense entry names the attachment it took with it. This is the
    // aggregate semantics ADR-0014 D12 records as a finding rather than a decision, pinned
    // so a later change has to be deliberate.
    expect(await actions()).toEqual(["attachment.created", "expense.deleted"]);
    expect(await rowsFor("attachment.deleted")).toHaveLength(0);

    const text = await payloadTextFor("expense.deleted");
    expect(text).not.toContain(reserved.attachment.id);
  });
});
