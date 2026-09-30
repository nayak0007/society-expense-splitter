import postgres from "postgres";

import {
  applyMigrations,
  assertCleanHistory,
  inspectState,
  listMigrationFiles,
  resolveMigrationsDir,
  withMigrations,
} from "../../src/infrastructure/database/migrations/runner";

import { ownerUrl } from "../utils/integration-harness";

/**
 * The migration history, applied by real machinery to a stock Postgres —
 * Roadmap T034 / SAD §15.4.
 *
 * `global setup` already ran the chain (so every other spec runs against a real
 * schema); this file asserts *what* that produced, because "it applied" and "it
 * applied correctly" are different claims and only the second is worth a suite.
 *
 * These are assertions no unit test can make. The runner's own unit suite passes a
 * hand-built `Preflight`; here the ledger rows, the checksums and the applied
 * order are whatever PostgreSQL actually recorded, against the real SQL files.
 */

// The owner connection: this spec inspects DDL and the ledger, both of which the
// runtime role is deliberately too weak to see.
const sql = postgres(ownerUrl(), {
  max: 1,
  prepare: false,
  onnotice: () => {},
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("the committed migration history on a stock PostgreSQL", () => {
  it("is fully applied, with nothing pending, edited or missing", async () => {
    const files = listMigrationFiles(resolveMigrationsDir());
    const state = await inspectState(sql, files);

    expect(files.length).toBeGreaterThan(0);
    // Every file on disk is either applied or pending — never both, never neither.
    expect(state.applied).toHaveLength(files.length);
    expect(state.pending).toEqual([]);
    // A non-empty `editedAfterApply` is the "someone changed an applied migration"
    // case `pnpm db:check` exists to catch; a non-empty `missingFromDisk` is a
    // ledger row with no file behind it. Both are silent in `db:status` output and
    // load-bearing under `db:check`, so they are asserted here too.
    expect(state.editedAfterApply).toEqual([]);
    expect(state.missingFromDisk).toEqual([]);
    expect(() => assertCleanHistory(state)).not.toThrow();
  });

  it("records each migration once, in filename order", async () => {
    const files = listMigrationFiles(resolveMigrationsDir());
    const state = await inspectState(sql, files);

    const names = state.applied.map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);

    // The checksum the ledger holds is the checksum of the file on disk — this is
    // what makes `editedAfterApply` meaningful rather than incidental.
    const byName = new Map(files.map((file) => [file.name, file.checksum]));
    const drifted = state.applied.filter(
      (row) => byName.get(row.name) !== row.checksum,
    );
    expect(drifted).toEqual([]);
  });

  it("is idempotent: applying again applies nothing", async () => {
    const files = listMigrationFiles(resolveMigrationsDir());

    // The real apply path, under its real session advisory lock. This is the
    // property CI asserts after its first apply ("re-apply is a no-op"), and the
    // one that makes a re-run on a live database safe.
    const result = await withMigrations(ownerUrl(), (connection, state) =>
      applyMigrations(connection, state),
    );

    expect(result.appliedNow).toEqual([]);
    expect(result.alreadyApplied).toBe(files.length);

    // And the ledger did not grow: still exactly one row per file.
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from ses_meta.migrations
    `;
    expect(Number(row?.count)).toBe(files.length);
  });

  it("installs the Supabase interface the policies are written against", async () => {
    // The bootstrap migration recreates this only on a NON-Supabase host, which is
    // exactly what the container is. If the guard ever inverted, every policy below
    // would fail for a reason that looks like a policy bug.
    const roles = await sql<{ rolname: string }[]>`
      select rolname from pg_roles
       where rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
       order by rolname
    `;
    // The `order by rolname` order, not creation order: anon, authenticated,
    // authenticator, service_role.
    expect(roles.map((r) => r.rolname)).toEqual([
      "anon",
      "authenticated",
      "authenticator",
      "service_role",
    ]);

    const [shim] = await sql<{ users: boolean; uid: boolean }[]>`
      select
        to_regclass('auth.users') is not null as users,
        exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'auth' and p.proname = 'uid'
        ) as uid
    `;
    expect(shim?.users).toBe(true);
    expect(shim?.uid).toBe(true);
  });

  it("enables row level security on every tenant table", async () => {
    // SAD §8.7: "applied to every tenant table without exception". Asserted here
    // rather than trusted, because a table added without a policy is invisible
    // until someone reads another society's data.
    const tenantTables = [
      "societies",
      "society_settings",
      "members",
      "buildings",
      "wings",
      "apartments",
      "invitations",
      "profiles",
    ];

    const rows = await sql<{ relname: string; rls: boolean }[]>`
      select c.relname, c.relrowsecurity as rls
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any(${tenantTables})
       order by c.relname
    `;

    expect(rows.map((row) => row.relname)).toEqual([...tenantTables].sort());
    expect(rows.filter((row) => row.rls !== true)).toEqual([]);
  });
});
