import { Test } from "@nestjs/testing";
import { DiscoveryModule } from "@nestjs/core";
import type { Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { HealthIndicatorResult } from "@nestjs/terminus";
import type { JWTVerifyGetKey } from "jose";
import type {
  ApartmentRepository,
  BuildingRepository,
  ExpenseCategoryRepository,
  ExpenseParticipantReader,
  ExpenseReferenceReader,
  ExpenseSocietyReader,
  InvitationRepository,
  InvitationTokenPort,
  MemberRepository,
  SocietyRepository,
  StructureMembershipReader,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../src/common/authorization/membership-reader";
import { SOCIETY_AUTHORIZATION_READER } from "../../src/common/authorization/society-authorization";
import type { SocietyAuthorizationReader } from "../../src/common/authorization/society-authorization";

import { AppModule } from "../../src/app.module";
import { createAdapter, GLOBAL_PREFIX } from "../../src/bootstrap";
import { SUPABASE_JWKS } from "../../src/common/auth/supabase-jwt";
import { MigrationsIndicator } from "../../src/modules/health/indicators/migrations.indicator";
import { PostgresIndicator } from "../../src/modules/health/indicators/postgres.indicator";
import { RedisIndicator } from "../../src/modules/health/indicators/redis.indicator";
import {
  INVITATION_REPOSITORY,
  INVITATION_TOKENS,
} from "../../src/modules/invitations/application/invitation.tokens";
import {
  EXPENSE_CATEGORY_REPOSITORY,
  EXPENSE_REFERENCE_READER,
} from "../../src/modules/expenses/application/expense-category.tokens";
import {
  EXPENSE_PARTICIPANT_READER,
  EXPENSE_SOCIETY_READER,
} from "../../src/modules/expenses/application/participant.tokens";
import { MEMBER_REPOSITORY } from "../../src/modules/members/application/member.tokens";
import { SOCIETY_REPOSITORY } from "../../src/modules/societies/application/society.tokens";
import {
  APARTMENT_REPOSITORY,
  BUILDING_REPOSITORY,
} from "../../src/modules/structure/application/structure.tokens";

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
 * `realInfrastructure` removes even those three replacements, for the suite that
 * wants the real dependencies (T034). The fake-repository seams are ignored in
 * that mode by definition, since their purpose is the opposite.
 *
 * The HTTP adapter and the global prefix come from `src/bootstrap.ts`, the same
 * module `main.ts` uses, so a setting that only exists in the real bootstrap
 * cannot pass here unnoticed. That is not a hypothetical: this harness originally
 * built its own bare `FastifyAdapter`, and the request-id assertion failed with
 * `req-1` because the adapter's `genReqId` lived only in `main.ts`.
 */

export type DependencyState = "up" | "down";

export type TestAppOptions = {
  /**
   * Boot the module with its **real** infrastructure — real Postgres, real
   * Redis, real repositories and `UnitOfWork` — instead of the fakes below.
   *
   * T034's integration suite sets this. It is the difference the coverage gate
   * cares about: everything this harness replaces is a seam an e2e suite has to
   * open, and `SET ROLE`/`auth.uid()`, `BEGIN`/`ROLLBACK`, a unique violation
   * translated into a domain error and an advisory lock are all behaviour that
   * exists *only* on the far side of those seams. A mocked database cannot catch
   * a broken constraint, which is SAD §15.4's whole sentence.
   *
   * With it set, every other option here is ignored: the seam options exist to
   * make a suite database-free, and asking for both is a contradiction.
   */
  realInfrastructure?: boolean;
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
  /**
   * Substitutes the guard chain's membership read (T038).
   *
   * A separate seam from `repository` because the two are bound to the same
   * instance via `useExisting`: a suite exercising the guards needs a reader it
   * controls, and one that swapped only `repository` would leave the real
   * Postgres adapter — and therefore a database — in the chain.
   */
  reader?: SocietyAuthorizationReader;
  /**
   * Substitutes the building repository (T042).
   *
   * A third seam, because the building routes are the first in the API to run the
   * whole guard chain: the society module's routes are addressed by a path
   * parameter and reach the database directly, so a suite that swapped only
   * `repository` still has a real `BuildingRepositoryPostgres` in the graph.
   */
  buildings?: BuildingRepository;
  /**
   * Substitutes the flat repository (T043).
   *
   * A fourth seam and not a widening of `buildings`: the two are separate ports
   * with separate adapters, and the flats' tests need one substituted while the
   * buildings' stay real — otherwise a suite could not exercise the
   * "building still has flats" refusal without a database.
   */
  apartments?: ApartmentRepository;
  /**
   * Substitutes the member repository (T045).
   *
   * A fifth seam, and the member routes are the first whose module needs **no** cross-module
   * membership reader: the caller's own membership is read from `members` by the same port, so
   * one fake covers the guard's separate read and the use cases' — see `members.module.ts` for
   * why that dependency is absent rather than forgotten.
   */
  members?: MemberRepository;
  /**
   * Substitutes the invitation repository (T047).
   *
   * A sixth seam, and the invitations module borrows the member fake through the `members` one:
   * "may this caller invite?" is the member module's `member.invite` cell, and the invitations e2e
   * suite points both seams at the same fixture on purpose rather than by accident — that shared
   * answer is exactly what the module reuse is for.
   */
  invitations?: InvitationRepository;
  /**
   * Substitutes the token port, or leaves the **real** one in place.
   *
   * Left real by default, and that is the interesting default: the digest the fake repository
   * receives is then genuinely `sha256(token)` of the token the caller was handed, so a suite can
   * assert the property that matters (the token travels; the digest is what storage sees) rather
   * than assert against a stub that agrees with itself.
   */
  invitationTokens?: InvitationTokenPort;
  /**
   * Substitutes the expense-category storage (T062) — **both** ports at once.
   *
   * One seam rather than two, and that is a deliberate departure from the
   * one-seam-per-port shape above: `EXPENSE_CATEGORY_REPOSITORY` and
   * `EXPENSE_REFERENCE_READER` are bound to the *same* adapter in production, and a
   * suite that replaced only one would leave the real Postgres adapter in the graph for
   * the other — so the category routes would reach for a database the moment a delete
   * counted references. The fake implements both interfaces (it holds the "expenses"
   * of a category as a number it can set), which is what makes one seam honest here.
   *
   * When T063 lands its own expense repository the two ports gain separate owners, and
   * this seam splits then — not before, because splitting it now would mean inventing a
   * second fake for a table no route writes.
   */
  categories?: ExpenseCategoryRepository & ExpenseReferenceReader;
  /**
   * Substitutes the society roster resolution reads (T063/T064) — **both** participant
   * ports at once, plus the membership read the resolver's use case performs.
   *
   * One seam rather than three, for the reason the `categories` seam records: the fake
   * directory is a *world* (flats, members, wings, buildings, the vacancy policy and the
   * caller's memberships), and splitting it would let a suite seed the flats in one fake
   * and the memberships in another — the drift a test fixture must not have. The same
   * object can be passed as `membershipReader`, exactly as the expenses e2e suite points
   * its two membership seams at one fixture on purpose.
   */
  participants?: ExpenseParticipantReader &
    ExpenseSocietyReader &
    StructureMembershipReader;
  /**
   * Substitutes the caller's membership read used by the building use cases.
   *
   * Separate from `reader` (which `SocietyGuard` uses) even though both are
   * satisfied by the same class in production: a suite has to be able to give the
   * guard one answer and the use case another to prove the two are independent
   * gates — and, in the ordinary case, must be able to point them at the same
   * fixture deliberately rather than by accident.
   */
  membershipReader?: StructureMembershipReader;
  /**
   * Extra controllers to mount alongside `AppModule`.
   *
   * The authorization chain has no production route to exercise yet: every
   * society route is addressed by a path parameter, and the header-scoped routes
   * belong to the modules that do not exist (expenses, payments). Rather than
   * invent a real endpoint or weaken a guard to make it testable, a suite mounts a
   * throwaway controller and lets the *global* guards govern it — which is also the
   * property worth proving, since a route registered here never opts into anything.
   */
  controllers?: readonly Type<unknown>[];
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
  const builder = Test.createTestingModule({
    // `DiscoveryModule` is not `@Global()`, so the route-inventory suite has to
    // ask for it: it is how that suite enumerates every controller the real
    // `AppModule` registered rather than a list maintained by hand — which is the
    // whole point of an inventory (a controller nobody remembered to list is
    // exactly the one it must catch). Nothing else reads it.
    imports: [DiscoveryModule, AppModule],
    controllers: [...(options.controllers ?? [])],
  });

  // The three indicators are what stand between "boots" and "contacts a
  // dependency": they are the only providers in the graph that reach out on
  // their own. Leaving them real is therefore what makes an integration run
  // touch Postgres and Redis at all.
  if (options.realInfrastructure !== true) {
    builder
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
  }

  if (options.jwks !== undefined) {
    builder.overrideProvider(SUPABASE_JWKS).useValue(options.jwks);
  }
  if (options.repository !== undefined) {
    builder.overrideProvider(SOCIETY_REPOSITORY).useValue(options.repository);
  }
  if (options.reader !== undefined) {
    builder
      .overrideProvider(SOCIETY_AUTHORIZATION_READER)
      .useValue(options.reader);
  }
  if (options.buildings !== undefined) {
    builder.overrideProvider(BUILDING_REPOSITORY).useValue(options.buildings);
  }
  if (options.apartments !== undefined) {
    builder.overrideProvider(APARTMENT_REPOSITORY).useValue(options.apartments);
  }
  if (options.members !== undefined) {
    builder.overrideProvider(MEMBER_REPOSITORY).useValue(options.members);
  }
  if (options.invitations !== undefined) {
    builder
      .overrideProvider(INVITATION_REPOSITORY)
      .useValue(options.invitations);
  }
  if (options.invitationTokens !== undefined) {
    builder
      .overrideProvider(INVITATION_TOKENS)
      .useValue(options.invitationTokens);
  }
  if (options.membershipReader !== undefined) {
    builder
      .overrideProvider(MEMBERSHIP_READER)
      .useValue(options.membershipReader);
  }
  if (options.categories !== undefined) {
    builder
      .overrideProvider(EXPENSE_CATEGORY_REPOSITORY)
      .useValue(options.categories)
      .overrideProvider(EXPENSE_REFERENCE_READER)
      .useValue(options.categories);
  }
  if (options.participants !== undefined) {
    builder
      .overrideProvider(EXPENSE_PARTICIPANT_READER)
      .useValue(options.participants)
      .overrideProvider(EXPENSE_SOCIETY_READER)
      .useValue(options.participants);
  }

  const moduleRef = await builder.compile();

  const app =
    moduleRef.createNestApplication<NestFastifyApplication>(createAdapter());

  app.setGlobalPrefix(GLOBAL_PREFIX);

  await app.init();
  // Fastify only serves once its own plugin graph has finished loading.
  await app.getHttpAdapter().getInstance().ready();

  // ## Why the harness listens on an ephemeral port before handing the app over
  //
  // supertest starts a server it finds un-listening, and **closes** it again when
  // that request finishes. That is fine for one request at a time, and wrong for
  // the concurrent ones a suite legitimately fires (`Promise.all([...])`, a burst
  // of refusals asserted together): every request in the burst sees no address,
  // each of them starts its own ephemeral listener on the shared instance, and the
  // first to finish closes it under the others — surfaces as
  // `read ECONNRESET`, intermittently, on whichever request happened to be in
  // flight. Observed exactly once in six full runs before this line existed.
  //
  // Listening here (port 0 = the OS picks a free one, so parallel suites never
  // collide) makes the address non-null before any request, so supertest reuses
  // the open server for every call and closes nothing. `app.close()` in the
  // suite's `afterAll` is what tears it down.
  await app.listen(0, "127.0.0.1");

  return app;
}
