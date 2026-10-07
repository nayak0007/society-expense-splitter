import postgres from "postgres";

/**
 * Fixture and assertion helpers for the integration suite — Roadmap T034.
 *
 * ## Why these run on the **owner** connection
 *
 * Everything in this file is setup or inspection, never the behaviour under test.
 * Fixtures have to be created before any identity exists (there is no one to
 * authenticate as yet), and the *assertions* about identity live in the specs,
 * where they run through `UnitOfWork` as a real `authenticated` transaction. The
 * same division the CI canary documents: "Fixture ids are captured while
 * connected as the OWNER, before any identity transaction."
 *
 * The consequence to keep in mind while reading a spec: **anything inserted here
 * has bypassed RLS.** A suite that seeded a row this way and then asserted the row
 * was visible would prove nothing about a policy — so the specs assert *absence*
 * and *refusal* under an identity, and use these helpers only for the fixtures
 * whose existence is the precondition.
 */

/** A connection as the database owner: DDL-capable, RLS-exempt. */
export function ownerClient(url: string): postgres.Sql {
  return postgres(url, {
    max: 2,
    prepare: false,
    onnotice: () => {},
  });
}

/**
 * Empties every table the suite can write, leaving the schema (and the ledger)
 * untouched.
 *
 * Truncation rather than a `DELETE` chain, and *dynamic* rather than a table list:
 * a hand-maintained list is a fixture that silently stops clearing a table the
 * moment a migration adds one, and the failure mode is the worst kind — a test
 * that passes because the previous test's rows are still there. The ledger lives in
 * `ses_meta` and is deliberately untouched (clearing it would make every later
 * assertion about migration state meaningless), while `auth.users` is named
 * explicitly because it lives in the `auth` schema and is reached from `public` by
 * foreign key, so it must go in the same statement as the tables that reference it.
 *
 * ## ONE statement, not one per table (2026-10-07)
 *
 * This used to truncate `auth.users` and then loop over `pg_tables`, issuing a
 * separate `truncate table public.x cascade` per table — ~35 statements per test, so
 * ~35 lock acquisitions on overlapping table sets and ~35 separate WAL/fsync round
 * trips, for every one of the suite's ~900 tests. The table set is unchanged; what
 * changed is that the names are now aggregated into a **single** `truncate table a,
 * b, … cascade`, which acquires its locks once, is atomic, and costs one round trip.
 *
 * That mattered because this is the statement that stalls: an `ACCESS EXCLUSIVE`
 * truncate that cannot have every table at once waits behind whatever else is open,
 * and a hook that waits longer than its timeout is abandoned with its work still in
 * flight — the abandoned work then lands *after* the next test's reset (producing the
 * `users_email_key` collisions seen in the merged coverage runs) and holds the locks
 * the next reset needs. Fewer, cheaper, atomic resets shrink both the window and the
 * blast radius; the isolation contract itself is identical.
 *
 * Emptiness is still the guarantee, and it is still *between tests*: one container
 * per run, one schema, each spec starting from empty — which is why the suite needs
 * no container per file and is order-independent.
 */
export async function resetData(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE targets text;
    BEGIN
      SELECT string_agg(format('public.%I', tablename), ', ')
        INTO targets
        FROM pg_tables
       WHERE schemaname = 'public';

      EXECUTE 'truncate table auth.users'
        || coalesce(', ' || targets, '')
        || ' cascade';
    END
    $$;
  `);
}

/** Mints a user through the bootstrap shim's own helper — the documented local path. */
export async function createLocalUser(
  sql: postgres.Sql,
  email: string,
  displayName: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select auth.create_local_user(${email}, ${displayName}) as id
  `;
  if (row === undefined) {
    throw new Error(`create_local_user(${email}) returned no row`);
  }
  return row.id;
}

/** Counts rows in `schema.table` as the owner. For fixture preconditions only. */
export async function countRows(
  sql: postgres.Sql,
  table: "societies" | "members" | "buildings" | "apartments" | "invitations",
): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from ${sql("public")}.${sql(table)}
  `;
  return Number(row?.count ?? "0");
}
