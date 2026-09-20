import type { NodeEnv } from "./validation.schema";

/**
 * Placeholder environment for maintenance tools that must boot the module graph
 * without a real deployment behind them.
 *
 * ## Why this exists
 *
 * `ConfigModule.forRoot({ validate })` runs while the module graph is being
 * constructed, so a missing variable aborts the process *before* any tool's own
 * code runs. For the OpenAPI export that was not a loud failure but a silent one:
 * `pnpm openapi` exited 1 having printed nothing at all, because the throw
 * happened during module evaluation, outside every handler in the entry file. The
 * API's own `main.ts` shows a readable error only because Nest's bootstrap catches
 * it — a tool has nothing to catch it with unless the import is deferred too (see
 * `tools/export-openapi.ts`).
 *
 * A silent red gate is the worst kind: `contract:drift` runs in CI, so the failure
 * would have read simply "process exited with code 1" with no clue that the cause
 * was a new required variable that nobody added to the workflow.
 *
 * ## Why the values are harmless
 *
 * The OpenAPI document is derived from route decorators. No service is contacted
 * while building it, because every connection in the graph is lazy by design —
 * `DatabaseService` and `RedisService` open their pools on first use, and the
 * exporter closes the application without ever issuing a query. These values exist
 * so the schema is satisfied, not so anything can connect. The credentials are
 * deliberately non-functional and obviously so.
 *
 * ## What it deliberately does not do
 *
 * **It never overwrites a variable that is already set.** A real environment always
 * wins, so this cannot mask a genuine misconfiguration in staging or production —
 * an unset variable is the only thing it touches, which is precisely the case it
 * exists for.
 */

/** The variables `envSchema` requires with no default (SAD §19.2). */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  DATABASE_URL:
    "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder",
  MIGRATION_DATABASE_URL:
    "postgresql://placeholder_owner:placeholder@127.0.0.1:5432/placeholder",
  REDIS_URL: "redis://127.0.0.1:6379",
  SUPABASE_URL: "https://placeholder.supabase.co",
  SUPABASE_JWT_ISSUER: "https://placeholder.supabase.co/auth/v1",
  // ≥32 characters, because the schema enforces the length of a real key.
  SUPABASE_SERVICE_ROLE_KEY:
    "placeholder-service-role-key-for-route-introspection",
};

/**
 * Fills in only the variables that are entirely unset. Returns the names it
 * supplied so a caller can mention them, which is how "the workflow is missing a
 * new variable" becomes visible instead of invisible.
 */
export function seedToolEnvironment(
  nodeEnv: NodeEnv = "test",
): readonly string[] {
  const supplied: string[] = [];

  for (const [key, value] of Object.entries(PLACEHOLDERS)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      supplied.push(key);
    }
  }

  // `test` rather than `development`: it is the only value that is neither a real
  // deployment nor subject to the production assertions (a required SENTRY_DSN, a
  // rejected `rzp_test_` key), which would otherwise fire for a tool that is not
  // deploying anything.
  process.env.NODE_ENV ??= nodeEnv;

  return supplied;
}
