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
 * that passes because the previous test's rows are still there. `auth.users` is
 * truncated separately because it lives in the `auth` schema; the ledger lives in
 * `ses_meta` and is deliberately untouched (clearing it would make every later
 * assertion about migration state meaningless).
 *
 * Isolation is therefore *between tests*, by data: one container per run, one
 * schema, and each spec starts from empty. That is why the suite does not need a
 * container per file, and why it is order-independent.
 */
export async function resetData(sql: postgres.Sql): Promise<void> {
  await sql`truncate table auth.users cascade`;
  await sql.unsafe(`
    DO $$
    DECLARE target record;
    BEGIN
      FOR target IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE format('truncate table public.%I cascade', target.tablename);
      END LOOP;
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
