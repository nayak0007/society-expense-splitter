import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../infrastructure/database/database.module";
import { MembersModule } from "../members/members.module";
import { InvitationsOperations } from "./application/invitations.operations";
import {
  INVITATION_REPOSITORY,
  INVITATION_TOKENS,
} from "./application/invitation.tokens";
import { InvitationRepositoryPostgres } from "./infrastructure/invitation.repository";
import { InvitationTokensService } from "./infrastructure/invitation-tokens.service";
import { InvitationsController } from "./presentation/invitations.controller";

/**
 * The invitations feature module — Roadmap T047.
 *
 * ## The dependency direction, and the one borrow
 *
 * ```text
 * controller ─▶ InvitationsOperations ─▶ InvitationRepository  (interface, @ses/domain)
 *                    │                        ▲
 *                    │               InvitationRepositoryPostgres
 *                    ├──▶ InvitationTokenPort ─▶ InvitationTokensService (node:crypto)
 *                    └──▶ MemberRepository     ─▶ MemberRepositoryPostgres
 * ```
 *
 * The interface tokens are what the application layer binds to, so the e2e suite can substitute
 * in-memory fakes for both repositories without any file above `infrastructure/` knowing — which is
 * how these routes are tested without a database.
 *
 * ## Why `MembersModule` is imported, and why that is not a layering violation
 *
 * Answering "may this caller invite?" needs the caller's own membership and the capabilities its role
 * holds, and the **members** module owns that table. Importing the module and injecting its exported
 * repository token reuses one implementation of one question; declaring a second port over
 * `public.members` here would be the duplicate membership concept T047 was told not to create, and
 * two readers of one table drift. `MembersModule` exports `MEMBER_REPOSITORY` for exactly this kind of
 * consumer, and this module is the first that is not the members module itself.
 */
@Module({
  imports: [DatabaseModule, MembersModule],
  controllers: [InvitationsController],
  providers: [
    InvitationsOperations,
    InvitationRepositoryPostgres,
    InvitationTokensService,
    {
      provide: INVITATION_REPOSITORY,
      useExisting: InvitationRepositoryPostgres,
    },
    { provide: INVITATION_TOKENS, useExisting: InvitationTokensService },
  ],
  // INVITATION_REPOSITORY exported for the member module's CSV import (T048), whose
  // collision check asks one question of this table — "which invitations are still
  // open?" — and gets the same answer the invitation routes get, from the same adapter.
  exports: [InvitationsOperations, INVITATION_REPOSITORY],
})
export class InvitationsModule {}
