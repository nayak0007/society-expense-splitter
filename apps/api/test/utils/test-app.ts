import { Test } from "@nestjs/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { HealthIndicatorResult } from "@nestjs/terminus";
import type { JWTVerifyGetKey } from "jose";
import type { SocietyRepository } from "@ses/domain";

import { AppModule } from "../../src/app.module";
import { createAdapter, GLOBAL_PREFIX } from "../../src/bootstrap";
import { SUPABASE_JWKS } from "../../src/common/auth/supabase-jwt";
import { MigrationsIndicator } from "../../src/modules/health/indicators/migrations.indicator";
import { PostgresIndicator } from "../../src/modules/health/indicators/postgres.indicator";
import { RedisIndicator } from "../../src/modules/health/indicators/redis.indicator";
import { SOCIETY_REPOSITORY } from "../../src/modules/societies/application/society.tokens";

/**
 * Boots the **real** `AppModule` for integration tests.
 *
 * Using the production module rather than a hand-assembled one is the point: the
 * global prefix, the exception filter and the interceptor are all registered in
 * `app.module.ts` via `APP_FILTER`/`APP_INTERCEPTOR`, so a test that rebuilds the
 * pipeline itself verifies a pipeline that does not ship. The classic version of
 * that bug is an error shape asserted in tests and wrong in production.
 *
 * Only the three health indicators are replaced. Everything else — configuration
 * validation, DI wiring, routing, the error envelope — runs exactly as deployed.
 * No database or Redis is contacted: both connect lazily, and the indicators that
 * would exercise them are faked here.
 *
 * The HTTP adapter and the global prefix come from `src/bootstrap.ts`, the same
 * module `main.ts` uses, so a setting that only exists in the real bootstrap
 * cannot pass here unnoticed. That is not a hypothetical: this harness originally
 * built its own bare `FastifyAdapter`, and the request-id assertion failed with
 * `req-1` because the adapter's `genReqId` lived only in `main.ts`.
 */

export type DependencyState = "up" | "down";

export type TestAppOptions = {
  postgres?: DependencyState;
  redis?: DependencyState;
  migrations?: DependencyState;
  /**
   * Substitutes the key set the auth guard verifies against.
   *
   * Needed because the real one fetches Supabase's JWKS over the network: a
   * suite that signed real tokens against a remote project could not run offline
   * and would verify Supabase's uptime rather than our guard. Omitting it leaves
   * the real provider in place, which is what the health suite wants — no token
   * is ever presented there.
   *
   * `SUPABASE_JWKS` is not exported from `AuthModule`, and overriding by token
   * does not need it to be: Nest resolves overrides against the module graph.
   */
  jwks?: JWTVerifyGetKey;
  /**
   * Substitutes the society repository — the tenancy and storage boundary.
   *
   * Everything above it runs for real (see the module docstring), so a suite
   * using this still exercises the guard, the pipes, the use cases and the
   * mappers. Without it, every society route would need a live database.
   */
  repository?: SocietyRepository;
};

/** A stand-in indicator whose only job is to report the status the test asked for. */
function fakeIndicator(
  key: string,
  state: DependencyState,
  detail?: Record<string, unknown>,
) {
  return {
    check: (): Promise<HealthIndicatorResult> =>
      Promise.resolve({
        [key]: { status: state, ...(detail ?? {}) },
      } as HealthIndicatorResult),
  };
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PostgresIndicator)
    .useValue(fakeIndicator("postgres", options.postgres ?? "up"))
    .overrideProvider(RedisIndicator)
    .useValue(fakeIndicator("redis", options.redis ?? "up"))
    .overrideProvider(MigrationsIndicator)
    .useValue(
      fakeIndicator("migrations", options.migrations ?? "up", {
        detail: "test fixture",
      }),
    );

  if (options.jwks !== undefined) {
    builder.overrideProvider(SUPABASE_JWKS).useValue(options.jwks);
  }
  if (options.repository !== undefined) {
    builder.overrideProvider(SOCIETY_REPOSITORY).useValue(options.repository);
  }

  const moduleRef = await builder.compile();

  const app =
    moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());

  app.setGlobalPrefix(GLOBAL_PREFIX);

  await app.init();
  // Fastify only serves once its own plugin graph has finished loading.
  await app.getHttpAdapter().getInstance().ready();

  return app;
}
