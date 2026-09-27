import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module";
import { SocietiesModule } from "../societies/societies.module";
import { StructureOperations } from "./application/structure.operations";
import {
  APARTMENT_REPOSITORY,
  BUILDING_REPOSITORY,
} from "./application/structure.tokens";
import { ApartmentRepositoryPostgres } from "./infrastructure/apartment.repository";
import { BuildingRepositoryPostgres } from "./infrastructure/building.repository";
import {
  ApartmentsController,
  BuildingApartmentsController,
} from "./presentation/apartments.controller";
import { BuildingsController } from "./presentation/buildings.controller";

/**
 * The structure feature module — Roadmap T042 (buildings) and T043 (flats).
 *
 * ## The dependency direction is the module's whole content
 *
 * ```
 * controller ──▶ StructureOperations ──▶ BuildingRepository  (interface, @ses/domain)
 *                          │              ApartmentRepository  (interface, @ses/domain)
 *                          │                         ▲
 *                          │                 BuildingRepositoryPostgres
 *                          │                 ApartmentRepositoryPostgres
 *                          │
 *                          └──▶ MEMBERSHIP_READER ──▶ SocietyRepositoryPostgres
 *                                   (common/)              (SocietiesModule)
 * ```
 *
 * The arrows point one way, and this file is where that is enforced rather than
 * described: the interface token is what the application layer binds to, so the
 * adapter can be swapped (the e2e suite swaps it for an in-memory fake) without
 * any file above `infrastructure/` knowing. Importing `BuildingRepositoryPostgres`
 * from the application layer would compile perfectly and would quietly make the
 * domain depend on Drizzle — SAD §3.1's one rule, broken invisibly. The token
 * indirection is the price of that being impossible.
 *
 * ## Why `SocietiesModule` is imported
 *
 * For exactly one provider: `MEMBERSHIP_READER`, the caller's role in the society
 * — which the capability evaluation needs and which is *not* a structure concern.
 * The implementation stays in the society module because that is where a `members`
 * row becomes a `SocietyMembership`; a second translation here would be a third
 * copy of the role/status/occupancy navigation tables, and a drifted copy of that
 * map is silent (a role read as `admin` in one and `guest` in the other).
 *
 * This is the sanctioned direction for a cross-module dependency (SAD §1.2): the
 * token is shared vocabulary in `common/authorization/`, and `SocietiesModule`
 * exports its provider. Nothing reaches into the society module's internals.
 *
 * ## Why `DatabaseModule` is imported explicitly
 *
 * Rather than reached for globally, following the reasoning that module records
 * for itself: the reader of this file should be able to see that this module
 * writes to Postgres.
 */
@Module({
  imports: [DatabaseModule, SocietiesModule],
  controllers: [
    BuildingsController,
    BuildingApartmentsController,
    ApartmentsController,
  ],
  providers: [
    StructureOperations,
    BuildingRepositoryPostgres,
    { provide: BUILDING_REPOSITORY, useExisting: BuildingRepositoryPostgres },
    ApartmentRepositoryPostgres,
    { provide: APARTMENT_REPOSITORY, useExisting: ApartmentRepositoryPostgres },
  ],
  // Both repository tokens exported for the member module's CSV import (T048), whose
  // flat reference resolves `flat_no` labels through this module's own adapters rather
  // than growing SQL about the structure tables. `useExisting` means the exported token
  // is the same instance, so a second copy of the reads cannot exist.
  exports: [BUILDING_REPOSITORY, APARTMENT_REPOSITORY],
})
export class StructureModule {}
