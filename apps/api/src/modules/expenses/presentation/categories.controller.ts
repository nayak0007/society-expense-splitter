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
  createExpenseCategorySchema,
  expenseCategoryListResponseSchema,
  expenseCategoryResponseSchema,
  updateExpenseCategorySchema,
} from "@ses/contracts";
import { asExpenseCategoryId, asUserId } from "@ses/domain";
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
import { ExpenseCategoryOperations } from "../application/expense-category.operations";
import {
  expenseCategoryListToDto,
  expenseCategoryResponseToDto,
} from "./category.mapper";
import { ApiExpenseCategoryErrors } from "./openapi";

/**
 * Expense-category endpoints — Roadmap T062.
 *
 * ## Header-scoped, unlike the PRD's sketch
 *
 * PRD §1805 sketches these as `/societies/:id/categories`. They ship as `/v1/
 * expense-categories` behind `X-Society-Id`, which is how every module since the
 * society module addresses itself, and the reason is the one `buildings.controller.ts`
 * records in full: `SocietyGuard` and `PermissionGuard` are **inert unless a route
 * declares `@RequirePermission(…)`**, and a permission is a *per-membership* grant — so
 * a route that names one is by definition society-scoped, and the header is how it says
 * which society. A `:societyId` path parameter with no declared permission would run
 * with no membership resolution at all, because the guard chain simply would not apply.
 * Mixing the two would be worse than either: a param *and* a header can disagree, the
 * guard authorises against the header while the query reads the path, and nothing in
 * between notices.
 *
 * The path is `expense-categories` rather than `/categories` because a bare plural would
 * collide with the next module that needs categories — complaints have their own
 * (PRD §568), and `VisitorCategory`/`ComplaintCategory` are both plausible — and a
 * module-qualified segment is cheaper than an alias later. It is also the sibling shape
 * of `/buildings` and `/apartments`: a header-scoped noun, unprefixed by `/v1/societies`.
 *
 * ## Which permission, and why not a new one
 *
 * Writes declare `expense.publish` and reads declare `expense.view`, which are exactly
 * T060's `can_publish_expenses()` (Admin or Treasurer — its own comment says "and of
 * category writes") and `can_view_expenses()` (every role but Guest). Both are **green**
 * cells for every role that holds them, so nothing here narrows against a record and no
 * entry belongs in the route inventory's `NARROWED_ROUTES`: a category has no owner, no
 * assignee and no draft state, so the only question the matrix can ask about one is the
 * tenant question — and `societyId` is already the scope every query carries.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input (through the contract's own Zod schemas), calls one use
 * case through `ExpenseCategoryOperations`, and maps the result to a DTO. Every rule —
 * who may write, whether the caller is a member, what a valid name or colour is, whether
 * a category is still referenced — lives in `@ses/application`/`@ses/domain`, shared
 * with the mobile client, and every read and write reaches the database under the
 * caller's own RLS identity. A permission check written here would be a third
 * implementation of a rule that already exists in two places that cannot drift (the
 * domain's matrix and the SQL policies), in the one place with no test coverage of its
 * own.
 *
 * ## The society comes from the guard, never from the request
 *
 * `requireSociety(context)` reads the context `SocietyGuard` resolved — the one *and*
 * the membership, from a single database read, with the permission already evaluated
 * against it. Re-reading the header here would be a second source of truth for the
 * tenant scope, which is the class of bug SAD §1.1 names outright: scope comes from the
 * token and the membership, never from the request.
 */

/**
 * Path parameters are UUIDs, checked before any query runs.
 *
 * Not cosmetic: a non-UUID reaches Postgres as `$1::uuid` and fails there with a `22P02`
 * that the error classifier can only report as `unknown`, turning a client bug into a
 * 500. Validating here answers `VALIDATION_ERROR` with the offending field, which is a
 * client's to fix.
 *
 * Declared before the controller because a parameter decorator's expression is evaluated
 * when the class is defined — referencing it from below would be a temporal-dead-zone
 * error at import time, not a compile error.
 */
const categoryIdParam = z.uuid();

@ApiTags("expense-categories")
@ApiExpenseCategoryErrors()
@ApiSocietyContext()
@Controller("expense-categories")
export class ExpenseCategoriesController {
  constructor(private readonly operations: ExpenseCategoryOperations) {}

  /**
   * The society's expense vocabulary, in display order.
   *
   * Every live category — active *and* deactivated — because this is the screen that
   * brings one back, and an active-only list would make deactivation a one-way door.
   * `isActive` travels on every row, so a client that wants the expense picker's view
   * filters in one line.
   *
   * An empty array is a successful answer, not a 404: `seed_society()` seeds nineteen
   * rows at society creation, so an empty list means the seed has not run for this
   * society — a state the onboarding flow can produce, and one this screen fixes. A
   * *Guest*, whose role holds no `expense.view`, is refused with 403 instead, because
   * "nothing here yet" and "not for you" must not be the same screen.
   */
  @Get()
  @RequirePermission("expense.view")
  @ApiOperation({
    summary: "List a society's expense categories",
    description:
      "Every live category of the society named in X-Society-Id, ordered by display order then name, with the caller's capabilities. Deactivated categories are included — this is the screen that reactivates them. An empty list means the society has not been seeded yet; a role that may not view categories is refused instead.",
  })
  @ApiOkResponse({
    description: "The society's expense categories, in display order.",
    schema: envelopeSchemaOf(expenseCategoryListResponseSchema),
  })
  async list(@Ctx() context: RequestCtx) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const list = await this.operations.list(asUserId(userId), society.id);
    return expenseCategoryListToDto(list.categories, list.capabilities);
  }

  @Post()
  @RequirePermission("expense.publish")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create an expense category",
    description:
      "Admin or Treasurer. The name is unique among the society's live categories, compared exactly as stored, so a name that was used and then removed is available again. Every field but the name is optional and takes the column's default.",
  })
  @ApiCreatedResponse({
    description: "The created category.",
    schema: envelopeSchemaOf(expenseCategoryResponseSchema),
  })
  async create(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(createExpenseCategorySchema))
    body: z.infer<typeof createExpenseCategorySchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const category = await this.operations.create(
      asUserId(userId),
      society.id,
      body,
    );
    return expenseCategoryResponseToDto(category);
  }

  @Patch(":categoryId")
  @RequirePermission("expense.publish")
  @ApiOperation({
    summary: "Edit an expense category",
    description:
      "Admin or Treasurer partial patch. An absent field is left unchanged; an explicit `null` clears `icon`, `color` or `defaultApartmentBasis`; at least one field must be present. Every seeded category is editable, including its name and flags.",
  })
  @ApiParam({ name: "categoryId", description: "Expense category UUID." })
  @ApiOkResponse({
    description: "The updated category.",
    schema: envelopeSchemaOf(expenseCategoryResponseSchema),
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("categoryId", new ZodPipe(categoryIdParam)) categoryId: string,
    @Body(new ZodPipe(updateExpenseCategorySchema))
    body: z.infer<typeof updateExpenseCategorySchema>,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const category = await this.operations.update(
      asUserId(userId),
      society.id,
      asExpenseCategoryId(categoryId),
      body,
    );
    return expenseCategoryResponseToDto(category);
  }

  @Delete(":categoryId")
  @RequirePermission("expense.publish")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Delete an expense category",
    description:
      "Admin or Treasurer soft delete: the row is kept so the expenses filed under it keep their subject, and it disappears from every read path. Refused with 409 `CATEGORY_HAS_EXPENSES` while any expense references the category — deactivate it instead.",
  })
  @ApiParam({ name: "categoryId", description: "Expense category UUID." })
  @ApiNoContentResponse({
    description:
      "Deleted. The category is no longer readable or addressable, and its name is available again.",
  })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("categoryId", new ZodPipe(categoryIdParam)) categoryId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    // No body. After a soft delete the category is absent from every read path, so any
    // representation returned here would have to bypass the very filter that makes the
    // delete meaningful — and the client already knows what it asked for.
    await this.operations.remove(
      asUserId(userId),
      society.id,
      asExpenseCategoryId(categoryId),
    );
  }
}
