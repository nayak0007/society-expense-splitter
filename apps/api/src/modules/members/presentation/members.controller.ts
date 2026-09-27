import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  approveJoinRequestSchema,
  assignRoleResponseSchema,
  assignRoleSchema,
  createMemberSchema,
  csvImportPreviewResponseSchema,
  csvImportRequestSchema,
  csvImportResultResponseSchema,
  joinRequestListQuerySchema,
  joinRequestListResponseSchema,
  joinRequestResponseSchema,
  memberDetailResponseSchema,
  memberListQuerySchema,
  memberListResponseSchema,
  memberResponseSchema,
  rejectJoinRequestSchema,
  updateMemberSchema,
} from "@ses/contracts";
import { asApartmentId, asBuildingId, asMemberId, asUserId } from "@ses/domain";
import type { MemberQuery } from "@ses/domain";
import { z } from "zod";

import { ApiSocietyContext } from "../../../common/authorization/api-society-context.decorator";
import {
  Ctx,
  requireActor,
  requireSociety,
  type RequestCtx,
} from "../../../common/decorators/ctx.decorator";
import { NoEnvelope } from "../../../common/decorators/no-envelope.decorator";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { ZodPipe } from "../../../common/pipes/zod.pipe";
import { envelopeSchemaOf } from "../../../common/swagger/zod-openapi";
import { MembersOperations } from "../application/members.operations";
import {
  csvImportPreviewToDto,
  csvImportResultToDto,
  joinDecisionToDto,
  joinQueueToDto,
  memberDetailToDto,
  memberListToDto,
  memberPermissionsToDto,
  memberResponseToDto,
} from "./member.mapper";
import { ApiMemberErrors } from "./openapi";

/**
 * Member endpoints — Roadmap T045.
 *
 * ## Header-scoped, like the structure routes
 *
 * These routes are addressed by `X-Society-Id` rather than by a `:societyId` path segment, and
 * that is what puts them behind the whole guard chain. `SocietyGuard` and `PermissionGuard` are
 * inert unless a route declares `@RequirePermission(…)` (see `society.guard.ts` for why an
 * unconditional society guard would break the public join-code lookup), and a permission is a
 * *per-membership* grant — so a route that names one is by definition society-scoped, and the
 * header is how it says which society. The PRD's own API table writes these paths as
 * `/societies/:id/members`, which is a different convention for the same resource; this module
 * follows the codebase's implemented convention and records the deviation in the Roadmap, since
 * a path parameter *and* a header can disagree and nothing in between would notice.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input through the contract's own schemas, calls one use case through
 * `MembersOperations`, and maps the result to a DTO. Every rule — who may see a phone number,
 * who may suspend whom, what a valid lease window is — lives in `@ses/application`/`@ses/domain`,
 * shared with the mobile client, and every read and write reaches the database under the
 * caller's own RLS identity. A permission check written here would be a third implementation of
 * a rule that already exists in two places that cannot drift (the domain's matrix and the SQL
 * policies), in the one place with no test coverage of its own.
 *
 * ## Which action each route declares, and why
 *
 * The declared permission is the *coarse, role-level* half of the check; the use case narrows it
 * against the row (status, self, the target's state). The mapping is deliberate and documented
 * in `member-rules.ts`:
 *
 *  - reads → `member.view` (everyone but a Guest)
 *  - add and edit → `member.invite` (Admin and Treasurer — the people who keep the directory)
 *  - suspend, reactivate, remove → `member.remove` (Admin only — access revocation)
 *  - assign, change and revoke a role → `member.role_change` (Admin only — the escalation PRD §13
 *    names, which is why it is the one action no other role holds)
 */

/**
 * Path parameters are UUIDs, checked before any query runs.
 *
 * Not cosmetic: a non-UUID reaches Postgres as `$1::uuid` and fails there with a `22P02` the
 * classifier can only report as `unknown`, turning a client bug into a 500. Validating here
 * answers `VALIDATION_ERROR` with the offending field, which is a client's to fix.
 *
 * Declared before the controller because a parameter decorator's expression is evaluated when
 * the class is defined.
 */
const memberIdParam = z.uuid();

@ApiTags("members")
@ApiMemberErrors()
@ApiSocietyContext()
@Controller("members")
export class MembersController {
  constructor(private readonly operations: MembersOperations) {}

  /**
   * The society's member directory, with search, filters, ordering and paging.
   *
   * An empty array is a successful answer, not a 404: a society whose creator has not yet added
   * anybody genuinely has one member and no shadow members, and the screen that fixes that is
   * the one this list is on. A Guest (no `member.view`) is refused with 403 instead, and a
   * pending member with 403 as well, because "nobody has joined yet" and "not for you" must not
   * be the same screen.
   */
  @Get()
  @RequirePermission("member.view")
  @ApiOperation({
    summary: "List and search a society's members",
    description:
      "One page of the directory of the society named in X-Society-Id, with the total the filters produced. Supports `role`, `status`, `occupancy`, `buildingId`, `apartmentId`, `q` (name, phone or flat number), `sort`, `limit` and `offset`. Removed members are excluded unless `status=removed` is asked for explicitly. Contact details appear only where the member has consented, or for the caller's own row, or for a member-manager (`contactVisible` says which).",
  })
  @ApiQuery({
    name: "q",
    required: false,
    description:
      "Free text: a name (contains), a phone number (contains, digits compared) or an exact flat number.",
  })
  @ApiQuery({
    name: "status",
    required: false,
    description:
      "One of pending, active, inactive, removed, rejected. Absent means every live status.",
  })
  @ApiOkResponse({
    description:
      "One page of the directory, plus what the caller may do with it.",
    schema: envelopeSchemaOf(memberListResponseSchema),
  })
  async list(
    @Ctx() context: RequestCtx,
    @Query(new ZodPipe(memberListQuerySchema))
    query: z.infer<typeof memberListQuerySchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    // The edge between the wire and the domain, spelled field by field, and two of the
    // translations are load bearing:
    //
    //  - the id filters arrive as plain strings and are branded here, at the one boundary where
    //    a raw string becomes a domain id (the same place the path parameters are branded);
    //  - the search parameter is `q` on the wire (short, because it is a URL) and `query` in the
    //    domain (because that is what it is). A spread would have carried `q` through unnoticed
    //    and the search would silently have matched nothing — the kind of bug that only shows up
    //    when somebody types in the box.
    const {
      q,
      buildingId,
      apartmentId,
      role,
      status,
      occupancy,
      sort,
      limit,
      offset,
    } = query;
    const filters: MemberQuery = {
      ...(q === undefined || q.trim().length === 0 ? {} : { query: q }),
      ...(role === undefined ? {} : { role }),
      ...(status === undefined ? {} : { status }),
      ...(occupancy === undefined ? {} : { occupancy }),
      ...(buildingId === undefined
        ? {}
        : { buildingId: asBuildingId(buildingId) }),
      ...(apartmentId === undefined
        ? {}
        : { apartmentId: asApartmentId(apartmentId) }),
      ...(sort === undefined ? {} : { sort }),
      limit,
      offset,
    };
    const directory = await this.operations.list(
      asUserId(userId),
      society.id,
      filters,
    );
    return memberListToDto(directory);
  }

  /**
   * Add a member directly — a *shadow member*, with no account until they sign up (PRD §3.3).
   *
   * The role is not accepted and not returned as a choice: the row is created as a `resident`
   * and `active`, which is what "must still be billed" requires. Assigning a role is T046's
   * operation and runs through a guarded, audited path.
   */
  @Post()
  @RequirePermission("member.invite")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Add a member directly",
    description:
      "Admin or Treasurer. Records an occupant who has no account yet (PRD §3.3's shadow member) — name and phone, optionally with a flat, occupancy, lease window and the directory consent flag. The phone is normalised to E.164 and must not already be held by another shadow member of this society.",
  })
  @ApiCreatedResponse({
    description: "The member that was recorded.",
    schema: envelopeSchemaOf(memberResponseSchema),
  })
  async add(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(createMemberSchema))
    body: z.infer<typeof createMemberSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const created = await this.operations.add(
      asUserId(userId),
      society.id,
      body,
    );
    return memberResponseToDto(created.member);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk CSV import (T048) — declared before `:memberId` for the same route-ordering
  // reason `join-requests` is, so the literal paths can never be swallowed by the
  // parameter route.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * The import's preview: parse, validate, resolve flats, check collisions — and write
   * nothing (T048's mandatory dry run).
   *
   * `member.invite` — the same grant the direct-add route declares — is the existing
   * permission for "keeps the directory" (Admin and Treasurer, PRD §2.1), and an import
   * *is* a directory add at scale. No new action was created: a CSV column that minted
   * roles would be an escalation the matrix never granted, and importing a member grants
   * no power the add form does not.
   */
  @Post("import/preview")
  @RequirePermission("member.invite")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Preview a bulk member import",
    description:
      "Admin or Treasurer. Validates the whole CSV file — header, per-row fields (name and phone required, phone normalised to E.164), flat references, in-file duplicates, existing memberships and open invitations — and classifies every row as valid, invalid or conflicted, each failure addressed by its file line and a stable error code. Writes nothing: membership state is untouched by this call. At most 1,000 data rows per file.",
  })
  @ApiOkResponse({
    description:
      "Every row with its classification, the six summary counters (total = imported + invalid + conflicts), and what the caller may do.",
    schema: envelopeSchemaOf(csvImportPreviewResponseSchema),
  })
  async importPreview(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(csvImportRequestSchema))
    body: z.infer<typeof csvImportRequestSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const preview = await this.operations.importPreview(
      asUserId(userId),
      society.id,
      body,
    );
    return csvImportPreviewToDto(preview);
  }

  /**
   * The confirmed import: the preview's pass, then one direct-add-shaped create per valid
   * row.
   *
   * **Partial success**, because T048 says so: "valid rows import even when others fail;
   * nothing is silently dropped". Every failure — field-level, conflict-level or a
   * storage refusal a racing join approval could still trigger after the preview — comes
   * back per row with its line number, and the summary's arithmetic makes the "nothing
   * dropped" property checkable: `total = imported + invalid + conflicts`.
   *
   * Idempotency under retry is the database's own uniqueness (`uq_members_shadow_phone`),
   * not a client key: a retried import refuses its already-imported rows with
   * `ALREADY_MEMBER` and imports only the rest, which is deterministic.
   */
  @Post("import")
  @RequirePermission("member.invite")
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({
    description:
      "The created members, every per-row failure, the summary counters, and what the caller may do.",
    schema: envelopeSchemaOf(csvImportResultResponseSchema),
  })
  @ApiOperation({
    summary: "Import members from a CSV file",
    description:
      "Admin or Treasurer. Runs the same validation as the preview, then creates each valid row as an active resident (the direct-add path's rules — no role column; role assignment is the guarded role operation). Valid rows import even when others fail; every failure returns per row with its file line. Retrying the same file cannot double-create: the database's shadow-phone uniqueness refuses rows that already imported, and those arrive as per-row failures.",
  })
  @ApiCreatedResponse({
    description:
      "The created members, every per-row failure, the summary counters, and what the caller may do.",
    schema: envelopeSchemaOf(csvImportResultResponseSchema),
  })
  async importMembers(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(csvImportRequestSchema))
    body: z.infer<typeof csvImportRequestSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const result = await this.operations.importMembers(
      asUserId(userId),
      society.id,
      body,
    );
    return csvImportResultToDto(result);
  }

  /**
   * The join queue: everybody waiting to be admitted, with their flats' other claimants
   * beside them (T049; PRD §3.2's "route it to the Admin with both claims visible").
   *
   * `member.approve` — Admin and Treasurer — where the directory is `member.view` (everyone
   * but a Guest). A Resident may browse the roster and must not be handed a decision screen;
   * the declared permission is what makes that distinction a guard rather than a UI habit.
   *
   * Declared **before** `:memberId` for the same reason `me` is: Nest registers routes in
   * declaration order, and the parameter route would otherwise answer this path with a
   * `VALIDATION_ERROR` for a non-UUID id.
   */
  @Get("join-requests")
  @RequirePermission("member.approve")
  @ApiOperation({
    summary: "List pending join requests",
    description:
      "Admin or Treasurer. One page of the society's pending memberships, newest first, each with `claims` — every live membership naming the same flat, the request included — so a second claim on one flat is visible before the decision rather than after it. A request with no flat has an empty `claims`.",
  })
  @ApiOkResponse({
    description:
      "One page of the join queue, plus what the caller may do with it.",
    schema: envelopeSchemaOf(joinRequestListResponseSchema),
  })
  async joinRequests(
    @Ctx() context: RequestCtx,
    @Query(new ZodPipe(joinRequestListQuerySchema))
    query: z.infer<typeof joinRequestListQuerySchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const queue = await this.operations.joinRequests(
      asUserId(userId),
      society.id,
      query,
    );
    return joinQueueToDto(queue);
  }

  /**
   * Approve a request: `pending → active`, with the role, occupancy and flat confirmed.
   *
   * The body is optional in every field, and **absent means "as requested"** — the requester
   * already declared an occupancy and a flat, so an approver who agrees with both sends `{}`.
   * Clearing a wrong flat is an explicit `null`, which is the only way the two intents can be
   * told apart.
   *
   * The atomicity is not in this handler: `member_approve_join()` locks the row, re-checks
   * that it is still pending and re-resolves the reviewer before writing, so two reviewers
   * approving at the same moment produce one active membership and one decision. The second
   * is answered `409` with `JOIN_REQUEST_NOT_PENDING` — the code that says the request has
   * already been decided.
   */
  @Post("join-requests/:memberId/approve")
  @RequirePermission("member.approve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Approve a join request",
    description:
      "Admin or Treasurer. Admits a pending member, assigning the role and occupancy (defaults: the request's own occupancy, and Resident) and the flat the approver confirms. A role above Resident requires `member.role_change` (Admin only). Refused with 409 `JOIN_REQUEST_NOT_PENDING` when the request was already decided, with 403 when it is the caller's own request, and with 409 when the flat already has a primary occupant for that occupancy.",
  })
  @ApiParam({
    name: "memberId",
    description: "Membership UUID of the pending request.",
  })
  @ApiOkResponse({
    description: "The admitted member, now active.",
    schema: envelopeSchemaOf(joinRequestResponseSchema),
  })
  async approveJoinRequest(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
    @Body(new ZodPipe(approveJoinRequestSchema))
    body: z.infer<typeof approveJoinRequestSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const approved = await this.operations.approveJoinRequest(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
      body,
    );
    return joinDecisionToDto(approved);
  }

  /**
   * Reject a request, with the reason the requester is owed.
   *
   * `POST /reject` rather than a `status` field on a patch: the transition is the operation,
   * it has a precondition (the request must still be pending) and a required argument the
   * generic patch cannot express. A `status` field would also let a client spell "reject" as
   * "set rejected" while skipping the reason, which is the one thing a rejection must carry.
   */
  @Post("join-requests/:memberId/reject")
  @RequirePermission("member.approve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reject a join request",
    description:
      "Admin or Treasurer. Refuses a pending request and records the reason the requester is shown. The reason is required and bounded. Refused with 409 `JOIN_REQUEST_NOT_PENDING` when the request was already decided, and with 403 when it is the caller's own request. A rejected requester may ask again, and the previous reason stays on the row so the next reviewer sees it.",
  })
  @ApiParam({
    name: "memberId",
    description: "Membership UUID of the pending request.",
  })
  @ApiOkResponse({
    description: "The refused member, with the reason recorded.",
    schema: envelopeSchemaOf(joinRequestResponseSchema),
  })
  async rejectJoinRequest(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
    @Body(new ZodPipe(rejectJoinRequestSchema))
    body: z.infer<typeof rejectJoinRequestSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const rejected = await this.operations.rejectJoinRequest(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
      body.reason,
    );
    return joinDecisionToDto(rejected);
  }

  /**
   * The caller's own membership — who am I in this society, and what may I do.
   *
   * Declared **before** `:memberId` on purpose: the other route validates its parameter as a
   * UUID, so `me` would reach the pipe and be answered `VALIDATION_ERROR` if the literal route
   * were registered second. Nest registers a controller's routes in declaration order.
   *
   * The mobile app's member repository implements the domain's `findViewer` with this route,
   * which is what lets its screens call the same use cases the API does. The declared permission
   * is `member.view` — the *coarse* half of the check, exactly as on the routes below — while the
   * use case itself applies no capability gate, because a gate needs the row it is deciding
   * about (a suspended member is entitled to an answer about their own membership, not to a
   * refusal that cannot name it).
   */
  @Get("me")
  @RequirePermission("member.view")
  @ApiOperation({
    summary: "View your own membership",
    description:
      "The caller's own membership row in the society named in X-Society-Id, with their capabilities. A caller with no live membership is answered 404, the same as one outside the society.",
  })
  @ApiOkResponse({
    description: "The caller's membership and capabilities.",
    schema: envelopeSchemaOf(memberDetailResponseSchema),
  })
  async viewer(@Ctx() context: RequestCtx) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const detail = await this.operations.getViewer(
      asUserId(userId),
      society.id,
    );
    return memberDetailToDto(detail.member, detail.capabilities);
  }

  /** One member — the details screen's read, gated by the same `member.view` as the list. */
  @Get(":memberId")
  @RequirePermission("member.view")
  @ApiOperation({
    summary: "View a member",
    description:
      "One member of the society named in X-Society-Id, with the caller's capabilities and the member's contact details subject to consent.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description: "The member and the caller's capabilities.",
    schema: envelopeSchemaOf(memberDetailResponseSchema),
  })
  async detail(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const detail = await this.operations.get(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
    );
    return memberDetailToDto(detail.member, detail.capabilities);
  }

  /**
   * Edit a member's details.
   *
   * An absent field is left unchanged; an explicit `null` clears a phone number, an email
   * address, a flat or a lease date — the distinction a shadow member's record depends on, since
   * their number is the only identifier they have.
   */
  @Patch(":memberId")
  @RequirePermission("member.invite")
  @ApiOperation({
    summary: "Edit a member",
    description:
      "Admin or Treasurer partial patch. An absent field is unchanged and an explicit null clears it. At least one field must be present. Role and status are not patchable here — they are their own operations.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description: "The updated member.",
    schema: envelopeSchemaOf(memberResponseSchema),
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
    @Body(new ZodPipe(updateMemberSchema))
    body: z.infer<typeof updateMemberSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const updated = await this.operations.update(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
      body,
    );
    return memberResponseToDto(updated.member);
  }

  /**
   * Suspend a member: `active → inactive`.
   *
   * A `POST` on a sub-resource rather than a `PATCH` of `status`, and that is the point: the
   * transition is the operation, it has a precondition (the member must be active) and it will
   * grow a reason and an audit entry when T050 lands. A `status` field on the patch would let a
   * client name a status the lifecycle does not have — `pending`, or `rejected`.
   */
  @Post(":memberId/suspend")
  @RequirePermission("member.remove")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Suspend a member",
    description:
      "Admin-only. Moves an active membership to inactive: the member stays attached to the society with their flat, role and history, and can no longer act in it.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description: "The suspended member.",
    schema: envelopeSchemaOf(memberResponseSchema),
  })
  async suspend(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const suspended = await this.operations.suspend(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
    );
    return memberResponseToDto(suspended.member);
  }

  /** Reactivate a suspended member: `inactive → active`. */
  @Post(":memberId/reactivate")
  @RequirePermission("member.remove")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reactivate a member",
    description:
      "Admin-only. Moves a suspended membership back to active. A membership still pending approval is not reactivated here — approval is the join queue's operation (T049).",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description: "The reactivated member.",
    schema: envelopeSchemaOf(memberResponseSchema),
  })
  async reactivate(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const reactivated = await this.operations.reactivate(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
    );
    return memberResponseToDto(reactivated.member);
  }

  /**
   * Assign or change a member's role (T046) — the PRD §2.1 grant, Admin only.
   *
   * `PATCH` on a sub-resource rather than a `role` field on the member patch, for the reason the
   * suspend route gives: the operation is the transition, and a field on the edit form would let a
   * client put a role and a flat assignment in one request with no way to attribute the refusal. It
   * also keeps `member.invite` (Admin **and** Treasurer) from becoming a way to hand out roles — a
   * Treasurer may edit a member, and the two operations have different grants.
   *
   * The body is one role, never a permission: there is no field to ask for a grant with, which is
   * the security property the whole model rests on (see `@ses/contracts/permissions.ts`).
   *
   * The response is the membership's **recomputed** permission list, from the row the database
   * returned — so a screen that just changed a role renders the server's answer rather than its own
   * guess, and a trigger that refused or changed something cannot leave the two disagreeing.
   */
  @Patch(":memberId/role")
  @RequirePermission("member.role_change")
  @ApiOperation({
    summary: "Assign or change a member's role",
    description:
      "Admin-only. Sets the role the membership should hold — a promotion, a rotation or a first appointment are the same write. Refused with 403 for your own membership (nobody changes their own role), with 409 `ROLE_CAP_EXCEEDED` when the role is at PRD §2.2's cap (3 admins, 2 treasurers), with 409 when the member is not active, and with `SOCIETY_ADMIN_REQUIRED` when the change would leave the society without an active Admin.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description: "The member's new role and the permissions it holds.",
    schema: envelopeSchemaOf(assignRoleResponseSchema),
  })
  async assignRole(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
    @Body(new ZodPipe(assignRoleSchema)) body: z.infer<typeof assignRoleSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const changed = await this.operations.assignRole(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
      body.role,
    );
    return memberPermissionsToDto(changed);
  }

  /**
   * Revoke a member's role — PRD §2.3's "Admin revokes": the membership returns to `resident`.
   *
   * `DELETE` on the sub-resource because that is what revocation is *to the caller* — the
   * appointment ends — while underneath it is the same write as an assignment to `resident`, with
   * the same cap and last-Admin checks. No body: a role in it would let a caller spell revocation
   * as "assign resident", and the two differ in what the operation means and in what an audit entry
   * (T050) will say about it.
   */
  @Delete(":memberId/role")
  @RequirePermission("member.role_change")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Revoke a member's role",
    description:
      "Admin-only. Returns the membership to the default role (`resident`) while keeping the row, the flat and the history. Refused on your own membership and with `SOCIETY_ADMIN_REQUIRED` if it would leave the society with no active Admin.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiOkResponse({
    description:
      "The member's role after the revocation and the permissions it now holds.",
    schema: envelopeSchemaOf(assignRoleResponseSchema),
  })
  async revokeRole(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const changed = await this.operations.revokeRole(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
    );
    return memberPermissionsToDto(changed);
  }

  /**
   * Remove a member — soft, and Admin-only.
   *
   * The row survives with `status = 'removed'` and its stamps, because dues, payments and
   * receipts point at it (PRD §3.3: "Financial history is never deleted"). Leaving the society
   * is the same row state reached by the member themselves and is `POST /v1/societies/:id/leave`;
   * this route is for the Admin removing somebody else, and it refuses a self-removal so the two
   * paths cannot be confused.
   */
  @Delete(":memberId")
  @RequirePermission("member.remove")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Remove a member",
    description:
      "Admin-only soft removal: the membership is marked removed and disappears from every read path, while the row and its financial history are kept. Refused with SOCIETY_ADMIN_REQUIRED if it would leave the society without an active Admin.",
  })
  @ApiParam({ name: "memberId", description: "Member UUID." })
  @ApiNoContentResponse({
    description: "Removed. The member is no longer readable or addressable.",
  })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("memberId", new ZodPipe(memberIdParam)) memberId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    // No body. After a removal the row is absent from every read path, so any representation
    // returned here would have to bypass the very filter that makes the removal meaningful —
    // and the client already knows what it asked for.
    await this.operations.remove(
      asUserId(userId),
      society.id,
      asMemberId(memberId),
    );
  }
}
