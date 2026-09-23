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
  createdSocietyResponseSchema,
  createSocietySchema,
  joinCodeSchema,
  joinSocietySchema,
  joinPreviewResponseSchema,
  membershipResponseSchema,
  societyProfileResponseSchema,
  societyResponseSchema,
  societySummaryListSchema,
  updateSocietySchema,
} from "@ses/contracts";
import { asSocietyId, asUserId } from "@ses/domain";
import { z } from "zod";

import { AppError } from "../../../common/errors/app-error";
import {
  Ctx,
  requireActor,
  type RequestCtx,
} from "../../../common/decorators/ctx.decorator";
import { NoEnvelope } from "../../../common/decorators/no-envelope.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { ZodPipe } from "../../../common/pipes/zod.pipe";
import { SocietyOperations } from "../application/society.operations";
import {
  createdSocietyToDto,
  joinPreviewToDto,
  membershipResponseToDto,
  profileToDto,
  societyToDto,
  summaryToDto,
} from "./society.mapper";
import { ApiSocietyErrors, envelopeSchemaOf } from "./openapi";

/**
 * Society endpoints — Roadmap T040.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input (through the contract's own Zod schemas), calls one
 * use case through `SocietyOperations`, and maps the result to a DTO. Every rule
 * — who may edit, whether the caller is a member, whether a join code has
 * expired — lives in `@ses/application`/`@ses/domain`, shared with the mobile
 * client, and every read and write reaches the database under the caller's own
 * RLS identity. A permission check written here would be a second implementation
 * of a rule that already exists in two places that cannot drift (the domain and
 * the SQL); a third, in the one place with no test coverage of its own, is how a
 * client and a server start disagreeing about who is an Admin.
 *
 * ## The actor
 *
 * `@Ctx()` carries the verified actor; `requireActor` turns a missing one into a
 * 401 rather than letting `undefined` reach a repository, where the failure would
 * surface as a confusing query error. That branch is unreachable while the global
 * guard is registered — which is exactly why it is cheap to keep: a route that
 * ever opts out of the guard fails loudly instead of quietly acting as nobody.
 *
 * ## Route order
 *
 * `/societies/lookup` is declared before `/societies/:societyId`. Fastify prefers
 * a static segment over a parameter, so both orders route correctly today, but
 * relying on that is how a refactor turns `lookup` into a society id.
 */
/**
 * Path parameters are UUIDs, checked before any query runs.
 *
 * Not cosmetic: a non-UUID reaches Postgres as `$1::uuid` and fails there with a
 * `22P02` that the error classifier can only report as `INTERNAL`, turning a
 * client bug into a 500. Validating here answers `VALIDATION_ERROR` with the
 * offending field, which is a client's to fix.
 *
 * Declared before the controller because a parameter decorator's expression is
 * evaluated when the class is defined — referencing it from below would be a
 * temporal-dead-zone error at import time, not a compile error.
 */
const societyIdParam = z.uuid();

@ApiTags("societies")
@ApiSocietyErrors()
@Controller("societies")
export class SocietiesController {
  constructor(private readonly operations: SocietyOperations) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a society",
    description:
      "Creates the society, its settings and the creator's Admin membership in one transaction. The slug and join code are generated server-side.",
  })
  @ApiCreatedResponse({
    description: "The created society and the creator's membership.",
    schema: envelopeSchemaOf(createdSocietyResponseSchema),
  })
  async create(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(createSocietySchema))
    body: z.infer<typeof createSocietySchema>,
  ) {
    const { userId } = requireActor(context);
    const created = await this.operations.create(asUserId(userId), body);
    return createdSocietyToDto(created.society, created.membership);
  }

  @Get()
  @ApiOperation({
    summary: "List the caller's societies",
    description:
      "Every society the caller belongs to, with their own role and membership status — what the society switcher renders.",
  })
  @ApiOkResponse({
    description: "The caller's societies, newest membership first.",
    schema: envelopeSchemaOf(societySummaryListSchema),
  })
  async list(@Ctx() context: RequestCtx) {
    const { userId } = requireActor(context);
    const summaries = await this.operations.list(asUserId(userId));
    return summaries.map((summary) => summaryToDto(summary));
  }

  /**
   * Public: the join screen must resolve a code before the user has joined
   * anything. The exposure is bounded by the SQL function, which returns name,
   * city, state, type and member count — never members, never settings, and never
   * another society's code.
   */
  @Public()
  @Get("lookup")
  @ApiOperation({
    summary: "Preview a join code (public)",
    description:
      "Resolves a join code to the society's public details. Returns name, city, state, type and member count only, and cannot be used to enumerate codes.",
  })
  @ApiQuery({
    name: "code",
    required: true,
    description: "The 6-character join code, case-insensitive.",
  })
  @ApiOkResponse({
    description: "The society the code belongs to.",
    schema: envelopeSchemaOf(joinPreviewResponseSchema),
  })
  async lookup(
    // Strict for the same reason the body schemas are (SAD §7.8 stage 1): an
    // unknown query parameter is a caller mistake worth reporting, not something
    // to ignore while returning a plausible-looking answer.
    @Query(new ZodPipe(z.strictObject({ code: joinCodeSchema })))
    query: { code: string },
  ) {
    const preview = await this.operations.lookupJoinCode(query.code);
    if (preview === null) {
      // A miss is a 404 in the module's own vocabulary, because the alternative —
      // a 200 carrying `null` — makes every client write the same branch, and one
      // of them eventually forgets. The message is the one `joinSociety` uses for
      // the same case, so the join screen has one string to show either way.
      throw new AppError(
        "NOT_FOUND",
        "That join code does not match any society.",
      );
    }
    return { preview: joinPreviewToDto(preview) };
  }

  @Post("join")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Join a society with a code",
    description:
      "Resolves the code, checks expiry against the server clock and records a membership. Never auto-approved: the membership comes back `pending` until an Admin approves it (PRD §3.2).",
  })
  @ApiCreatedResponse({
    description: "The membership that was created, or asked again.",
    schema: envelopeSchemaOf(membershipResponseSchema),
  })
  async join(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(joinSocietySchema))
    body: z.infer<typeof joinSocietySchema>,
  ) {
    const { userId } = requireActor(context);
    const membership = await this.operations.join(asUserId(userId), body);
    return membershipResponseToDto(membership);
  }

  @Get(":societyId")
  @ApiOperation({
    summary: "View a society profile",
    description:
      "The society, the caller's membership and the capabilities derived from them, so a screen never has to re-derive permissions from a role string.",
  })
  @ApiParam({ name: "societyId", description: "Society UUID." })
  @ApiOkResponse({
    description: "The society, the caller's membership and capabilities.",
    schema: envelopeSchemaOf(societyProfileResponseSchema),
  })
  async profile(
    @Ctx() context: RequestCtx,
    @Param("societyId", new ZodPipe(societyIdParam)) societyId: string,
  ) {
    const { userId } = requireActor(context);
    const view = await this.operations.profile(
      asUserId(userId),
      asSocietyId(societyId),
    );
    return profileToDto(view.society, view.membership, view.capabilities);
  }

  @Patch(":societyId")
  @ApiOperation({
    summary: "Edit a society",
    description:
      "Patches the society and/or its settings atomically. Admin-only. A field that is absent is left unchanged; one sent as an empty string is cleared.",
  })
  @ApiParam({ name: "societyId", description: "Society UUID." })
  @ApiOkResponse({
    description: "The updated society.",
    schema: envelopeSchemaOf(societyResponseSchema),
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("societyId", new ZodPipe(societyIdParam)) societyId: string,
    @Body(new ZodPipe(updateSocietySchema))
    body: z.infer<typeof updateSocietySchema>,
  ) {
    const { userId } = requireActor(context);
    const society = await this.operations.update(
      asUserId(userId),
      asSocietyId(societyId),
      body,
    );
    return { society: societyToDto(society) };
  }

  @Post(":societyId/join-code")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Regenerate the join code",
    description:
      "Admin-only. The new code is minted server-side and invalidates the previous one immediately, so a leaked code is contained by one action.",
  })
  @ApiParam({ name: "societyId", description: "Society UUID." })
  @ApiOkResponse({
    description: "The society, with its new join code.",
    schema: envelopeSchemaOf(societyResponseSchema),
  })
  async regenerateJoinCode(
    @Ctx() context: RequestCtx,
    @Param("societyId", new ZodPipe(societyIdParam)) societyId: string,
  ) {
    const { userId } = requireActor(context);
    const society = await this.operations.rotateJoinCode(
      asUserId(userId),
      asSocietyId(societyId),
    );
    return { society: societyToDto(society) };
  }

  @Post(":societyId/leave")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Leave a society",
    description:
      "Leaves, or withdraws a pending request. Refused with `SOCIETY_ADMIN_REQUIRED` if the caller is the only active Admin — a society can never be left without one.",
  })
  @ApiParam({ name: "societyId", description: "Society UUID." })
  @ApiNoContentResponse({
    description: "Left. The caller's membership is now `removed`.",
  })
  async leave(
    @Ctx() context: RequestCtx,
    @Param("societyId", new ZodPipe(societyIdParam)) societyId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    // No body. After leaving, the caller's own membership is `removed`, so any
    // read that could return it would have to bypass the very check that makes
    // leaving meaningful — and the client already knows what it asked for.
    await this.operations.leave(asUserId(userId), asSocietyId(societyId));
  }

  @Delete(":societyId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Delete a society",
    description:
      "Admin-only soft delete: the row is kept so financial history keeps its owner, it disappears from every read path and its join code stops resolving. Every membership is marked removed in the same transaction.",
  })
  @ApiParam({ name: "societyId", description: "Society UUID." })
  @ApiNoContentResponse({ description: "Deleted." })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("societyId", new ZodPipe(societyIdParam)) societyId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    await this.operations.remove(asUserId(userId), asSocietyId(societyId));
  }
}
