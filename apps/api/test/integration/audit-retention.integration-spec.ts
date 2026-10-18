import type postgres from "postgres";

import { resetData } from "../utils/integration-db";
import {
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * The seven-year retention floor against real PostgreSQL — T050 Stage E2, ADR-0014 D15.
 *
 * ## Why there is no "purge" case here
 *
 * There is no purge operation to test, and inventing one would be the thing this
 * stage is most likely to get wrong. PRD §11.7, SAD §13.7 and PRD §14's DPDP section
 * all say the audit history is **retained seven years** — none of them asks for a
 * delete on the seventh birthday, and ADR-0014 D9 says so explicitly ("enforced
 * operationally, not by a row-deleting job … the retention policy governs export and
 * archival"). The retention *jobs* belong to Roadmap T167 together with every other
 * schedule in the project, and `apps/api/src/jobs/schedules/cron.definitions.ts` —
 * the only scheduler this codebase has — does not exist yet.
 *
 * What this migration adds, and what these cases prove, is the half that must exist
 * for any of that to be safe: **nothing can remove a row inside the seven-year
 * window**. No role. Not the grants, not the owner, not a privileged maintenance
 * role. So the cases below are refusals plus one permission — that a row *older* than
 * the window is still removable, which is what keeps a future archival job possible
 * without weakening the guarantee now.
 *
 * ## The probe role
 *
 * `authenticated` and `ses_api` cannot delete an audit row at all (no `DELETE` grant —
 * asserted in `audit-logs.integration-spec.ts`), so testing the *floor* needs a role
 * that can. `audit_retention_probe` is deliberately the strongest maintenance role
 * this database could ever plausibly hold: `BYPASSRLS` (so no policy is silently doing
 * the work being claimed), `DELETE` and `UPDATE` on the table. Every refusal below is
 * therefore attributable to the trigger alone — which is the point, because a future
 * T167 job will hold exactly that shape of privilege.
 *
 * The harness's own `/dev/null` for the fixture write in `seedSociety` is the only
 * escape hatch in the codebase, it is per-transaction, and it is documented there.
 */

const PROBE_ROLE = "audit_retention_probe";
const DAY_MS = 24 * 60 * 60 * 1000;

let harness: IntegrationHarness;
let owner: postgres.Sql;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;

  // Created here rather than by a migration: it is a test instrument, not a
  // production role, and the disposable container is thrown away with it.
  await owner.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
        CREATE ROLE ${PROBE_ROLE} NOLOGIN NOINHERIT BYPASSRLS;
      END IF;
    END
    $$;
  `);
  await owner.unsafe(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await owner.unsafe(
    `GRANT SELECT, UPDATE, DELETE ON public.audit_logs TO ${PROBE_ROLE}`,
  );
}, 60_000);

afterAll(async () => {
  await owner.unsafe(`DROP OWNED BY ${PROBE_ROLE}`);
  await owner.unsafe(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

/**
 * Runs `fn` as the privileged probe inside one transaction, and lets the failure
 * reject it.
 *
 * The error is deliberately **not** swallowed inside the callback: postgres.js
 * re-raises the transaction's own failure from `begin` whether or not the callback
 * caught it, precisely so a `try`/`catch` inside a transaction cannot hide a failed
 * statement. That is the behaviour these cases want — every refusal below is observed
 * after the rollback it caused, which is what "the refused write left nothing behind"
 * means — so the refusal is caught *outside*, by `refusalOf`.
 */
async function asProbe<T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  const result = await owner.begin(async (tx) => {
    // The role name is a constant in this file, never caller input.
    await tx.unsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
    return fn(tx as unknown as postgres.Sql);
  });
  return result as T;
}

/** The refusal `work` raises, or a failure naming the absence of one. */
async function refusalOf(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (thrown: unknown) {
    return thrown as Error;
  }
  throw new Error(
    "expected the statement to be refused, but the transaction committed",
  );
}

/** One audit row, back-dated, inserted as the owner (fixtures precede identities). */
async function insertRow(
  societyId: string,
  occurredAt: string,
): Promise<number> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.audit_logs
      (society_id, occurred_at, category, action, entity_type, entity_id, operation_id)
    values
      (${societyId}::uuid, ${occurredAt}::timestamptz, 'other', 'society.updated',
       'society', ${societyId}::uuid, gen_random_uuid())
    returning id
  `;
  return Number(row!.id);
}

/**
 * The seven-year boundary **as the database computes it**, so the cases never depend
 * on this machine's calendar arithmetic. `interval '7 years'` is calendar-aware; a
 * fixed millisecond constant would drift on a leap day and make these cases flaky in
 * exactly the way a retention test must not be.
 */
async function boundary(): Promise<{ inside: string; outside: string }> {
  const [row] = await owner<{ at: string }[]>`
    select (now() - interval '7 years')::text as at
  `;
  const at = new Date(row!.at).getTime();
  return {
    inside: new Date(at + DAY_MS).toISOString(),
    outside: new Date(at - DAY_MS).toISOString(),
  };
}

async function rowExists(id: number): Promise<boolean> {
  const [row] = await owner<{ present: boolean }[]>`
    select exists(select 1 from public.audit_logs where id = ${id}) as present
  `;
  return row!.present;
}

describe("audit retention floor — the seven-year window", () => {
  let fixture: SocietyFixture;

  beforeEach(async () => {
    fixture = await seedSociety(harness, "Retention Court");
  });

  it("refuses a delete inside the window for a role that holds DELETE and BYPASSRLS", async () => {
    const id = await insertRow(fixture.societyId, "2020-06-01T00:00:00.000Z"); // ~6 years old

    const refusal = await refusalOf(() =>
      asProbe(async (tx) => {
        await tx`delete from public.audit_logs where id = ${id}`;
      }),
    );

    expect(refusal.message).toContain("AUDIT_RETENTION_FLOOR");
    // `P0001` is the migration's own `ERRCODE`, so a refusal from anywhere else in the
    // write path cannot be mistaken for the floor being enforced.
    expect((refusal as { code?: string }).code).toBe("P0001");

    // The refusal did not quietly delete anyway: the record is still evidence.
    expect(await rowExists(id)).toBe(true);
  });

  it("refuses a row that is one day inside the boundary, and allows one day past it", async () => {
    const edge = await boundary();
    const justInside = await insertRow(fixture.societyId, edge.inside);
    const justOutside = await insertRow(fixture.societyId, edge.outside);

    const refusal = await refusalOf(() =>
      asProbe(async (tx) => {
        await tx`delete from public.audit_logs where id = ${justInside}`;
      }),
    );
    expect(refusal.message).toContain("AUDIT_RETENTION_FLOOR");
    expect(await rowExists(justInside)).toBe(true);

    // The other half of the claim: the floor is a window, not a blanket ban. A row
    // past it is removable, which is what leaves room for a future archival job.
    await asProbe(async (tx) => {
      await tx`delete from public.audit_logs where id = ${justOutside}`;
    });
    expect(await rowExists(justOutside)).toBe(false);
    expect(await rowExists(justInside)).toBe(true);
  });

  it("refuses the table's own connection too, so the guard is the table's property", async () => {
    // The owner connection is the superuser that ran the migrations and owns the
    // container. Deliberately *not* exempt: an exemption for a role some privileged
    // production path also holds would make the retention window advisory. The only
    // way through is to disable row triggers for a session on purpose, which is what
    // the test fixture does for its one line of cleanup.
    const id = await insertRow(fixture.societyId, "2021-01-01T00:00:00.000Z");

    await expect(
      owner`delete from public.audit_logs where id = ${id}`,
    ).rejects.toThrow(/AUDIT_RETENTION_FLOOR/);
    expect(await rowExists(id)).toBe(true);
  });

  it("rolls a multi-row purge back as a whole when one row is inside the window", async () => {
    // A purge job that deletes a range is the shape T167 will have, and the failure
    // mode that matters is a *partial* delete: the old rows gone, the transaction
    // aborted, nobody able to say which. One transaction, two rows, one refusal — and
    // the eligible row the same statement already touched must still be there.
    const edge = await boundary();
    const eligible = await insertRow(fixture.societyId, edge.outside);
    const protectedRow = await insertRow(fixture.societyId, edge.inside);

    const refusal = await refusalOf(() =>
      asProbe(async (tx) => {
        await tx`delete from public.audit_logs where id = ${eligible}`;
        await tx`delete from public.audit_logs where id = ${protectedRow}`;
      }),
    );

    expect(refusal.message).toContain("AUDIT_RETENTION_FLOOR");
    expect(await rowExists(eligible)).toBe(true);
    expect(await rowExists(protectedRow)).toBe(true);
  });
});

describe("audit retention floor — append-only, for every role", () => {
  it("refuses an update from the same privileged role, leaving the row untouched", async () => {
    const fixture = await seedSociety(harness, "Append Only Court");
    const id = await insertRow(fixture.societyId, "2020-06-01T00:00:00.000Z");

    const refusal = await refusalOf(() =>
      asProbe(async (tx) => {
        await tx`update public.audit_logs set action = 'society.deleted' where id = ${id}`;
      }),
    );

    expect(refusal.message).toContain("AUDIT_APPEND_ONLY");
    expect((refusal as { code?: string }).code).toBe("P0001");

    const [row] = await owner<{ action: string }[]>`
      select action from public.audit_logs where id = ${id}
    `;
    expect(row!.action).toBe("society.updated");
  });

  it("leaves the guard functions uncallable and the table unwritable for clients", async () => {
    // Two halves of the same claim. The default privileges this project's bootstrap
    // applies would have handed `authenticated` both `UPDATE`/`DELETE` on a new table
    // and `EXECUTE` — including the `PUBLIC` default on every function, which is the
    // one that is easy to forget. `has_function_privilege` is asked about
    // `authenticated`, and it answers for `PUBLIC` too: a role that is a member of
    // neither the function's owner nor an explicit grantee sees the `PUBLIC` entry.
    const [row] = await owner<
      { canDelete: boolean; canUpdate: boolean; canExecute: boolean }[]
    >`
      select
        has_table_privilege('authenticated', 'public.audit_logs', 'DELETE') as "canDelete",
        has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE') as "canUpdate",
        has_function_privilege(
          'authenticated', 'public.audit_logs_block_update()', 'EXECUTE'
        ) as "canExecute"
    `;

    expect(row).toEqual({
      canDelete: false,
      canUpdate: false,
      canExecute: false,
    });

    const [acl] = await owner<{ acl: string }[]>`
      select coalesce(array_to_string(proacl, ','), '') as acl
        from pg_proc
       where proname in (
         'audit_logs_block_update', 'audit_logs_enforce_retention_floor'
       )
    `;
    // No surviving `=X/owner` entry: the `PUBLIC EXECUTE` default is gone, not merely
    // overlapped by a narrower grant.
    expect(acl!.acl).not.toMatch(/(^|,)=X\//);
  });
});
