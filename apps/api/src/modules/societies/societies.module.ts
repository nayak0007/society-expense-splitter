import { Module } from "@nestjs/common";
import { systemClock } from "@ses/domain";
import type { Clock } from "@ses/domain";

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
  imports: [DatabaseModule],
  controllers: [SocietiesController],
  providers: [
    SocietyOperations,
    SocietyRepositoryPostgres,
    { provide: SOCIETY_REPOSITORY, useExisting: SocietyRepositoryPostgres },
    { provide: SOCIETY_CLOCK, useValue: systemClock satisfies Clock },
  ],
  exports: [SocietyOperations],
})
export class SocietiesModule {}
