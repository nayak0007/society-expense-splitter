import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { StartedRedisContainer } from "@testcontainers/redis";

/**
 * The two real dependencies the integration suite runs against — Roadmap T034,
 * SAD §15.4 ("Jest + Supertest + Testcontainers (real Postgres, real Redis, real
 * migrations). No mocked database — a mocked database cannot catch a broken
 * constraint, and constraints are load-bearing here.").
 *
 * ## Why these images, pinned
 *
 * `postgres:18-alpine` is not a convenience pick: the CI `test-db` job already
 * applies the whole migration history to exactly this image, and local
 * development ran Postgres 18, so an integration run is the *same* engine the
 * history has been proven against. `latest` would silently move the engine under
 * a suite whose entire job is to notice engine-level behaviour (RLS predicates,
 * `SECURITY DEFINER` helpers, advisory locks), and a moving tag makes a red run
 * unattributable. Hosted Supabase is PostgreSQL 17 — that difference is not
 * hidden, it is the reason the hosted project remains the final compatibility
 * proof (SAD §15.4 and §16.4 keep the two layers separate on purpose).
 *
 * `redis:7-alpine` matches `infra/docker/docker-compose.dev.yml`.
 *
 * ## Why the image is the *stock* Postgres and not a Supabase image
 *
 * The migration history is self-sufficient on a plain server: its first entry,
 * `20260919120000_bootstrap.sql`, recreates the Supabase *interface* the policies
 * need (`auth.users`, `auth.uid()`, `auth.role()`, and the
 * `anon`/`authenticated`/`service_role`/`authenticator` roles) behind an
 * `is_supabase` guard, and is skipped entirely on a hosted project. So there is no
 * test-only schema and no compatibility shim in this directory: the fixture is
 * committed production SQL, and the container runs the same chain `pnpm db:migrate`
 * runs. See `docs/guides/INTEGRATION_TESTS.md`.
 *
 * ## Credentials mirror the CI database job
 *
 * `postgres` / `postgres` / database `ses` is what `.github/workflows/ci.yml`'s
 * service container uses, so the connection strings a suite sees here are the
 * ones CI uses. The `authenticator` role that the runtime `DATABASE_URL` logs in
 * as is created by the bootstrap migration (with the password the committed
 * `.env.example` documents) — the suite does not create it.
 */

/** The role the API connects as; created by the bootstrap migration. */
const RUNTIME_ROLE = "authenticator";

export interface IntegrationInfrastructure {
  /** The migration runner's connection. Owns the schema; bypasses RLS. */
  readonly ownerUrl: string;
  /** The API's connection. `authenticator`, restricted by RLS. */
  readonly runtimeUrl: string;
  readonly redisUrl: string;
  readonly postgres: StartedPostgreSqlContainer;
  readonly redis: StartedRedisContainer;
}

/**
 * A container stage failure that says *which* stage failed.
 *
 * T034's whole risk is a suite that hangs or fails for a reason the reader cannot
 * see: Docker not installed, an image that cannot be pulled (a proxy or a rate
 * limit), a server that never became ready, the migration chain, or the
 * assertion itself. Letting Testcontainers' own error escape makes all four look
 * alike in a Jest timeout. Every step below is therefore wrapped so the message
 * names the stage, and the classifier turns the two common signatures into
 * sentences rather than a stack trace.
 */
export class IntegrationInfrastructureError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    // `override` because `Error` already declares `cause`; assigning it keeps the
    // original failure reachable from a CI log instead of being flattened into a
    // message.
    override readonly cause?: unknown,
  ) {
    super(`[integration:${stage}] ${message}`);
    this.name = "IntegrationInfrastructureError";
  }
}

function classify(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();

  if (
    text.includes("enoent") ||
    text.includes("command not found") ||
    text.includes("cannot connect to the docker daemon") ||
    text.includes("econnrefused") ||
    text.includes("docker.sock") ||
    // The exact wording Testcontainers 12 uses when no strategy works out —
    // measured, not guessed, by running this suite on a machine with no Docker:
    // `[integration:postgres] Could not find a working container runtime strategy`.
    text.includes("container runtime strategy")
  ) {
    return (
      `${raw}\n\nThe container runtime is not reachable. This suite needs a ` +
      `working Docker (or Podman with a Docker socket) — it deliberately does NOT ` +
      `fall back to mocks, because a mocked database cannot catch the constraint ` +
      `and policy failures this suite exists for. Start Docker and re-run, or run ` +
      `the unit suite instead: \`pnpm --filter @ses/api test\`.`
    );
  }

  if (
    text.includes("manifest") ||
    text.includes("pull access denied") ||
    text.includes("toomanyrequests") ||
    text.includes("no such image")
  ) {
    return `${raw}\n\nThe image could not be pulled. Check registry access (proxy, rate limit, or an offline runner) before treating this as a test failure.`;
  }

  if (text.includes("timeout") || text.includes("timed out")) {
    return `${raw}\n\nThe container did not become ready within its wait budget.`;
  }

  return raw;
}

async function stage<T>(name: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    process.stdout.write(
      `[integration] ${name} ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
    );
    return result;
  } catch (error) {
    throw new IntegrationInfrastructureError(name, classify(error), error);
  }
}

/** Starts both containers and returns the connections the suite runs against. */
export async function startInfrastructure(): Promise<IntegrationInfrastructure> {
  const postgres = await stage("postgres", async () =>
    new PostgreSqlContainer("postgres:18-alpine")
      .withUsername("postgres")
      .withPassword("postgres")
      .withDatabase("ses")
      .start(),
  );

  const redis = await stage("redis", async () =>
    new RedisContainer("redis:7-alpine").start(),
  );

  const host = postgres.getHost();
  const port = postgres.getMappedPort(5432);

  return {
    // The owner connection the migration runner uses (SAD §8.7: DDL is
    // owner-only, and the runtime role is deliberately too weak to write it).
    ownerUrl: `postgresql://postgres:postgres@${host}:${port}/ses`,
    // The connection the API uses: `authenticator`, which can `SET ROLE
    // authenticated` but owns nothing and is subject to every policy.
    runtimeUrl: `postgresql://${RUNTIME_ROLE}:${RUNTIME_ROLE}@${host}:${port}/ses`,
    redisUrl: redis.getConnectionUrl(),
    postgres,
    redis,
  };
}

/** Stops both containers. Called from the global setup's returned teardown. */
export async function stopInfrastructure(
  infrastructure: IntegrationInfrastructure,
): Promise<void> {
  // Parallel, because the two are independent and a stopped container is a
  // network round trip each.
  await Promise.allSettled([
    infrastructure.postgres.stop({ remove: true, removeVolumes: true }),
    infrastructure.redis.stop({ remove: true, removeVolumes: true }),
  ]);
}
