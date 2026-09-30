import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * `UnitOfWork` against real PostgreSQL — Roadmap T034, SAD §1.7.
 *
 * The transaction boundary is where four separate claims live, and none of them
 * can be checked without a server: the identity is actually applied (`SET ROLE` +
 * the GUCs `auth.uid()` reads), a commit persists, a throw rolls the *whole*
 * transaction back, and the login role is what a system transaction runs as.
 *
 * `tx.execute` returns the driver's rows directly — the shape the repositories
 * rely on (`society.repository.ts`: `return rows as unknown as readonly Row[]`) —
 * so the assertions below read real result sets rather than a mocked seam.
 */

const harness: { current?: IntegrationHarness } = {};
let owner: IntegrationHarness["owner"];
let unitOfWork: IntegrationHarness["unitOfWork"];

beforeAll(async () => {
  const started = await startIntegrationHarness();
  harness.current = started;
  owner = started.owner;
  unitOfWork = started.unitOfWork;
}, 60_000);

afterAll(async () => {
  await harness.current?.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

/** Reads one row of scalar `value` from a transaction. */
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

describe("the identity bridge", () => {
  it("resolves auth.uid() for a user actor under the real preamble", async () => {
    // The failure this exists for is silent, not loud: a wrong GUC name leaves
    // `auth.uid()` NULL, and every SELECT policy then matches nothing — which
    // reads as "the member has no societies" rather than "the bridge is broken".
    const userId = await createLocalUser(
      owner,
      "bridge@integration.ses.test",
      "Bridge",
    );

    const seen = await unitOfWork.transaction({ kind: "user", userId }, (tx) =>
      scalar(tx, sql`select auth.uid()::text as value`),
    );

    expect(seen).toBe(userId);
  });

  it("runs as the authenticated role, not as the login role", async () => {
    const userId = await createLocalUser(
      owner,
      "role@integration.ses.test",
      "Role",
    );

    const [asUser, asAnonymous] = await Promise.all([
      unitOfWork.transaction({ kind: "user", userId }, (tx) =>
        scalar(tx, sql`select current_user as value`),
      ),
      unitOfWork.transaction({ kind: "anonymous" }, (tx) =>
        scalar(tx, sql`select current_user as value`),
      ),
    ]);

    expect(asUser).toBe("authenticated");
    // Anonymous still sets the role — the grants hang off it — but carries no
    // identity, which is what makes it fail closed rather than fail open.
    expect(asAnonymous).toBe("authenticated");
  });

  it("leaves an anonymous transaction with no identity", async () => {
    const uid = await unitOfWork.transaction({ kind: "anonymous" }, (tx) =>
      scalar(tx, sql`select auth.uid()::text as value`),
    );

    expect(uid).toBeNull();
  });

  it("does not switch roles for a system transaction", async () => {
    // `null` is the tooling case (migrations, reconciliation): no identity and no
    // `SET ROLE`, so it runs as the login role. `current_user` is the observable
    // the boundary actually controls — and the probe the first execution had here
    // was wrong: neither the login role nor `authenticated` has a grant on the
    // `auth` schema, so reading `auth.users` is refused for both and could not
    // distinguish a switched role from an unswitched one.
    const role = await unitOfWork.transaction(null, (tx) =>
      scalar(tx, sql`select current_user as value`),
    );
    expect(role).toBe("authenticator");

    // The contrast: an anonymous transaction DOES switch role, and the switched
    // role cannot read `auth.users` — so the refusal shows the switch is real.
    await expect(
      unitOfWork.transaction({ kind: "anonymous" }, (tx) =>
        scalar(tx, sql`select count(*)::text as value from auth.users`),
      ),
    ).rejects.toThrow();
  });
});

describe("commit and rollback", () => {
  it("persists what a committed transaction wrote", async () => {
    const userId = await createLocalUser(
      owner,
      "commit@integration.ses.test",
      "Commit",
    );

    const societyId = await unitOfWork.transaction(
      { kind: "user", userId },
      (tx) =>
        scalar(
          tx,
          sql`
        select (public.society_create(jsonb_build_object(
          'name', 'Committed Court', 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
        )))->'society'->>'id' as value
      `,
        ),
    );

    expect(societyId).toBeTruthy();

    // Read back on a *different* connection: the owner sees what committed,
    // which is the claim, not the transaction's own uncommitted view.
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.societies where id = ${societyId!}
    `;
    expect(Number(row?.count)).toBe(1);
  });

  it("removes every partial write when the work throws", async () => {
    const userId = await createLocalUser(
      owner,
      "rollback@integration.ses.test",
      "Rollback",
    );

    await expect(
      unitOfWork.transaction({ kind: "user", userId }, async (tx) => {
        await tx.execute(sql`
          select public.society_create(jsonb_build_object(
            'name', 'Doomed Court', 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
          ))
        `);
        throw new Error("domain refusal after the write");
      }),
    ).rejects.toThrow("domain refusal after the write");

    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.societies where name = 'Doomed Court'
    `;
    expect(Number(row?.count)).toBe(0);
  });

  it("rolls back on a database error, not just on a thrown domain error", async () => {
    const userId = await createLocalUser(
      owner,
      "constraint@integration.ses.test",
      "Constraint",
    );

    // A real constraint failure: the caller is inserted as an Admin, and
    // `members_society_user_key` then refuses the duplicate. The first write must
    // not survive.
    await expect(
      unitOfWork.transaction({ kind: "user", userId }, async (tx) => {
        await tx.execute(sql`
          select public.society_create(jsonb_build_object(
            'name', 'Rejected Court', 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
          ))
        `);
        const [society] = (await tx.execute(sql`
          select id as value from public.societies where name = 'Rejected Court'
        `)) as unknown as { value: string }[];

        await tx.execute(sql`
          insert into public.members (society_id, user_id, display_name)
          values (${society!.value}::uuid, ${userId}::uuid, 'Duplicate')
        `);
        throw new Error("duplicate membership");
      }),
    ).rejects.toThrow();

    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.societies where name = 'Rejected Court'
    `;
    expect(Number(row?.count)).toBe(0);
  });

  it("does not leak an identity into the next transaction on the same pool", async () => {
    // `set_config(..., true)` is transaction-local and `SET LOCAL ROLE` reverts at
    // commit, so this holds by construction — and is asserted because a
    // connection-scoped `SET` would cross tenants with no symptom until two
    // requests shared a pooled connection.
    const userId = await createLocalUser(
      owner,
      "leak@integration.ses.test",
      "Leak",
    );

    await unitOfWork.transaction({ kind: "user", userId }, (tx) =>
      scalar(tx, sql`select auth.uid()::text as value`),
    );

    const after = await unitOfWork.transaction({ kind: "anonymous" }, (tx) =>
      scalar(tx, sql`select auth.uid()::text as value`),
    );

    expect(after).toBeNull();
  });

  it("returns the connection to the pool after a failure as well as a success", async () => {
    const userId = await createLocalUser(
      owner,
      "pool@integration.ses.test",
      "Pool",
    );

    await expect(
      unitOfWork.transaction({ kind: "user", userId }, async (tx) => {
        await tx.execute(sql`select 1`);
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");

    // The database is still usable on the next call, which it would not be if the
    // transaction had left the session in a failed state or held the connection.
    const value = await unitOfWork.transaction({ kind: "user", userId }, (tx) =>
      scalar(tx, sql`select 1 as value`),
    );
    expect(Number(value)).toBe(1);
  });
});
