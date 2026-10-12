import { randomUUID } from "node:crypto";
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
  asUserId,
  paise,
  systemClock,
  weight,
} from "@ses/domain";
import type {
  ApartmentId,
  ApartmentRepository,
  AuditEntry,
  BuildingRepository,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseDraftFields,
  ExpenseId,
  ExpenseRepository,
  ExpenseSplitRepository,
  InvitationRepository,
  MemberId,
  MemberRepository,
  PublishExpenseAllocation,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { RequestContext } from "../../src/common/context/request-context";
import { buildAuditEntry } from "../../src/common/audit/audit-context";
import { resolveMigrationsDir } from "../../src/infrastructure/database/migrations/runner";
import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";
import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import {
  EXPENSE_REPOSITORY,
  EXPENSE_SPLIT_REPOSITORY,
} from "../../src/modules/expenses/application/expense.tokens";
import { INVITATION_REPOSITORY } from "../../src/modules/invitations/application/invitation.tokens";
import { MEMBER_REPOSITORY } from "../../src/modules/members/application/member.tokens";
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
