import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type postgres from "postgres";

import { DatabaseService } from "../../src/infrastructure/database/database.service";
import { UnitOfWork } from "../../src/infrastructure/database/unit-of-work";

import { ownerClient } from "./integration-db";
import { createTestAuth } from "./supabase-auth";
import type { TestAuth } from "./supabase-auth";
import { createTestApp } from "./test-app";

/**
 * Boots the real application against the containers the global setup started.
 *
 * One boot per spec file, closed in `afterAll`. Two connections exist on purpose
 * and they are not interchangeable:
 *
 * - the **app** (through `DatabaseService` → `UnitOfWork`) logs in as
 *   `authenticator` and is therefore subject to every policy. That is the code
 *   under test;
 * - the **owner** connection is for fixtures and for assertions that must see the
 *   truth regardless of tenancy. Reading a row with it proves nothing about RLS,
 *   so it is used to establish preconditions and to check what actually landed.
 *
 * `createTestAuth()` is passed in so the guard chain resolves tokens against a
 * local key pair rather than reaching Supabase over the network: a suite that
 * verified against the hosted project would test Supabase's uptime, and would
 * fail on an offline runner. The *verifier* is still the real one — issuer,
 * audience and algorithm pinning all run exactly as deployed (T018).
 */
export interface IntegrationHarness {
  readonly app: NestFastifyApplication;
  readonly unitOfWork: UnitOfWork;
  readonly database: DatabaseService;
  readonly owner: postgres.Sql;
  readonly auth: TestAuth;
  stop(): Promise<void>;
}

export async function startIntegrationHarness(): Promise<IntegrationHarness> {
  const auth = await createTestAuth();
  const app = await createTestApp({
    realInfrastructure: true,
    jwks: auth.jwks,
  });

  const owner = ownerClient(ownerUrl());

  return {
    app,
    unitOfWork: app.get(UnitOfWork),
    database: app.get(DatabaseService),
    owner,
    auth,
    async stop() {
      await owner.end({ timeout: 5 });
      await app.close();
    },
  };
}

/**
 * The owner URL, read from the process the env loader configured.
 *
 * Read lazily rather than at module scope: `setup-env.ts` runs before the first
 * import, but a module-scope read here would still be evaluated during the module
 * graph's own initialisation, which is a rule nobody should have to remember.
 */
export function ownerUrl(): string {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "MIGRATION_DATABASE_URL is unset — test/integration/setup-env.ts did not run. Check the jest-integration.config.cjs `setupFiles` entry.",
    );
  }
  return url;
}
