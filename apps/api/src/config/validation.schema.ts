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
 * deprecated `z.string().url()`.
 *
 * HOW FAILURES ARE REPORTED, precisely, because the two stages differ. Field
 * errors are collected by one `safeParse`, so a boot lists every bad field
 * together rather than one per redeploy. The cross-field rules in
 * `collectAssertions` then run on the *parsed* object, so they are skipped
 * entirely when any field error exists — a single bad `PORT` therefore masks a
 * missing `SENTRY_DSN`, and the next deploy reveals it. Accepted knowingly: the
 * cross-field rules read typed values (a URL's role, the `NODE_ENV` enum), so
 * running them on unvalidated input would mean re-deriving that typing by hand
 * for a case the operator is already fixing.
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

/**
 * A boolean that a `.env` file can actually express.
 *
 * `z.coerce.boolean()` is wrong for this and would have shipped a footgun:
 * JavaScript's `Boolean("false")` is `true`, so `STORAGE_AUTO_CREATE_BUCKET=false`
 * — the value `.env.example` documents — would have switched the feature **on**.
 * Accepting the two spellings people write, and refusing anything else, keeps a
 * misconfiguration loud instead of inverted.
 */
const booleanishSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const envSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  /** Bind address. 0.0.0.0 is required inside a container. */
  HOST: z.string().default("0.0.0.0"),

  // ── Data tier (SAD §19.2) ────────────────────────────────────────────────
  /** Runtime connection: role-scoped, subject to RLS. */
  DATABASE_URL: z.url(),
  /** Owner connection for DDL only. Used by `db:*` scripts (ADR-0008). */
  MIGRATION_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** SAD §14.4: `statement_timeout` for API connections. Workers use 120s. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Connection pool ceiling. Sizing for MVP is 2 × API at 1 vCPU (SAD §1.6). */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /**
   * Overrides where the migration history lives. Empty in every normal
   * checkout — the runner resolves `supabase/migrations` from the working
   * directory upward — and set in the container image, which ships the SQL at
   * `/app/migrations` (`infra/docker/api.Dockerfile`). Read by the readiness
   * probe via `AppConfig`, so the probe looks in the same directory the
   * deploy-time migrate step applied.
   */
  MIGRATIONS_DIR: z.string().min(1).optional(),

  // ── Membership cache (SAD §9.4) ──────────────────────────────────────────
  /**
   * Where the guard's membership read is cached.
   *
   * `redis` is the only value that is correct for more than one API instance, and
   * the default. `memory` exists for single-process development and for the e2e
   * suite, which needs the ordering protocol without a Redis deployment. `off`
   * removes the cache entirely, which is what a build with no Redis should use if
   * it would rather not pay a failed connection attempt per request.
   */
  MEMBERSHIP_CACHE_STORE: z.enum(["redis", "memory", "off"]).default("redis"),
  /** SAD §9.4's "cached 5 min". Lowered, it shortens the worst case, never raises it. */
  MEMBERSHIP_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // ── Supabase (identity + storage) ────────────────────────────────────────
  SUPABASE_URL: z.url(),
  /** Expected `iss` claim on every access token (SAD §9.1). */
  SUPABASE_JWT_ISSUER: z.url(),
  /**
   * Admin operations only. This key bypasses RLS, so it must never serve a
   * user-facing query — the runtime connection uses DATABASE_URL instead.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(32),

  /**
   * Which S3-compatible store the object bytes live in — SAD §19.2's
   * `STORAGE_PROVIDER`. **A label for a set of defaults, never a choice of code
   * path**, and in a deployed environment it names the endpoint an operator
   * actually runs rather than a vendor.
   *
   * ## `minio` is the default, and it is the *only* local-only value
   *
   * `minio` as the schema default is what makes a fresh checkout work with no
   * storage configuration at all: the local endpoint and the local compose
   * credentials below fill in, and `pnpm dev:infra` is enough to upload a bill. The
   * production guard in `collectAssertions` then refuses `minio` outside
   * development, so the default can never be shipped by accident.
   *
   * ## Where the bytes live in a deployed environment (2026-10-07)
   *
   * Deployment intent: Supabase provides **PostgreSQL and Auth only**; the API,
   * Redis and the S3-compatible object store run on a VPS. SAD §14.2's
   * "MinIO local, Supabase staging/production" matrix predates that decision. So no
   * value here is *required* by production: `s3` is the provider-neutral value for an
   * operator-hosted S3-compatible endpoint (the VPS store included) and needs only
   * `STORAGE_ENDPOINT`, `STORAGE_REGION`, the access-key pair and `STORAGE_BUCKET`;
   * `supabase` is exact about Supabase Storage's own endpoint (derived from
   * `SUPABASE_URL`) and remains supported; `r2` stays for a Cloudflare bucket.
   *
   * ## All four values pick the *same* adapter
   *
   * ADR-0012's measurement is explicit that one S3-compatible adapter serves every
   * provider — endpoint, region, credentials, bucket and path-style addressing are
   * the only differences. `s3` therefore already subsumes the other three *as a
   * label*; collapsing the enum to `s3` plus an explicit `local` is a worthwhile
   * later cleanup and is deliberately not done here, because it would churn a
   * contract (`apps/api/.env.example`, docs and tests) for naming purity only — see
   * the recommendation recorded in ADR-0012.
   */
  STORAGE_PROVIDER: z.enum(["minio", "supabase", "r2", "s3"]).default("minio"),
  STORAGE_BUCKET: z.string().min(1).default("ses-attachments"),
  /**
   * The S3 API endpoint — the value that actually determines which store the bytes
   * reach; `STORAGE_PROVIDER` above only supplies defaults. Optional because two of
   * the four labels can be defaulted: `minio` to the compose service in development,
   * and `supabase` to the project's own storage hostname, derived from `SUPABASE_URL`
   * by the adapter. Required outside development — including for `s3`, where there is
   * no default to fall back on — where a wrong or missing endpoint must fail at boot
   * rather than at the first upload.
   */
  STORAGE_ENDPOINT: z.url().optional(),
  /** SigV4 signing region. Defaulted because MinIO and Supabase Storage both ignore
   * it in practice (ADR-0012 D1 probes 15 and 27 — `ap-northeast-2` and `us-east-1`
   * were both accepted) while `r2`/`s3` genuinely need one. */
  STORAGE_REGION: z.string().min(1).default("us-east-1"),
  /**
   * The S3 access key pair. **Server-side only.** These are never returned to a
   * client, never logged, and never placed in the OpenAPI document: the client
   * receives a presigned URL and the headers its signature expects, which is a
   * *derived* credential bound to one object, one method, one byte count and one
   * expiry. Required outside development.
   */
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /**
   * Path-style addressing (`…/bucket/key`) rather than virtual-hosted
   * (`bucket.…/key`). Defaulted to `true` because both shipped configurations need
   * it: MinIO on a bare hostname cannot resolve a bucket subdomain, and Supabase
   * Storage's S3 endpoint served path-style in every probe ADR-0012 records. A
   * Cloudflare or AWS bucket sets it `false`.
   */
  STORAGE_FORCE_PATH_STYLE: booleanishSchema.default(true),
  /**
   * Create the bucket at boot if it is absent. **Off everywhere but local
   * development and the integration suite**, and there for one concrete reason: the
   * previous local setup created the bucket with a `createbuckets` companion
   * service running `minio/mc`, and that image no longer exists (see
   * `infra/docker/docker-compose.dev.yml`). Doing it from the API's own SDK is the
   * smallest maintainable replacement — no second image, no second service, no
   * shell loop polling a health endpoint — and it stays opt-in so that a deployed
   * process never rearranges a production bucket.
   */
  STORAGE_AUTO_CREATE_BUCKET: booleanishSchema.default(false),
  /**
   * The presign lifetime. 900 seconds, which is SAD §10.1's "15 min" and the
   * Roadmap's acceptance sentence, and is verified against both providers
   * (`X-Amz-Expires=900`; ADR-0012 D1 probes 6, 7 and 20). Configurable so the
   * integration suite can mint a 1-second URL to prove expiry is enforced, and for
   * no other reason — a longer window is a larger leak, so nothing reads it to
   * extend a credential's life in production.
   */
  STORAGE_PRESIGN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(604_800)
    .default(900),

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
    // ── Object storage ───────────────────────────────────────────────────────
    //
    // Deployment intent (2026-10-07): Supabase is the managed PostgreSQL and Auth
    // tier, and bytes live in an operator-hosted S3-compatible store (the VPS one) or
    // in any other compatible endpoint an environment is configured for — ADR-0012
    // measured Supabase Storage as verified-compatible and the pinned local MinIO as
    // the *local/test* provider. The rule below is therefore about shape, not vendor:
    // name a real endpoint, and bring credentials. Both failures are silent, which is
    // why both are asserted rather than documented — a deployed process pointed at a
    // developer's compose MinIO would "work" until the first upload went nowhere, and
    // a deployed process with no credentials would boot happily and fail its first
    // presign.
    if (env.STORAGE_PROVIDER === "minio") {
      problems.push(
        "STORAGE_PROVIDER: `minio` is the local compose store only; a deployed environment must name the S3-compatible store it targets (`s3` for an operator-hosted endpoint such as the VPS object store, or `supabase`/`r2`)",
      );
    }
    if (!env.STORAGE_ENDPOINT) {
      problems.push(
        "STORAGE_ENDPOINT: required when NODE_ENV is production or staging",
      );
    }
    if (!env.STORAGE_ACCESS_KEY_ID) {
      problems.push(
        "STORAGE_ACCESS_KEY_ID: required when NODE_ENV is production or staging",
      );
    }
    if (!env.STORAGE_SECRET_ACCESS_KEY) {
      problems.push(
        "STORAGE_SECRET_ACCESS_KEY: required when NODE_ENV is production or staging",
      );
    }

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
