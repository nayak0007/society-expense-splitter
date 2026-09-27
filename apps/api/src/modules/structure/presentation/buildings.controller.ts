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
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import {
  buildingDetailResponseSchema,
  buildingListResponseSchema,
  buildingResponseSchema,
  createBuildingSchema,
  updateBuildingSchema,
} from "@ses/contracts";
import { asBuildingId, asUserId } from "@ses/domain";
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
import { StructureOperations } from "../application/structure.operations";
import {
  buildingDetailToDto,
  buildingListToDto,
  buildingResponseToDto,
} from "./building.mapper";
import { ApiStructureErrors } from "./openapi";

/**
 * Building endpoints — Roadmap T042.
 *
 * ## Header-scoped, unlike the society routes
 *
 * These routes are addressed by `X-Society-Id` rather than by a `:societyId` path
 * segment, and that is what puts them behind the whole guard chain.
 * `SocietyGuard` and `PermissionGuard` are inert unless a route declares
 * `@RequirePermission(…)` (see `society.guard.ts` for why an unconditional society
 * guard would break the public join-code lookup), and a permission is a
 * *per-membership* grant — so a route that names one is by definition
 * society-scoped, and the header is how it says which society. The alternative —
 * a path parameter with no declared permission — would run with no membership
 * resolution at all, because the guard chain simply would not apply.
 *
 * Mixing the two would be worse than either: a `:societyId` param *and* an
 * `X-Society-Id` header can disagree, the guard authorises against the header
 * while the query reads the path, and nothing in between notices.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input (through the contract's own Zod schemas), calls one
 * use case through `StructureOperations`, and maps the result to a DTO. Every
 * rule — who may edit, whether the caller is a member, what a valid floor count is
 * — lives in `@ses/application`/`@ses/domain`, shared with the mobile client, and
 * every read and write reaches the database under the caller's own RLS identity. A
 * permission check written here would be a third implementation of a rule that
 * already exists in two places that cannot drift (the domain's matrix and the SQL
 * policies), in the one place with no test coverage of its own.
 *
 * ## The society comes from the guard, never from the request
 *
 * `requireSociety(context)` reads the context `SocietyGuard` resolved — the one
 * *and* the membership, from a single database read, with the permission already
 * evaluated against it. Re-reading the header here would be a second source of
 * truth for the tenant scope, which is the class of bug SAD §1.1 names outright:
 * scope comes from the token and the membership, never from the request.
 */

/**
 * Path parameters are UUIDs, checked before any query runs.
 *
 * Not cosmetic: a non-UUID reaches Postgres as `$1::uuid` and fails there with a
 * `22P02` that the error classifier can only report as `unknown`, turning a client
 * bug into a 500. Validating here answers `VALIDATION_ERROR` with the offending
 * field, which is a client's to fix.
 *
 * Declared before the controller because a parameter decorator's expression is
 * evaluated when the class is defined — referencing it from below would be a
 * temporal-dead-zone error at import time, not a compile error.
 */
const buildingIdParam = z.uuid();

@ApiTags("buildings")
@ApiStructureErrors()
@ApiSocietyContext()
@Controller("buildings")
export class BuildingsController {
  constructor(private readonly operations: StructureOperations) {}

  /**
   * The society's buildings, in display order.
   *
   * An empty array is a successful answer, not a 404: a society that has just been
   * created genuinely has none, and the structure step is the screen that fixes
   * that — so the client renders "add your first building" rather than an error. A
   * *Guest*, whose role holds no `structure.view`, is refused with 403 instead,
   * because "no buildings yet" and "not for you" must not be the same screen.
   */
  @Get()
  @RequirePermission("structure.view")
  @ApiOperation({
    summary: "List a society's buildings",
    description:
      "Every live building of the society named in X-Society-Id, ordered by display order then name, with the caller's capabilities. An empty list means the society has none yet — a role that may not view the structure is refused instead.",
  })
  @ApiOkResponse({
    description: "The society's buildings, in display order.",
    schema: envelopeSchemaOf(buildingListResponseSchema),
  })
  async list(@Ctx() context: RequestCtx) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const list = await this.operations.list(asUserId(userId), society.id);
    return buildingListToDto(list.buildings, list.capabilities);
  }

  @Post()
  @RequirePermission("structure.edit")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a building",
    description:
      "Admin-only. The name is unique among the society's live buildings, so a name that was used and then removed is available again.",
  })
  @ApiCreatedResponse({
    description: "The created building.",
    schema: envelopeSchemaOf(buildingResponseSchema),
  })
  async create(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(createBuildingSchema))
    body: z.infer<typeof createBuildingSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const building = await this.operations.create(
      asUserId(userId),
      society.id,
      body,
    );
    return buildingResponseToDto(building);
  }

  @Get(":buildingId")
  @RequirePermission("structure.view")
  @ApiOperation({
    summary: "View a building",
    description:
      "One building of the society named in X-Society-Id, with the caller's capabilities.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiOkResponse({
    description: "The building and the caller's capabilities.",
    schema: envelopeSchemaOf(buildingDetailResponseSchema),
  })
  async detail(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const view = await this.operations.get(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
    );
    return buildingDetailToDto(view.building, view.capabilities);
  }

  @Patch(":buildingId")
  @RequirePermission("structure.edit")
  @ApiOperation({
    summary: "Edit a building",
    description:
      "Admin-only partial patch. An absent field is left unchanged; at least one field must be present.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiOkResponse({
    description: "The updated building.",
    schema: envelopeSchemaOf(buildingResponseSchema),
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
    @Body(new ZodPipe(updateBuildingSchema))
    body: z.infer<typeof updateBuildingSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const building = await this.operations.update(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
      body,
    );
    return buildingResponseToDto(building);
  }

  @Delete(":buildingId")
  @RequirePermission("structure.edit")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Delete a building",
    description:
      "Admin-only soft delete: the row is kept so apartments and financial history keep their parent, and it disappears from every read path.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiNoContentResponse({
    description: "Deleted. The building is no longer readable or addressable.",
  })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    // No body. After a soft delete the building is absent from every read path, so
    // any representation returned here would have to bypass the very filter that
    // makes the delete meaningful — and the client already knows what it asked for.
    await this.operations.remove(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
    );
  }
}
