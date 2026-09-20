import { Injectable } from "@nestjs/common";
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

import { DatabaseService } from "./database.service";

/**
 * The identity of the actor a transaction runs as. `null` is a system
 * transaction: migrations, scheduled jobs, reconciliation — anything with no
 * member behind it.
 *
 * Deliberately not called `Actor` yet: T019 adds the member, the society and the
 * role once the guard chain exists. This slice only needs the user id, which is
 * what every committed RLS policy keys on.
 */
export type TransactionActor = { readonly userId: string } | null;

/**
 * Drizzle's transaction handle. A repository receives this rather than the
 * connection, which makes "no financial write outside a transaction" (SAD §1.7)
 * a property of the types instead of a rule in a document.
 *
 * Spelled out in Drizzle's own terms (`PgTransaction` over the postgres-js
 * driver) because it cannot be derived: `Database['transaction']` is generic, so
 * extracting its callback parameter with `Parameters<…>` collapses to `never`.
 */
export type TransactionContext = PgTransaction<
  PostgresJsQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

/**
 * Transaction boundary, and the place the RLS identity bridge lives.
 *
 * ## Why the bridge exists
 *
 * Every policy committed in `supabase/migrations/2026092013*` is written against
 * Supabase's own identity helper:
 *
 * ```sql
 * CREATE POLICY societies_select_member ... TO authenticated
 * USING (... = (SELECT auth.uid()) ...);
 * ```
 *
 * `auth.uid()` reads the `request.jwt.claims` GUC, which PostgREST populates per
 * request. A plain driver connection never sets it, so `auth.uid()` is NULL and
 * **every policy evaluates false** — the API would be locked out of its own
 * tables. SAD §8.7 describes a different mechanism (`SET LOCAL app.user_id`), and
 * the migration's own comment calls that variant "the self-hosted API path". This
 * transaction satisfies both, so neither the committed policies nor the SAD's
 * design has to be rewritten first:
 *
 * ```sql
 * SET LOCAL ROLE authenticated;                        -- policies are TO authenticated
 * SELECT set_config('app.user_id',           $1, true); -- SAD §8.7
 * SELECT set_config('request.jwt.claims',    $2, true); -- what auth.uid() reads
 * SELECT set_config('request.jwt.claim.sub', $1, true); -- older Supabase read path
 * ```
 *
 * Three details are load-bearing:
 *
 * - **`set_config(..., true)` rather than interpolated `SET LOCAL`.** The third
 *   argument makes the setting transaction-local, and passing the value as a bind
 *   parameter removes the injection surface a string-built `SET` has.
 * - **`SET LOCAL`, never `SET`.** Under a transaction-mode pooler a session-level
 *   setting would leak to whichever request next borrows that backend — which, for
 *   a tenancy setting, means serving one society's rows to another.
 * - **`SET LOCAL ROLE authenticated`.** Every grant in the migrations is to
 *   `authenticated` and every policy is `TO authenticated`, so an application role
 *   named anything else would match nothing. On Supabase `authenticated` is
 *   `NOLOGIN`, which is why the connection logs in as `authenticator` and switches
 *   role per transaction — exactly PostgREST's own model.
 *
 * ## What this does not do
 *
 * It does not authorise anything. It tells the database *who* the transaction is;
 * whether that identity may read a row is decided by the policies. Repositories
 * still require an explicit `societyId`, and the guard chain (T019) still decides
 * whether a request may proceed at all.
 */
@Injectable()
export class UnitOfWork {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Runs `work` in a transaction as `actor`, rolling back on any thrown error.
   *
   * SAD §1.7: no financial write happens outside a transaction. Making the only
   * write path a transaction removes the possibility rather than documenting it.
   */
  async transaction<T>(
    actor: TransactionActor,
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      await applyIdentity(tx, actor);
      return work(tx);
    });
  }
}

async function applyIdentity(
  tx: TransactionContext,
  actor: TransactionActor,
): Promise<void> {
  if (actor === null) {
    return;
  }

  // Role name is a compile-time constant, not input, so it is inline SQL rather
  // than an interpolation — and `SET ROLE` cannot take a bind parameter anyway.
  await tx.execute(sql`set local role authenticated`);
  await tx.execute(
    sql`select set_config('app.user_id', ${actor.userId}, true)`,
  );
  await tx.execute(
    sql`select set_config('request.jwt.claim.sub', ${actor.userId}, true)`,
  );
  await tx.execute(
    sql`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: actor.userId,
      role: "authenticated",
    })}, true)`,
  );
}
