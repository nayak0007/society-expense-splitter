/**
 * Reading a Postgres failure through Drizzle, once.
 *
 * Extracted from the society module's `society.rows.ts` when the building module
 * needed the same thing. The extraction is not tidiness: the code below embodies
 * a bug that took a live database to find, and a second copy is a second chance
 * to reintroduce it — in a module whose tests, by construction, hand-build
 * driver-shaped errors and so would not notice.
 *
 * What travelled here: the SQLSTATE vocabulary, the driver error's shape, and the
 * `cause`-chain walk. What stayed behind in each module is the part that is
 * genuinely its own — which codes mean what, and which message a user should
 * read.
 */

/**
 * A `postgres.js` error, narrowed.
 *
 * Field names are the driver's: Postgres's `DETAIL` arrives as `detail` and
 * `HINT` as `hint`. Only `code` and `message` are guaranteed; the rest are
 * present when the server sent them.
 */
export interface PostgresErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly detail?: string;
  readonly hint?: string;
  /**
   * The violating constraint, under both of the names it arrives as.
   *
   * Postgres calls the field `constraint` in the error report; `postgres.js`
   * surfaces it as `constraint_name` when the server sent one, and the message
   * usually names it too. Both are declared because a classifier that matched on
   * only one of them silently loses every constraint-specific mapping — the same
   * failure mode as the `detail`/`details` difference recorded in the modules'
   * row files.
   */
  readonly constraint?: string;
  readonly constraint_name?: string;
}

/**
 * SQLSTATE codes this application raises or reacts to.
 *
 * `P0002`/`P0003` are Postgres's `no_data_found`/`insufficient_privilege`
 * condition names, used here for the app's own "not found" and "not permitted"
 * exceptions so that a raised refusal travels as a code a classifier can switch
 * on rather than as a message it has to parse (see
 * `supabase/migrations/20260920130200_society_rpc.sql`).
 */
export const SQLSTATE = {
  raised: "P0001",
  notFound: "P0002",
  forbidden: "P0003",
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  insufficientPrivilege: "42501",
  undefinedTable: "42P01",
} as const;

/**
 * How far a wrapped error's `cause` chain is followed before giving up.
 *
 * Bounded so a self-referential chain cannot loop, and generous enough for the
 * one wrapper that exists today plus any future aggregation layer.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * The driver error behind whatever was thrown, unwrapping ORM wrappers.
 *
 * **This function was wrong until a live database proved it, and the correction
 * is the difference between a working error contract and none at all.**
 *
 * `db.execute()`/`tx.execute()` do not rethrow `postgres.js`'s error. Drizzle
 * wraps it in a `DrizzleQueryError` whose own properties are `query`, `params`
 * and `cause`, so on the object a repository actually catches `code`, `detail`,
 * `hint` and `constraint_name` are all `undefined`. Reading `error.code` directly
 * therefore sent **every** database failure to the `unknown` branch: a
 * cross-tenant write answered `500` instead of `404`, a duplicate name `500`
 * instead of `409`, the sole-admin refusal `500` instead of `403`, and a
 * join-code collision retry could never fire. The unit tests stayed green
 * throughout, because they hand-build driver-shaped errors and so never meet the
 * wrapper that production always throws.
 *
 * The chain is walked rather than read one level deep on purpose: how Drizzle
 * nests its wrapper is the ORM's business, and pinning `cause[0]` would put this
 * function back where it started the day it nests one layer more. When no link
 * carries a SQLSTATE the deepest object is returned, so message-based fallbacks
 * still match against the server's own text rather than the wrapper's
 * `Failed query: …`.
 */
export function asErrorLike(error: unknown): PostgresErrorLike {
  let candidate: unknown = error;
  let deepest = (error ?? {}) as PostgresErrorLike;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (candidate === null || candidate === undefined) break;

    const current = candidate as PostgresErrorLike;
    deepest = current;
    if (typeof current.code === "string" && current.code !== "") {
      return current;
    }

    candidate = (candidate as { readonly cause?: unknown }).cause;
  }

  return deepest;
}

/** True when the failure is Postgres refusing the row, whoever wrote the policy. */
export function isRowLevelSecurityDenial(error: unknown): boolean {
  const candidate = asErrorLike(error);
  return /row-level security|permission denied/i.test(candidate.message ?? "");
}
