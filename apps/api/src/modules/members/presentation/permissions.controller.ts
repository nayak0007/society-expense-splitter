import { Controller, Get, Param } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import {
  memberPermissionsResponseSchema,
  permissionCatalogueResponseSchema,
} from "@ses/contracts";
import { asMemberId, asUserId } from "@ses/domain";
import { z } from "zod";

import { ApiSocietyContext } from "../../../common/authorization/api-society-context.decorator";
import {
  Ctx,
  requireActor,
  requireSociety,
  type RequestCtx,
} from "../../../common/decorators/ctx.decorator";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { ZodPipe } from "../../../common/pipes/zod.pipe";
import { envelopeSchemaOf } from "../../../common/swagger/zod-openapi";
import { MembersOperations } from "../application/members.operations";
import { memberPermissionsToDto, roleCatalogueToDto } from "./member.mapper";
import { ApiMemberErrors } from "./openapi";

/**
 * Permission introspection — Roadmap T046, SAD §9.3.
 *
 * ## Why these three routes are not under `/members`
 *
 * A permission is not a member's sub-resource: it is a property of a *role*, and the catalogue
 * exists before any particular member is chosen. Mounting it at `/members/permissions` would also
 * collide with `/members/:memberId`'s own namespace, and the client would have to know that
 * `permissions` is not a member id. The resource is `permissions`; the *subject* is in the path
 * (`/me`, `/members/:memberId`).
 *
 * ## What is deliberately absent
 *
 * There is **no write route here**. Grants are a fixed role→action matrix and the only write in
 * this area is a role assignment, which lives on the member it changes
 * (`PATCH /members/:memberId/role`). A `PUT /permissions` would be a way to ask for a grant, and
 * there is no representation of a grant that a client is allowed to send — not an omission, the
 * security property (see `@ses/contracts/permissions.ts`).
 *
 * ## The declared permission is the coarse half, as everywhere in this module
 *
 * All three declare `member.view`, the directory read: the catalogue is public policy within the
 * society, and one member's effective permissions are the same fact about them as their role —
 * which the roster already shows. The narrow half is in the use case, which is where it can be
 * precise: `/permissions/me` applies **no** capability gate (a suspended member is entitled to an
 * answer about themselves, and the guard chain's own refusal is what says whether they may ask at
 * all), while `/permissions/members/:memberId` requires the caller to be that member *or* an
 * Admin (`canChangeRoles`) — seeing what everybody can do is the other half of role management,
 * and a Treasurer who may edit the directory cannot use it.
 *
 * Ordered `me` before `members/:memberId` so the literal path is registered first — the lesson
 * `/members/me` records, applied before it could matter here.
 */

/**
 * Path parameters are UUIDs, checked before any query runs — the same rule, and the same
 * reasoning, as the members controller: a non-UUID reaches Postgres as `$1::uuid` and fails there
 * with a `22P02` the classifier can only report as `unknown` (a 500 for a client bug).
 */
const memberIdParam = z.uuid();

@ApiTags("permissions")
@ApiMemberErrors()
@ApiSocietyContext()
@Controller("permissions")
export class PermissionsController {
  constructor(private readonly operations: MembersOperations) {}

  /**
   * The role catalogue: every role with everything it may ever do, in PRD §2.1's order.
   *
   * It exists on the server even though `actionsFor` is a pure function the mobile bundle already
   * has, because it is the **server's** declaration of what it will accept: a client rendering a
   * role picker from a stale bundle would otherwise offer a role the deployed API refuses. The
   * caller's capabilities travel with it, which is what decides whether the picker is usable.
   */
  @Get()
  @RequirePermission("member.view")
  @ApiOperation({
    summary: "List roles and their permissions",
    description:
      "Every role a membership can hold (admin, treasurer, committee_member, resident, tenant, guest) with the full action list it holds, in PRD §2.1's order, plus the caller's capabilities. Derived from the same matrix the guard and the RLS policies use — there is no stored grant to differ from it.",
  })
  @ApiOkResponse({
    description: "The role catalogue and the caller's capabilities.",
    schema: envelopeSchemaOf(permissionCatalogueResponseSchema),
  })
  async catalogue(@Ctx() context: RequestCtx) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const catalogue = await this.operations.roles(asUserId(userId), society.id);
    return roleCatalogueToDto(catalogue);
  }

  /**
   * The caller's own effective permissions.
   *
   * The one read whose subject is the token rather than a path parameter, and the reason the screen
   * can explain a missing button: a member whose role holds nothing gets an empty list rather than
   * a refusal, so "you may not do that" and "your membership is suspended" are different screens.
   */
  @Get("me")
  @RequirePermission("member.view")
  @ApiOperation({
    summary: "View your own permissions",
    description:
      "The caller's own membership role and the actions it currently holds, with their capabilities. A membership that is not active has an empty action list (`permissions: []`) — the role's grant is not what applies to a suspended or pending member — and a caller with no live membership at all is answered 404, the same as one outside the society.",
  })
  @ApiOkResponse({
    description: "The caller's role, permissions and capabilities.",
    schema: envelopeSchemaOf(memberPermissionsResponseSchema),
  })
  async mine(@Ctx() context: RequestCtx) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const view = await this.operations.myPermissions(
      asUserId(userId),
      society.id,
    );
    return memberPermissionsToDto(view);
  }

  /**
   * One member's effective permissions — the member themselves, or an Admin.
   *
   * The path names the **membership**, like every other member route, because roles belong to
   * memberships (PRD §2) and a user id would be a way to ask about an account the caller's society
   * may not have.
   */
  @Get("members/:memberId")
  @RequirePermission("member.view")
  @ApiOperation({
    summary: "View a member's permissions",
    description:
      "The member's role and the actions it holds. Readable by that member themselves (`member.view` is not required for your own row) or by an Admin; a Treasurer who may edit the directory is refused, because enumerating the society's Admins is a different kind of information. Another society's member, or a removed one, is 404 — never 403.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description:
      "The member's role, permissions and the caller's capabilities.",
    schema: envelopeSchemaOf(memberPermissionsResponseSchema),
  })
  async member(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const view = await this.operations.memberPermissions(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
    );
    return memberPermissionsToDto(view);
  }
}
