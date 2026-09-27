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
  apartmentDetailResponseSchema,
  apartmentListResponseSchema,
  apartmentResponseSchema,
  bulkCreateApartmentsRequestSchema,
  bulkCreateApartmentsResponseSchema,
  createApartmentSchema,
  generateApartmentsRequestSchema,
  generateApartmentsResponseSchema,
  updateApartmentSchema,
} from "@ses/contracts";
import { asApartmentId, asBuildingId, asUserId } from "@ses/domain";
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
  apartmentDetailToDto,
  apartmentListToDto,
  apartmentResponseToDto,
  bulkCreateApartmentsToDto,
  generateApartmentsToDto,
} from "./apartment.mapper";
import { ApiApartmentErrors, ApiStructureErrors } from "./openapi";

/**
 * Apartment endpoints — Roadmap T043.
 *
 * ## Two controllers, five routes, one vocabulary
 *
 * The collection is nested where the data is nested —
 * `/buildings/:buildingId/apartments` — and the individual flat is addressed
 * absolutely, at `/apartments/:apartmentId`. That split is not decoration:
 *
 *  - a flat cannot be created without saying which building, because the building
 *    is a NOT NULL column and, more importantly, because the pair
 *    `(buildingId, societyId)` is what makes a building in another society
 *    unreachable rather than merely unauthorised;
 *  - once a flat exists, its id is either known or it is not. Repeating the parent
 *    in every path would mean two ids that can disagree, and a route that
 *    authorised against one while reading the other is exactly the class of bug
 *    `buildings.controller.ts` names for the header/path pair.
 *
 * ## Header-scoped, like the building routes
 *
 * Addressed by `X-Society-Id`, not by a path parameter, and that is what puts them
 * behind the whole guard chain: `SocietyGuard` and `PermissionGuard` are inert
 * unless a route declares `@RequirePermission(…)`, and a permission is a
 * *per-membership* grant. So a route that names one is by definition
 * society-scoped, and the header is how it says which society.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input through the contract's own Zod schemas, calls one use
 * case through `StructureOperations`, and maps the result to a DTO. Every rule —
 * who may edit, whether the caller is a member, what a valid area is — lives in
 * `@ses/application`/`@ses/domain`, shared with the mobile client, and every read
 * and write reaches the database under the caller's own RLS identity.
 */

/**
 * Path parameters are UUIDs, checked before any query runs.
 *
 * Not cosmetic: a non-UUID reaches Postgres as `$1::uuid` and fails there with a
 * `22P02` that the error classifier can only report as `unknown`, turning a client
 * bug into a 500. Validating here answers `VALIDATION_ERROR` with the offending
 * field, which is a client's to fix.
 */
const apartmentIdParam = z.uuid();
const buildingIdParam = z.uuid();

/** `GET`/`POST /buildings/:buildingId/apartments` — the collection of one building. */
@ApiTags("apartments")
@ApiStructureErrors()
@ApiSocietyContext()
@Controller("buildings/:buildingId/apartments")
export class BuildingApartmentsController {
  constructor(private readonly operations: StructureOperations) {}

  /**
   * The building's flats, in floor then flat-number order.
   *
   * An empty array is a successful answer, not a 404: a building that was just
   * created genuinely has none, and this is the screen that fixes that — so the
   * client renders "add your first flat". A *Guest*, whose role holds no
   * `structure.view`, is refused with 403 instead, because "none yet" and "not for
   * you" must not be the same screen.
   */
  @Get()
  @RequirePermission("structure.view")
  @ApiOperation({
    summary: "List a building's flats",
    description:
      "Every live flat of one building in the society named in X-Society-Id, ordered by floor then flat number, with the caller's capabilities. An empty list means the building has none yet — a role that may not view the structure is refused instead.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiOkResponse({
    description: "The building's flats, in reading order.",
    schema: envelopeSchemaOf(apartmentListResponseSchema),
  })
  async list(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const list = await this.operations.listApartments(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
    );
    return apartmentListToDto(list.apartments, list.capabilities);
  }

  /**
   * Create a flat.
   *
   * Admin-only. The flat number is unique among the building's **live** flats, so a
   * number that was used and then removed is available again — and a clash arrives
   * as a `409` carrying `field: 'apartmentNumber'`, which is what lets the form
   * highlight the input rather than show a banner.
   */
  @Post()
  @RequirePermission("structure.edit")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a flat",
    description:
      "Admin-only. Creates a flat inside the named building; the flat number must be unique among the building's live flats.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiCreatedResponse({
    description: "The created flat.",
    schema: envelopeSchemaOf(apartmentResponseSchema),
  })
  async create(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
    @Body(new ZodPipe(createApartmentSchema))
    body: z.infer<typeof createApartmentSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const apartment = await this.operations.createApartment(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
      body,
    );
    return apartmentResponseToDto(apartment);
  }

  /**
   * Generate flats from a numbering pattern (Roadmap T044).
   *
   * Admin-only, like every write here. The same route serves the preview and
   * the commit: `dryRun: true` expands the pattern, reports what would be
   * created and skipped, and writes **nothing** — the response body is identical
   * in both modes, which is what makes the preview trustworthy. Existing numbers
   * are skipped and reported rather than refusing the batch, so re-running after
   * a partial generation completes it.
   */
  @Post("generate")
  @RequirePermission("structure.edit")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Generate flats from a pattern",
    description:
      "Admin-only. Expands a numbering pattern ({wing}, {floor}, {floor:0Nd}, {unit}, {unit:0Nd}, {prefix}, {suffix}) across floors, wings and units per floor, up to 2,000 flats per call. With dryRun=true (or omitted) nothing is written; with dryRun=false every label no live flat carries is created. Existing numbers are skipped and reported.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiCreatedResponse({
    description:
      "The generation report: every expanded label with `created` or `skipped`.",
    schema: envelopeSchemaOf(generateApartmentsResponseSchema),
  })
  async generate(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
    @Body(new ZodPipe(generateApartmentsRequestSchema))
    body: z.infer<typeof generateApartmentsRequestSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const result = await this.operations.generateApartments(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
      {
        pattern: body.pattern,
        floors: body.floors,
        unitsPerFloor: body.unitsPerFloor,
        wings: body.wings,
        prefix: body.prefix,
        suffix: body.suffix,
        // An omitted flag resolves to a **preview**: a client that forgets it
        // gets a report and re-runs with `false` — never a surprise write.
        dryRun: body.dryRun ?? true,
      },
    );
    return generateApartmentsToDto(result);
  }

  /**
   * Bulk-create flats (Roadmap T043).
   *
   * Admin-only, and transactional: the batch is one transaction, so a failure
   * that is not a per-row refusal leaves nothing behind. Duplicate numbers —
   * inside the paste or already live in the building — are skipped **and
   * reported** per row, never silently dropped, and an invalid row is reported
   * with its field and reason while the rest of the batch proceeds.
   */
  @Post("bulk")
  @RequirePermission("structure.edit")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Bulk-create flats",
    description:
      "Admin-only. Creates many flats in one transactional call, with a per-row report: created, existing (already live), duplicate (repeated in the request) or invalid (with the field and reason). At most 2,000 rows per call.",
  })
  @ApiParam({ name: "buildingId", description: "Building UUID." })
  @ApiCreatedResponse({
    description:
      "The per-row report and the created flats, with the defaults each row resolved.",
    schema: envelopeSchemaOf(bulkCreateApartmentsResponseSchema),
  })
  async bulkCreate(
    @Ctx() context: RequestCtx,
    @Param("buildingId", new ZodPipe(buildingIdParam)) buildingId: string,
    @Body(new ZodPipe(bulkCreateApartmentsRequestSchema))
    body: z.infer<typeof bulkCreateApartmentsRequestSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const result = await this.operations.bulkCreateApartments(
      asUserId(userId),
      society.id,
      asBuildingId(buildingId),
      { buildingId: asBuildingId(buildingId), rows: body.rows },
    );
    return bulkCreateApartmentsToDto(result);
  }
}

/** `/apartments/:apartmentId` — one flat, addressed on its own. */
@ApiTags("apartments")
@ApiApartmentErrors()
@ApiSocietyContext()
@Controller("apartments")
export class ApartmentsController {
  constructor(private readonly operations: StructureOperations) {}

  @Get(":apartmentId")
  @RequirePermission("structure.view")
  @ApiOperation({
    summary: "View a flat",
    description:
      "One flat of the society named in X-Society-Id, with the caller's capabilities.",
  })
  @ApiParam({ name: "apartmentId", description: "Apartment UUID." })
  @ApiOkResponse({
    description: "The flat and the caller's capabilities.",
    schema: envelopeSchemaOf(apartmentDetailResponseSchema),
  })
  async detail(
    @Ctx() context: RequestCtx,
    @Param("apartmentId", new ZodPipe(apartmentIdParam)) apartmentId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const view = await this.operations.getApartment(
      asUserId(userId),
      society.id,
      asApartmentId(apartmentId),
    );
    return apartmentDetailToDto(view.apartment, view.capabilities);
  }

  /**
   * Edit a flat.
   *
   * An absent field is left unchanged; an explicit `null` clears it. That pair is
   * the one thing this route does that the building patch does not, and it is the
   * reason a society can retract a recorded area without deleting the flat and
   * taking its members and history with it.
   */
  @Patch(":apartmentId")
  @RequirePermission("structure.edit")
  @ApiOperation({
    summary: "Edit a flat",
    description:
      "Admin-only partial patch. An absent field is left unchanged; `null` clears a nullable field; at least one field must be present.",
  })
  @ApiParam({ name: "apartmentId", description: "Apartment UUID." })
  @ApiOkResponse({
    description: "The updated flat.",
    schema: envelopeSchemaOf(apartmentResponseSchema),
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("apartmentId", new ZodPipe(apartmentIdParam)) apartmentId: string,
    @Body(new ZodPipe(updateApartmentSchema))
    body: z.infer<typeof updateApartmentSchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const apartment = await this.operations.updateApartment(
      asUserId(userId),
      society.id,
      asApartmentId(apartmentId),
      body,
    );
    return apartmentResponseToDto(apartment);
  }

  @Delete(":apartmentId")
  @RequirePermission("structure.edit")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Delete a flat",
    description:
      "Admin-only soft delete: the row is kept so members, dues and meter readings keep their subject, and it disappears from every read path.",
  })
  @ApiParam({ name: "apartmentId", description: "Apartment UUID." })
  @ApiNoContentResponse({
    description: "Deleted. The flat is no longer readable or addressable.",
  })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("apartmentId", new ZodPipe(apartmentIdParam)) apartmentId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    // No body: after a soft delete the flat is absent from every read path, so any
    // representation returned here would have to bypass the filter that makes the
    // delete meaningful — and the client already knows what it asked for.
    await this.operations.removeApartment(
      asUserId(userId),
      society.id,
      asApartmentId(apartmentId),
    );
  }
}
