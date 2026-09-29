import { Module } from "@nestjs/common";

import { CacheModule } from "../../infrastructure/cache/cache.module";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { StructureModule } from "../structure/structure.module";
import { IMPORT_FLAT_READER } from "./application/csv-import.tokens";
import { MembersOperations } from "./application/members.operations";
import { MEMBER_REPOSITORY } from "./application/member.tokens";
import { ImportFlatReaderService } from "./infrastructure/import-flat-reader.service";
import { MemberRepositoryPostgres } from "./infrastructure/member.repository";
import { MembersController } from "./presentation/members.controller";
import { PermissionsController } from "./presentation/permissions.controller";

/**
 * The members feature module — Roadmap T045.
 *
 * ## The dependency direction is the module's whole content
 *
 * ```
 * controller ──▶ MembersOperations ──▶ MemberRepository  (interface, @ses/domain)
 *                                             ▲
 *                                    MemberRepositoryPostgres
 * ```
 *
 * The arrows point one way, and this file is where that is enforced rather than described: the
 * interface token is what the application layer binds to, so the adapter can be swapped (the e2e
 * suite swaps it for an in-memory fake) without any file above `infrastructure/` knowing.
 * Importing `MemberRepositoryPostgres` from the application layer would compile perfectly and
 * would quietly make the domain depend on Drizzle — SAD §3.1's one rule, broken invisibly. The
 * token indirection is the price of that being impossible.
 *
 * ## Why there is no `SocietiesModule` import
 *
 * The structure module needs it for one provider: the caller's role in the society
 * (`MEMBERSHIP_READER`). This module does not, and the reason is not an omission — the member
 * module's own repository answers that question (`findViewer`), because the answer it needs is
 * *richer* than the shared reader can give: that port collapses `inactive` and `rejected` onto
 * `removed`, which would make a suspended member indistinguishable from one who left. So the
 * dependency is on the table this module owns rather than on another module's translation of it,
 * and the cross-module wiring the structure module needed does not appear here at all.
 *
 * ## Why `DatabaseModule` is imported explicitly
 *
 * Rather than reached for globally, following the reasoning that module records for itself: the
 * reader of this file should be able to see that this module writes to Postgres.
 */
@Module({
  // StructureModule (T048): the import's flat reference answers through the structure
  // module's own adapters. InvitationsModule is deliberately NOT imported — it imports
  // this module (for MEMBER_REPOSITORY), and a second edge would be a module cycle that
  // dependency-cruiser correctly refuses; the invitation list is bound at the composition
  // root (app.module.ts) instead, which is where cross-cutting wiring belongs.
  // `CacheModule` is imported because every write in this module can revoke
  // authority — see `MemberRepositoryPostgres`'s constructor. It is imported
  // explicitly rather than reached for globally, following `DatabaseModule`'s own
  // note: the reader of this file should be able to see that this module's writes
  // are ordered against a cache.
  imports: [DatabaseModule, StructureModule, CacheModule],
  // Two controllers, one use-case class: the role catalogue and the permission reads answer the
  // same questions as the member routes and read the same port (`findViewer`, `findById`,
  // `countActiveByRole`), so splitting the *operations* would split one implementation of a rule
  // across two files. The resource boundary — `/members` vs `/permissions` — is the only thing the
  // second controller draws, which is what keeps `/members/:memberId`'s namespace unambiguous.
  controllers: [MembersController, PermissionsController],
  providers: [
    MembersOperations,
    MemberRepositoryPostgres,
    { provide: MEMBER_REPOSITORY, useExisting: MemberRepositoryPostgres },
    // T048 — the bulk import's flat reference. Bound to the narrow shape the import's
    // use case declares (`ImportApartmentReader`), so the member module cannot grow an
    // opinion about flats — it can only ask its one question. The invitation list is
    // bound at the composition root (see app.module.ts).
    ImportFlatReaderService,
    { provide: IMPORT_FLAT_READER, useExisting: ImportFlatReaderService },
  ],
  //
  // Exported for the invitations module (T047), which needs one question answered — "what is
  // this caller's membership, and what does its role hold?" — and needs the *same* answer the
  // member routes get. `useExisting` above means the exported token is that same instance, so a
  // second copy of the membership read cannot exist. Everything else stays private: the member
  // use cases are reached through their own controllers, not through other modules.
  exports: [MEMBER_REPOSITORY],
})
export class MembersModule {}
