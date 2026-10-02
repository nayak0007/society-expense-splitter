import { Module } from "@nestjs/common";
import { systemClock } from "@ses/domain";
import type { Clock } from "@ses/domain";

import { CachedSocietyAuthorizationReader } from "../../common/authorization/cached-society-authorization.reader";
import {
  MEMBERSHIP_CACHE,
  type MembershipCache,
} from "../../common/authorization/membership-cache";
import { MEMBERSHIP_READER } from "../../common/authorization/membership-reader";
import {
  SOCIETY_AUTHORIZATION_READER,
  type SocietyAuthorizationReader,
} from "../../common/authorization/society-authorization";
import { CacheModule } from "../../infrastructure/cache/cache.module";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { SocietyOperations } from "./application/society.operations";
import {
  SOCIETY_CLOCK,
  SOCIETY_REPOSITORY,
} from "./application/society.tokens";
import { SocietyRepositoryPostgres } from "./infrastructure/society.repository";
import { SocietiesController } from "./presentation/societies.controller";

/**
 * The society feature module — Roadmap T040.
 *
 * ## The dependency direction is the module's whole content
 *
 * ```
 * controller ──▶ SocietyOperations ──▶ SocietyRepository (interface, @ses/domain)
 *                        │                        ▲
 *                        └── Clock               │
 *                                          SocietyRepositoryPostgres
 * ```
 *
 * The arrows point one way, and this file is where that is enforced rather than
 * described: the interface token is what the application layer binds to, so the
 * adapter can be swapped (the e2e suite swaps it for an in-memory fake) without
 * any file above `infrastructure/` knowing. Importing `SocietyRepositoryPostgres`
 * from the application layer would compile perfectly and would quietly make the
 * domain depend on Drizzle — SAD §3.1's one rule, broken invisibly. The token
 * indirection is the price of that being impossible.
 *
 * `DatabaseModule` is imported explicitly rather than reached for globally,
 * following the same reasoning it records for itself: the reader of this file
 * should be able to see that this module writes to Postgres.
 *
 * `SOCIETY_CLOCK` binds the real `systemClock`. It is a provider rather than a
 * direct import so that a test can freeze time — join-code expiry is the one rule
 * in this module whose outcome depends on "now", and it is otherwise untestable.
 */
@Module({
  imports: [DatabaseModule, CacheModule],
  controllers: [SocietiesController],
  providers: [
    SocietyOperations,
    SocietyRepositoryPostgres,
    { provide: SOCIETY_REPOSITORY, useExisting: SocietyRepositoryPostgres },
    // The guard chain's read (T038). Bound to the same instance as the domain
    // port rather than to a second class: the guard needs one query, and that
    // query is the `society_snapshot()` read this adapter already owns. Two
    // providers over one instance also means `useExisting` — not `useClass` — so
    // a test that swaps `SocietyRepositoryPostgres` for a fake gets a coherent
    // guard context from the same fake instead of a half-real chain.
    {
      provide: SOCIETY_AUTHORIZATION_READER,
      inject: [
        SocietyRepositoryPostgres,
        { token: MEMBERSHIP_CACHE, optional: true },
      ],
      // The adapter itself when there is no cache, and the adapter *wrapped* when
      // there is: the guard asks the same question either way, and the read that
      // answers it is still this module's one `society_snapshot()` call. A factory
      // rather than `useExisting` because the binding is now conditional, which
      // `useExisting` cannot express.
      useFactory: (
        inner: SocietyRepositoryPostgres,
        cache: MembershipCache | undefined,
      ): SocietyAuthorizationReader =>
        cache === undefined
          ? inner
          : new CachedSocietyAuthorizationReader(inner, cache),
    },
    // T042's one read of a `members` row, satisfied by the same instance. The
    // building module consumes it through this module's exported surface rather
    // than implementing a third translation of a `members` row — see the token's
    // own note for why the token lives in `common/` and this does not.
    { provide: MEMBERSHIP_READER, useExisting: SocietyRepositoryPostgres },
    { provide: SOCIETY_CLOCK, useValue: systemClock satisfies Clock },
  ],
  // Both readers are exported for the same reason, from two directions:
  // `SOCIETY_AUTHORIZATION_READER` because `SocietyGuard` is registered in
  // `AppModule` and resolves its dependencies there — a global guard's own
  // dependencies must be visible in the module that registers it — and
  // `MEMBERSHIP_READER` because the building module (T042) consumes it. Both
  // interfaces live in `common/authorization/` (or in `@ses/domain`) and both
  // implementations live here, so the dependency still points inward; these two
  // lines are what make the container agree with that.
  //
  // `SOCIETY_REPOSITORY` is exported for the expenses module (T063), which needs one
  // field of a society's settings — `bill_vacant_flats` — to resolve participants. It
  // is the same borrow as `MEMBERSHIP_READER`, and it is deliberately the *port*
  // rather than a new narrow adapter: `ExpenseSocietyReader` in `@ses/domain` is a
  // structural subset of this interface (`findById`), so the expenses module binds its
  // token to this provider and no second reader of `society_settings` can exist.
  exports: [
    SocietyOperations,
    SOCIETY_AUTHORIZATION_READER,
    MEMBERSHIP_READER,
    SOCIETY_REPOSITORY,
  ],
})
export class SocietiesModule {}
