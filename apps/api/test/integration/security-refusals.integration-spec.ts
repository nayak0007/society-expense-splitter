import { asUserId } from "@ses/domain";
import type {
  AuditLogPage,
  AuditLogReader,
  MemberRole,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import type { PermissionRefusal } from "../../src/common/authorization/security-event-recorder";
import { AUDIT_LOG_READER } from "../../src/modules/audit/application/audit.tokens";
import { RefusalRecorderService } from "../../src/modules/audit/application/refusal-recorder.service";

import { createLocalUser, resetData } from "../utils/integration-db";
import { insertMember, seedSociety } from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * The refusal record against real PostgreSQL — T050 Stage E2, ADR-0014 D14.
 *
 * ## What only a server can answer
 *
 *  1. **Durability without a business transaction.** A refusal is recorded in its own
 *     transaction — the guard refuses before any handler runs, so there is nothing to roll
 *     back and nothing to share. The row is on the table after the call returns, and no
 *     business row moved.
 *  2. **The bound.** The derived `operation_id` collides for repeated refusals inside one
 *     hour, and `uq_audit_logs_operation_id` is what makes the repeat a no-op rather than a
 *     second row — or an error the caller would see.
 *  3. **Visibility.** The row is `other`, so `can_view_audit` keeps it out of a Treasurer's
 *     narrowed read while an Admin reads it — asserted through the real adapter under a
 *     real `auth.uid()`.
 *  4. **The privilege boundary is unchanged.** This stage adds no grant: `authenticated`
 *     still holds no `INSERT`/`DELETE` on the table and no `EXECUTE` on the writer.
 *
 * Fixtures are written on the owner connection; everything asserted about behaviour runs
 * through `UnitOfWork` as a real identity.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let recorder: RefusalRecorderService;
let reader: AuditLogReader;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  recorder = harness.app.get(RefusalRecorderService);
  reader = harness.app.get<AuditLogReader>(AUDIT_LOG_READER);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

interface RefusalRow {
  readonly society_id: string;
  readonly actor_user_id: string | null;
  readonly actor_role: string | null;
  readonly category: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly metadata: Record<string, unknown>;
  readonly operation_id: string;
}

/** Every refusal row of one society, in insertion order, read as the owner. */
function refusalsOf(societyId: SocietyId): Promise<readonly RefusalRow[]> {
  return owner<RefusalRow[]>`
    select society_id::text as society_id,
           actor_user_id::text as actor_user_id,
           actor_role::text as actor_role,
           category,
           action,
           entity_type,
           entity_id::text as entity_id,
           "before",
           "after",
           metadata,
           operation_id::text as operation_id
      from public.audit_logs
     where action = 'security.permission_denied'
       and society_id = ${societyId}::uuid
     order by id
  `;
}

/** A one-row member count, read as the owner: fixtures' ground truth, not RLS's. */
async function memberCount(societyId: SocietyId): Promise<number> {
  const [row] = await owner<{ count: number }[]>`
    select count(*)::int as count
      from public.members
     where society_id = ${societyId}::uuid
  `;
  return row!.count;
}

async function hasPrivilege(query: PgQuery): Promise<boolean> {
  const [row] = await query;
  return row!.value;
}

type PgQuery = Promise<{ readonly value: boolean }[]>;

/** Seeds a society with one active member of the given role, and the actor's id. */
async function seedMember(
  role: MemberRole,
  email: string,
): Promise<{
  readonly fixture: Awaited<ReturnType<typeof seedSociety>>;
  readonly userId: UserId;
}> {
  const fixture = await seedSociety(harness, "Refusal Court");
  const userId = asUserId(await createLocalUser(owner, email, "Member"));
  await insertMember(owner, fixture.societyId, {
    userId,
    role,
    displayName: "Member",
  });
  return { fixture, userId };
}

describe("the refusal record", () => {
  it("persists one row, in its own transaction, naming the refused action", async () => {
    const { fixture, userId } = await seedMember(
      "resident",
      "resident@refusal.ses.test",
    );

    await recorder.recordRefusal(
      refusalOf(fixture.societyId, userId, "expense.publish"),
    );

    const rows = await refusalsOf(fixture.societyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      society_id: fixture.societyId,
      actor_user_id: userId,
      actor_role: "resident",
      // Not financial state: a refusal sits outside the half a Treasurer may read.
      category: "other",
      action: "security.permission_denied",
      entity_type: "permission",
      // A refusal addresses no row, and the guard runs before any record exists.
      entity_id: null,
      before: null,
      after: null,
    });

    // The trusted request facts, from the request the guard was executing.
    expect(rows[0]?.metadata).toMatchObject({
      reason: "role_denied",
      permission: "expense.publish",
      controller: "ExpensesController",
      handler: "publish",
      requestId: "req-stage-e2",
      ip: "203.0.113.9",
      userAgent: "stage-e2-suite/1.0",
    });
    // No path, no query, no resource id — a 404's whole job is to hide those, and a
    // refusal row must not hand them back.
    expect(JSON.stringify(rows[0])).not.toContain("/v1/");
  });

  it("moves no business row — a refusal is a record, not a change", async () => {
    const { fixture, userId } = await seedMember(
      "resident",
      "resident@refusal.ses.test",
    );
    const before = await memberCount(fixture.societyId);

    await recorder.recordRefusal(
      refusalOf(fixture.societyId, userId, "member.role_change"),
    );

    expect(await memberCount(fixture.societyId)).toBe(before);
    expect(await refusalsOf(fixture.societyId)).toHaveLength(1);
  });

  it("writes exactly one row for repeated refusals inside the same hour", async () => {
    const { fixture, userId } = await seedMember(
      "resident",
      "resident@refusal.ses.test",
    );

    // Three attempts at the same action by the same member in the same hour. The bound is
    // the point: without it a member could mint rows in a seven-year immutable table at
    // request rate, and no throttler exists yet (SAD §7.6).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await recorder.recordRefusal(
        refusalOf(fixture.societyId, userId, "expense.publish"),
      );
    }

    expect(await refusalsOf(fixture.societyId)).toHaveLength(1);
  });

  it("writes a second row for a different action, and one for a different member", async () => {
    const { fixture, userId } = await seedMember(
      "resident",
      "resident@refusal.ses.test",
    );
    const guestUserId = asUserId(
      await createLocalUser(owner, "guest@refusal.ses.test", "Gue"),
    );
    await insertMember(owner, fixture.societyId, {
      userId: guestUserId,
      role: "guest",
      displayName: "Guest",
    });

    await recorder.recordRefusal(
      refusalOf(fixture.societyId, userId, "expense.publish"),
    );
    await recorder.recordRefusal(
      refusalOf(fixture.societyId, userId, "society.delete"),
    );
    await recorder.recordRefusal(
      refusalOf(fixture.societyId, guestUserId, "expense.publish"),
    );

    const rows = await refusalsOf(fixture.societyId);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.operation_id)).size).toBe(3);
  });

  it("records an inactive membership with its own reason, and its real role", async () => {
    const fixture = await seedSociety(harness, "Refusal Court");
    const pendingUserId = asUserId(
      await createLocalUser(owner, "pending@refusal.ses.test", "Pen"),
    );
    await insertMember(owner, fixture.societyId, {
      userId: pendingUserId,
      role: "treasurer",
      status: "pending",
      displayName: "Pending Treasurer",
    });

    await recorder.recordRefusal(
      refusalOf(
        fixture.societyId,
        pendingUserId,
        "cycle.publish",
        "member_inactive",
        "treasurer",
      ),
    );

    const rows = await refusalsOf(fixture.societyId);
    expect(rows[0]?.metadata).toMatchObject({
      reason: "member_inactive",
      permission: "cycle.publish",
    });
    // The role is still recorded: it is the role that would have applied had the
    // membership been active, and it is what an investigation needs to know.
    expect(rows[0]?.actor_role).toBe("treasurer");
  });

  it("stays out of a Treasurer's narrowed read, and is readable by an Admin", async () => {
    const { fixture, userId } = await seedMember(
      "resident",
      "resident@refusal.ses.test",
    );
    const treasurerUserId = asUserId(
      await createLocalUser(owner, "treasurer@refusal.ses.test", "Tre"),
    );
    await insertMember(owner, fixture.societyId, {
      userId: treasurerUserId,
      role: "treasurer",
      displayName: "Treasurer",
    });

    await recorder.recordRefusal(
      refusalOf(fixture.societyId, userId, "expense.publish"),
    );

    const pageFor = (
      readerUserId: UserId,
      categories: readonly ("financial" | "other")[],
    ): Promise<AuditLogPage> =>
      harness.unitOfWork.transaction(
        { kind: "user", userId: readerUserId },
        () =>
          reader.list(
            {
              societyId: fixture.societyId,
              categories,
              limit: 20,
              cursor: null,
            },
            readerUserId,
            // The port requires the plan; this assertion is about which rows the policy
            // returns, so what the plan records is not the question here.
            () => ({
              societyId: fixture.societyId,
              category: "other",
              action: "audit.viewed",
              entityType: "audit_log",
              entityId: null,
              before: null,
              after: null,
              metadata: {},
            }),
          ),
      );

    // A Treasurer's grant is the `financial` half, so asking for `other` returns nothing —
    // their own society's refusal record included.
    expect((await pageFor(treasurerUserId, ["other"])).records).toEqual([]);

    const admin = await pageFor(fixture.adminUserId, ["financial", "other"]);
    expect(admin.records.map((record) => record.action).sort()).toEqual([
      "audit.viewed",
      "security.permission_denied",
    ]);
  });

  it("keeps the privilege boundary exactly as Stage A left it", async () => {
    expect(
      await hasPrivilege(
        owner<{ value: boolean }[]>`
          select has_table_privilege('authenticated', 'public.audit_logs', 'INSERT') as value
        `,
      ),
    ).toBe(false);
    expect(
      await hasPrivilege(
        owner<{ value: boolean }[]>`
          select has_table_privilege('authenticated', 'public.audit_logs', 'DELETE') as value
        `,
      ),
    ).toBe(false);
    expect(
      await hasPrivilege(
        owner<{ value: boolean }[]>`
          select has_function_privilege('authenticated', 'public.write_audit_logs(jsonb)', 'EXECUTE') as value
        `,
      ),
    ).toBe(false);
  });
});

/** One refusal, as the guard would have observed it. */
function refusalOf(
  societyId: SocietyId,
  actorUserId: UserId,
  action: string,
  reason: PermissionRefusal["reason"] = "role_denied",
  actorRole: MemberRole = "resident",
): PermissionRefusal {
  return {
    societyId,
    actorUserId,
    actorRole,
    reason,
    action,
    controller: "ExpensesController",
    handler: "publish",
    requestId: "req-stage-e2",
    ip: "203.0.113.9",
    userAgent: "stage-e2-suite/1.0",
  };
}
