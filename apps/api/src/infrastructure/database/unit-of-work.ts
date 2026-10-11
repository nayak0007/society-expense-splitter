import { Injectable } from "@nestjs/common";
import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { redactAuditEntry, type AuditEntry } from "@ses/domain";

import { DatabaseService } from "./database.service";

/**
 * The identity a transaction runs as. Three cases, and the difference between
 * the last two is load-bearing:
 *
 * - **`user`** — a verified JWT. Policies resolve `auth.uid()` from it and RLS
 *   decides every row.
 * - **`anonymous`** — a public endpoint. The `authenticated` **role** is still
 *   set, because that is what every grant in the migrations targets, but no
 *   `app.user_id` is written, so `auth.uid()` resolves to NULL. Everything then
 *   fails closed: a SELECT policy comparing against NULL matches nothing, and
 *   the `SECURITY DEFINER` helpers raise `SOCIETY_NOT_FOUND` on their own
 *   membership checks. What remains reachable is exactly the set of functions
 *   written to need no identity — currently only `society_join_preview(text)`,
 *   whose whole purpose is to resolve a code before the caller has joined
 *   anything.
 * - **`null`** — a system transaction: migrations, scheduled jobs,
 *   reconciliation. No identity and **no role switch**, so it runs as the
 *   connection's login role and is the only case that can bypass RLS. It exists
 *   for tooling, not for request handling.
 *
 * WHY `anonymous` IS NOT `null`: running a public read as the login role would
 * work by accident in local development (where the API connects as the owner)
 * and fail on Supabase, whose pooler logs in as `authenticator` — a role that was
 * never granted EXECUTE on any of these functions. The failure would surface as
 * `42501 permission denied`, on the one endpoint a signed-out user can reach.
 * `anon` is not usable either: the RLS migration revokes it outright, tables and
 * functions alike.
 *
 * Deliberately not called `Actor` yet: T019 adds the member, the society and the
 * role once the guard chain exists. This slice needs only the user id, which is
 * what every committed policy keys on.
 */
export type TransactionActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "anonymous" }
  | null;

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
 * The audit entries a transaction wants recorded, or a function that derives them
 * from the transaction's result — T050, ADR-0014.
 *
 * A **function** is the common case and not a convenience: the row an operation
 * actually persisted only exists once `work` has returned (its id is minted by the
 * database, its version is bumped by a trigger), and "before/after snapshots
 * reflect actual persisted state" therefore cannot be satisfied by an array the
 * caller assembled beforehand.
 *
 * An empty array is a no-op: a read path may pass `[]` and pay nothing.
 */
export type AuditFlush<T> =
  readonly AuditEntry[] | ((result: T) => readonly AuditEntry[]);

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
   * The identity applies to *every* statement in `work`, which is why the
   * repository opens one transaction per operation rather than one per query: a
   * read followed by a write must be the same caller, and a half-applied
   * identity would be a tenancy bug with no symptom until two tenants collide.
   *
   * SAD §1.7: no financial write happens outside a transaction. Making the only
   * write path a transaction removes the possibility rather than documenting it.
   */
  async transaction<T>(
    actor: TransactionActor,
    work: (tx: TransactionContext) => Promise<T>,
    audit?: AuditFlush<T>,
  ): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      await applyIdentity(tx, actor);
      const result = await work(tx);
      const entries = typeof audit === "function" ? audit(result) : audit;
      if (entries !== undefined && entries.length > 0) {
        await flushAudit(tx, entries, actor);
      }
      return result;
    });
  }
}

/**
 * Writes the transaction's audit entries through the privileged writer, in the
 * same transaction as the business change — T050, ADR-0014 D1.
 *
 * ## The role switch, and why it is not forgeable
 *
 * The transaction has been running as `authenticated` (RLS applies, the caller's
 * policies decide every row). Audit rows must not be writable by that role —
 * `authenticated` holds no `INSERT` on `audit_logs` and no `EXECUTE` on
 * `write_audit_logs` — so the flush resets to the session user and switches to
 * `ses_api`, the capability group whose *only* privilege is `EXECUTE` on the
 * writer. `SET LOCAL` throughout: a session-level setting under a transaction-mode
 * pooler would leak to whichever request next borrows the backend.
 *
 * The control is the **privilege**, not a GUC: any role can call `set_config`, so a
 * transaction-local setting is defence in depth at best, which is why the writer is
 * unreachable without the grant. `RESET ROLE` first is for clarity — `SET ROLE`
 * authorises against the *session* user, so it would work without it — and it makes
 * the sequence readable as "stop being the caller, then be the writer".
 *
 * ## Fail-closed, and no silent de-duplication
 *
 * Any error the writer raises — a duplicate `operation_id`, an actor that does not
 * match the transaction's identity, a malformed batch — propagates and rolls the
 * whole transaction back, business writes included. There is deliberately no
 * `ON CONFLICT DO NOTHING` anywhere: an audit entry that was dropped to make a
 * write succeed is not an audit trail (ADR-0014 D4).
 *
 * ## The actor is stamped from the transaction, not from the entry
 *
 * Every entry's `actorUserId` is overwritten with the identity this transaction runs
 * as. That is what makes the writer's actor check a *structural* guarantee rather
 * than a convention: the row's actor and the `request.jwt.claim.sub` the writer
 * compares it against are then two readings of one value, so they cannot disagree.
 * It also makes a repository call outside a request (an integration test, a job)
 * record the correct actor instead of `null`, without the caller having to seed a
 * request context it does not have.
 */
async function flushAudit(
  tx: TransactionContext,
  entries: readonly AuditEntry[],
  actor: TransactionActor,
): Promise<void> {
  const actorUserId =
    actor !== null && actor.kind === "user" ? actor.userId : null;
  // Redaction is re-applied here, at the persistence boundary, not only in the
  // builder: `redactAuditEntry` is idempotent, and running it again is what makes
  // "no secret reaches `audit_logs`" a property of this function rather than a
  // property of every call site's discipline.
  const payload = JSON.stringify(
    entries.map((entry) => redactAuditEntry({ ...entry, actorUserId })),
  );

  await tx.execute(sql`reset role`);
  await tx.execute(sql`set local role ses_api`);
  await tx.execute(sql`select public.write_audit_logs(${payload}::jsonb)`);
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
  // Set for both cases: the grants are attached to the role, so an anonymous
  // transaction that skipped this line would be denied rather than restricted.
  await tx.execute(sql`set local role authenticated`);

  if (actor.kind === "anonymous") {
    return;
  }

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
