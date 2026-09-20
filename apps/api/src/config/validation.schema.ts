import { z } from "zod";

/**
 * Environment schema — SAD §19.2.
 *
 * "Validated at boot with Zod; the process **refuses to start** on a missing or
 * malformed variable. A config error must fail loudly at deploy time, never
 * silently at 2am when a code path first reads `undefined`."
 *
 * Two deliberate departures from the SAD's literal schema:
 *
 * 1. **Vendor secrets are optional until their adapter exists.** The SAD lists
 *    Razorpay, MSG91, Resend, Expo, Anthropic and Gemini keys as required. Those
 *    modules are not built yet, so requiring them today would make the process
 *    refuse to boot for no reason, and the "missing variable" error would be
 *    noise that trains people to add dummy values. Each becomes required in the
 *    same change that ships its adapter.
 * 2. **`MIGRATION_DATABASE_URL` is added.** The SAD has a single `DATABASE_URL`,
 *    but DDL and request handling must not share a role: the runtime connection
 *    is role-scoped to `authenticated` so RLS applies (see SAD §8.7), while
 *    migrations need an owner. One URL would force the API to hold owner
 *    credentials at runtime, which silently disables every policy.
 *
 * Zod is v4 in this workspace (the SAD says v3): `z.url()` replaces the
 * deprecated `z.string().url()`, and cross-field rules are plain assertions in
 * `validateEnv` rather than `.superRefine`, so every problem can be reported in
 * one message instead of the first one Zod reaches.
 */

/**
 * `test` is included on purpose: Jest sets `NODE_ENV=test`, and a schema that
 * rejected it would make every unit test that builds configuration fail for a
 * reason unrelated to the code under test.
 */
export const nodeEnvSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

export const envSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  /** Bind address. 0.0.0.0 is required inside a container. */
  HOST: z.string().default("0.0.0.0"),

  // ── Data tier (SAD §19.2) ────────────────────────────────────────────────
  /** Runtime connection: role-scoped, subject to RLS. */
  DATABASE_URL: z.url(),
  /** Owner connection for DDL only. Used by drizzle-kit and scripts/db/*. */
  MIGRATION_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** SAD §14.4: `statement_timeout` for API connections. Workers use 120s. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Connection pool ceiling. Sizing for MVP is 2 × API at 1 vCPU (SAD §1.6). */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // ── Supabase (identity + storage) ────────────────────────────────────────
  SUPABASE_URL: z.url(),
  /** Expected `iss` claim on every access token (SAD §9.1). */
  SUPABASE_JWT_ISSUER: z.url(),
  /**
   * Admin operations only. This key bypasses RLS, so it must never serve a
   * user-facing query — the runtime connection uses DATABASE_URL instead.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(32),

  STORAGE_PROVIDER: z.enum(["supabase", "r2", "s3"]).default("supabase"),
  STORAGE_BUCKET: z.string().min(1).default("ses-attachments"),

  // ── Observability ────────────────────────────────────────────────────────
  SENTRY_DSN: z.url().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional(),

  // ── Vendors: optional until the adapter that consumes them lands ─────────
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  MSG91_AUTH_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** hex, 32 bytes — SAD §19.2. */
  ENCRYPTION_KEY: z.string().length(64).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Thrown instead of `process.exit` so the failure is testable, and so every
 * problem is reported at once rather than one per redeploy.
 */
export class EnvironmentValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n\n` +
        "See apps/api/.env.example for the full list, and SAD §19.2 for the rules.",
    );
    this.name = "EnvironmentValidationError";
  }
}

/**
 * Cross-field rules. Returned as strings rather than thrown so all of them are
 * collected before failing.
 */
function collectAssertions(env: Env): string[] {
  const problems: string[] = [];
  const isProductionish =
    env.NODE_ENV === "production" || env.NODE_ENV === "staging";

  if (isProductionish) {
    // SAD §19.2: "That last check has saved real companies real money. Keep it."
    if (!env.SENTRY_DSN) {
      problems.push(
        "SENTRY_DSN: required when NODE_ENV is production or staging",
      );
    }
    if (env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")) {
      problems.push(
        "RAZORPAY_KEY_ID: a test key cannot be used in production or staging",
      );
    }
    if (!env.ENCRYPTION_KEY) {
      problems.push(
        "ENCRYPTION_KEY: required when NODE_ENV is production or staging",
      );
    }
  }

  // If the runtime and migration URLs share a database role, the API is holding
  // owner credentials — which in Postgres means RLS is no longer enforced on it.
  // That is exactly the defence-in-depth SAD §8.7 and §1.7 rely on, and it fails
  // silently, so it is asserted here rather than documented.
  const runtimeRole = parseRole(env.DATABASE_URL);
  const migrationRole = parseRole(env.MIGRATION_DATABASE_URL);
  if (
    runtimeRole &&
    migrationRole &&
    runtimeRole === migrationRole &&
    isProductionish
  ) {
    problems.push(
      `DATABASE_URL and MIGRATION_DATABASE_URL both connect as "${runtimeRole}": ` +
        "the runtime connection must use a role that cannot bypass RLS",
    );
  }

  return problems;
}

/** Extracts the username from a Postgres URL, or undefined if it cannot. */
function parseRole(url: string): string | undefined {
  try {
    const { username } = new URL(url);
    return username === "" ? undefined : decodeURIComponent(username);
  } catch {
    return undefined;
  }
}

/**
 * Drops keys whose value is an empty string.
 *
 * An empty value is not an unset one everywhere else, but here it must be: a
 * shell can export `PORT=` and dotenv will not override a variable that already
 * exists, and `.env.example` is full of intentionally-blank placeholders
 * (`SENTRY_DSN=`, `RAZORPAY_KEY_ID=`). Without this, copying `.env.example`
 * produces `Invalid URL` for every optional URL and "Too small: expected number
 * to be >0" for `PORT` — messages that name the wrong problem entirely. Treating
 * blank as absent is also what a human means by writing `PORT=`.
 */
function withoutEmptyValues(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * The single validation entry point, used as `@nestjs/config`'s `validate`.
 *
 * Returning only the parsed object (rather than the raw environment) is what
 * makes `ConfigService` a closed vocabulary: a typo'd variable name cannot be
 * read at all, because it is not in the returned object.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(withoutEmptyValues(raw));

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new EnvironmentValidationError(problems);
  }

  const problems = collectAssertions(result.data);
  if (problems.length > 0) {
    throw new EnvironmentValidationError(problems);
  }

  return result.data;
}
