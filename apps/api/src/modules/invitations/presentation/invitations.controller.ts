import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import {
  acceptInvitationResponseSchema,
  createInvitationSchema,
  createInvitationResponseSchema,
  invitationListQuerySchema,
  invitationListResponseSchema,
  invitationPreviewResponseSchema,
  invitationSummarySchema,
  invitationTokenSchema,
  revokeInvitationResponseSchema,
} from "@ses/contracts";
import { asApartmentId, asInvitationId, asUserId } from "@ses/domain";
import { z } from "zod";

import { ApiSocietyContext } from "../../../common/authorization/api-society-context.decorator";
import {
  Ctx,
  requireActor,
  requireSociety,
  type RequestCtx,
} from "../../../common/decorators/ctx.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { ZodPipe } from "../../../common/pipes/zod.pipe";
import { envelopeSchemaOf } from "../../../common/swagger/zod-openapi";
import { InvitationsOperations } from "../application/invitations.operations";
import {
  createdInvitationToDto,
  invitationAcceptanceToDto,
  invitationListToDto,
  invitationPreviewToDto,
  invitationToDto,
} from "./invitation.mapper";
import { ApiInvitationErrors } from "./openapi";

/**
 * Invitation endpoints — Roadmap T047 (PRD §3.3, §7.2).
 *
 * ## Three route shapes, and each one is a deliberate answer to "who is calling?"
 *
 *  1. **Management** (`POST /invitations`, `GET /invitations`, `GET /invitations/:id`,
 *     `POST /invitations/:id/revoke`) — addressed by `X-Society-Id` and gated by
 *     `@RequirePermission("member.invite")`. That declaration is what makes the whole guard chain
 *     run (`SupabaseAuthGuard → SocietyGuard → PermissionGuard`), the same way the member and
 *     structure routes do. No role string is compared anywhere in this file: the matrix cell is the
 *     authority, and the use case narrows it against the caller's own membership.
 *  2. **Preview** (`GET /invitations/preview/:token`) — `@Public()`, because the recipient may not
 *     have an account yet and the link is the only thing they hold. It is not a bypass: the *token*
 *     is the credential, the projection is masked by the database, and the transaction runs as
 *     `anonymous` (the `authenticated` role with no `auth.uid()`), so every policy still fails
 *     closed. This is the deliberate different-route-shape the brief asks for, rather than a way
 *     around the guards.
 *  3. **Acceptance** (`POST /invitations/accept/:token`) — a verified JWT is required (the global
 *     guard runs on any route that is not `@Public()`), and there is **no** `@RequirePermission`,
 *     because a permission is a grant on a membership the caller does not have yet: that is the
 *     point of accepting one. The actor comes from the token, never from the body, and the database
 *     compares it against `auth.uid()` itself.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input through the contract's schemas, calls one use case, and maps the result
 * to a DTO. Every rule — who may invite, at which role, whether a link may be shared unaddressed,
 * whether an invitation is still live — lives in `@ses/application`/`@ses/domain`, and the database
 * enforces its half underneath. A check written here would be a third implementation of a rule that
 * already exists in two places that cannot drift, in the one place with no test of its own.
 *
 * ## The token appears in exactly one response
 *
 * `POST /invitations` returns it once, to the manager who created the invitation — that *is* the
 * delivery model (PRD §3.3: the manager sends the link), and sending it server-side is the
 * notifications phase, deferred rather than half-built. Every other route is token-free: the list, the
 * detail, the preview and the acceptance response have no field a credential could arrive in.
 */

/** Path parameters are UUIDs, checked before any query runs — a non-UUID would be a 500 otherwise. */
const invitationIdParam = z.uuid();

@ApiTags("invitations")
@ApiInvitationErrors()
@ApiSocietyContext()
@Controller("invitations")
export class InvitationsController {
  constructor(private readonly operations: InvitationsOperations) {}

  /**
   * Create an invitation.
   *
   * Admin or Treasurer (`member.invite`); the *role* it carries is a separate question, answered
   * against `member.role_change` — so a Treasurer may invite a neighbour at the default role and may
   * not appoint an officer. A duplicate live invitation for the same address or number is refused by
   * the database (a partial unique index), and somebody who already has an account here is refused by
   * the recipient trigger: both are 409s with the offending `field`.
   */
  @Post()
  @RequirePermission("member.invite")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Invite somebody to the society",
    description:
      "Admin or Treasurer. Creates a single-use, fourteen-day invitation for an email address or a phone number, optionally tied to a flat and at a role the caller may hand out. The response carries the token **once** — the manager sends the link (the app does not deliver it yet).",
  })
  @ApiCreatedResponse({
    description:
      "The invitation, and the one copy of its token. Treat the token as a password: it is not stored in readable form and cannot be read back.",
    schema: envelopeSchemaOf(createInvitationResponseSchema),
  })
  async create(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(createInvitationSchema))
    body: z.infer<typeof createInvitationSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const created = await this.operations.create(asUserId(userId), society.id, {
      channel: body.channel,
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.email === undefined ? {} : { email: body.email }),
      ...(body.phone === undefined ? {} : { phone: body.phone }),
      ...(body.apartmentId === undefined
        ? {}
        : { apartmentId: asApartmentId(body.apartmentId) }),
    });
    return createdInvitationToDto(created);
  }

  /**
   * The society's invitations, newest first.
   *
   * Gated by `member.invite` — the addresses and numbers on this screen are the same class of data the
   * member directory protects. `status=` filters; an invitation past its fourteenth day is still
   * listed and comes back with `expired: true`, because a read path that rewrote rows would make a
   * list request a write.
   */
  @Get()
  @RequirePermission("member.invite")
  @ApiOperation({
    summary: "List the society's invitations",
    description:
      "Admin or Treasurer. Newest first, optionally filtered by `status`. Each row carries `expired` (its status folded with the server's clock) and a masked `inviteeHint`, so the manager sees what the recipient will see.",
  })
  @ApiOkResponse({
    description: "One page of invitations, plus the total the filter produced.",
    schema: envelopeSchemaOf(invitationListResponseSchema),
  })
  async list(
    @Ctx() context: RequestCtx,
    @Query(new ZodPipe(invitationListQuerySchema))
    query: z.infer<typeof invitationListQuerySchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const page = await this.operations.list(asUserId(userId), society.id, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    return invitationListToDto(page);
  }

  /**
   * The public preview for a link.
   *
   * Declared **before** `:invitationId` so the literal segment is registered first — the other route
   * validates its parameter as a UUID, and `preview/:token` would otherwise have to be answered by a
   * route that cannot read it.
   *
   * Masked by the database, and the first call moves the funnel's second step (`sent → opened`)
   * exactly once. No identity, no society header, no capability.
   */
  @Get("preview/:token")
  @Public()
  @ApiOperation({
    summary: "Preview an invitation link",
    description:
      "Public, because the recipient may not have an account yet. Returns the society's name, the role, the flat and a **masked** recipient (`in***@example.com`) — enough to recognise your own invitation, not enough to harvest an address from a forwarded link. An unknown or malformed token answers 404 identically.",
  })
  @ApiParam({
    name: "token",
    description: "The token exactly as it appears in the invitation link.",
  })
  @ApiOkResponse({
    description: "The masked preview, with `expired` folded into `status`.",
    schema: envelopeSchemaOf(invitationPreviewResponseSchema),
  })
  async preview(
    @Param("token", new ZodPipe(invitationTokenSchema)) token: string,
  ) {
    const preview = await this.operations.preview(token);
    return invitationPreviewToDto(preview);
  }

  /**
   * Accept an invitation.
   *
   * A verified account is required and a **membership** is not — that asymmetry is the feature. The
   * actor's id travels from the verified token to the database function, which compares it against
   * `auth.uid()` before it writes: acceptance is never performed on somebody else's behalf. The
   * function holds a row lock while it decides, so two simultaneous accepts cannot both win and cannot
   * create two memberships, and a live shadow member matched on the invitation's number is **linked**
   * rather than duplicated (PRD §3.3).
   */
  @Post("accept/:token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Accept an invitation",
    description:
      "Sign in as the invited account and accept. Atomic and single-use: the invitation is locked, re-checked (live, unexpired, the right account), and the membership is created, linked or activated exactly once — at the invited role, on the invited flat. `linkedShadow` in the response says whether an occupant the Admin had already recorded was linked.",
  })
  @ApiParam({
    name: "token",
    description: "The token exactly as it appears in the invitation link.",
  })
  @ApiOkResponse({
    description: "The membership that now exists.",
    schema: envelopeSchemaOf(acceptInvitationResponseSchema),
  })
  async accept(
    @Ctx() context: RequestCtx,
    @Param("token", new ZodPipe(invitationTokenSchema)) token: string,
  ) {
    const { userId } = requireActor(context);
    const accepted = await this.operations.accept(asUserId(userId), token);
    return invitationAcceptanceToDto(accepted);
  }

  /** One invitation — the details screen, and the row a revoke confirmation is about. */
  @Get(":invitationId")
  @RequirePermission("member.invite")
  @ApiOperation({
    summary: "View an invitation",
    description:
      "Admin or Treasurer. The stored status (not the derived one), so the screen can show the funnel — sent, opened, accepted, revoked — with the deadline beside it.",
  })
  @ApiParam({ name: "invitationId", description: "Invitation UUID." })
  @ApiOkResponse({
    description: "The invitation.",
    schema: envelopeSchemaOf(invitationSummarySchema),
  })
  async detail(
    @Ctx() context: RequestCtx,
    @Param("invitationId", new ZodPipe(invitationIdParam)) invitationId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const invitation = await this.operations.get(
      asUserId(userId),
      society.id,
      asInvitationId(invitationId),
    );
    return invitationToDto(invitation);
  }

  /**
   * Revoke an invitation.
   *
   * A `POST` on a sub-resource rather than a `DELETE`, and the distinction is the product's: the row
   * keeps its history and its stamps (`revoked_at`, `revoked_by`), and revocation is a *state* the
   * link lands in — a 404 for the recipient afterwards would tell them the link never existed. An
   * invitation that has already been accepted cannot be revoked (409), because the membership it
   * created is a separate thing with its own removal path.
   */
  @Post(":invitationId/revoke")
  @RequirePermission("member.invite")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Revoke an invitation",
    description:
      "Admin or Treasurer. The link stops working: the recipient sees that it was revoked, and acceptance is refused. An invitation that was already accepted is refused with 409 — remove the member instead.",
  })
  @ApiParam({ name: "invitationId", description: "Invitation UUID." })
  @ApiOkResponse({
    description: "The invitation, now terminal.",
    schema: envelopeSchemaOf(revokeInvitationResponseSchema),
  })
  async revoke(
    @Ctx() context: RequestCtx,
    @Param("invitationId", new ZodPipe(invitationIdParam)) invitationId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const revoked = await this.operations.revoke(
      asUserId(userId),
      society.id,
      asInvitationId(invitationId),
    );
    return invitationToDto(revoked);
  }
}
