import { Inject, Injectable } from "@nestjs/common";
import {
  acceptInvitation,
  createInvitation,
  getInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
  type CreatedInvitation,
  type InvitationDeps,
} from "@ses/application";
import type {
  ApartmentId,
  Invitation,
  InvitationChannel,
  InvitationError,
  InvitationId,
  InvitationPage,
  InvitationPreview,
  InvitationAcceptance,
  InvitationRepository,
  InvitationStatus,
  InvitationTokenPort,
  MemberRepository,
  MemberRole,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";
import { systemClock } from "@ses/domain";

import { MEMBER_REPOSITORY } from "../../members/application/member.tokens";
import { toAppError } from "./invitation-error.mapper";
import { INVITATION_REPOSITORY, INVITATION_TOKENS } from "./invitation.tokens";

/**
 * The API's view of the invitation use cases.
 *
 * **No business rules here**, for the reason `MembersOperations` records in full: every rule is in
 * `@ses/application` (which the mobile client calls too), and this class does only the two things
 * that are HTTP's own — it supplies dependencies from the container, and it unwraps `Result` into a
 * value or a thrown `AppError`.
 *
 * ## Four dependencies, two of them borrowed
 *
 * `members` is the **members** module's repository token, injected here rather than re-declared: who
 * may invite is `member.invite`, and the only implementation of "what is this caller's membership and
 * what does it hold" is `MemberRepository.findViewer`. A second port for the same table is exactly the
 * duplicate membership concept the brief forbids, and the e2e suite's member fake is reused for the
 * same reason.
 *
 * `clock` is the domain's `systemClock`, not a provider: a clock that a container could swap is a
 * clock two deployments can disagree about, and the only thing this module does with it is add
 * fourteen days. The token port *is* a provider, because hashing needs `node:crypto` and the e2e
 * suite wants it real.
 */
@Injectable()
export class InvitationsOperations {
  constructor(
    @Inject(INVITATION_REPOSITORY)
    private readonly invitations: InvitationRepository,
    @Inject(INVITATION_TOKENS) private readonly tokens: InvitationTokenPort,
    @Inject(MEMBER_REPOSITORY) private readonly members: MemberRepository,
  ) {}

  private get deps(): InvitationDeps {
    return {
      invitations: this.invitations,
      tokens: this.tokens,
      members: this.members,
      clock: systemClock,
    };
  }

  async create(
    actor: UserId,
    societyId: SocietyId,
    command: {
      readonly channel: InvitationChannel;
      readonly role?: MemberRole | undefined;
      readonly email?: string | undefined;
      readonly phone?: string | undefined;
      readonly apartmentId?: ApartmentId | undefined;
    },
  ): Promise<CreatedInvitation> {
    return unwrap(createInvitation(this.deps, actor, societyId, command));
  }

  async list(
    actor: UserId,
    societyId: SocietyId,
    query: {
      readonly status?: InvitationStatus | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ): Promise<InvitationPage> {
    return unwrap(listInvitations(this.deps, actor, societyId, query));
  }

  async get(
    actor: UserId,
    societyId: SocietyId,
    invitationId: InvitationId,
  ): Promise<Invitation> {
    return unwrap(getInvitation(this.deps, actor, societyId, invitationId));
  }

  async revoke(
    actor: UserId,
    societyId: SocietyId,
    invitationId: InvitationId,
  ): Promise<Invitation> {
    return unwrap(revokeInvitation(this.deps, actor, societyId, invitationId));
  }

  /** Public: no actor, no society. The token is the authority. */
  async preview(token: string): Promise<InvitationPreview> {
    return unwrap(previewInvitation(this.deps, token));
  }

  /** Acceptance needs an actor but no membership — see the use case for why. */
  async accept(actor: UserId, token: string): Promise<InvitationAcceptance> {
    return unwrap(acceptInvitation(this.deps, actor, token));
  }
}

/** Awaits a use case and converts failure into the API's exception. */
async function unwrap<TValue>(
  pending: Promise<Result<TValue, InvitationError>>,
): Promise<TValue> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}

export type { Invitation, InvitationPreview, CreatedInvitation };
