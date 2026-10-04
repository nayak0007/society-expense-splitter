import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  previewSplitRequestSchema,
  previewSplitResponseSchema,
} from "@ses/contracts";
import type { PreviewSplitRequestPayload } from "@ses/contracts";
import { asUserId } from "@ses/domain";

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
import { PreviewSplitUseCase } from "../application/use-cases/preview-split.use-case";
import { expenseSplitPreviewToDto } from "./expense-preview.mapper";
import { ApiExpensePreviewErrors } from "./openapi";

/**
 * Expense endpoints — Roadmap T064's preview, and the routes T065/T066/T068 add beside it.
 *
 * ## The address is the PRD's
 *
 * `POST /v1/expenses/preview-split` — the PRD's API table lists exactly that path and gloss
 * ("no persistence — drives the live split editor"), and the `/v1` prefix is the
 * bootstrap's global one (SAD §7.3), so no controller writes it. The module-qualified
 * segment is the sibling shape of `/expense-categories`, `/buildings` and `/apartments`:
 * a header-scoped noun, unprefixed by `/v1/societies`, with the society coming from
 * `X-Society-Id` and never from the body (SAD §1.1).
 *
 * ## Which permission, and why it is not `expense.publish`
 *
 * `expense.create` is the matrix's cell for **composing** an expense, and it is the same
 * one T063's resolver gates on — Admin and Treasurer fully, a Committee Member as 🟡
 * *draft only*. A preview is precisely the Committee Member's draft-time question ("what
 * would this charge?"), while `expense.publish` ("Define split rules") is the authority to
 * commit the rule, not to try it. The 🟡 cell is also why this is the first route in the
 * repository with an entry in the route inventory's `NARROWED_ROUTES`: the use case narrows
 * the cell against the intended record (`kind: "expense", published: false`), because a
 * conditional grant without a `canOnResource` site is exactly the hole that list exists to
 * make loud.
 *
 * ## Nothing here decides anything, and nothing here writes anything
 *
 * The controller parses the body through the contract's own schema, reads the actor and
 * the society **from the guard's resolution** (never re-reading the header), calls one use
 * case and maps its result to the DTO. Every rule — who may preview, what an omitted
 * strategy defaults to, which flats are billed and who each charge is addressed to,
 * whether the split conserves — lives in the use case, `@ses/application` and
 * `@ses/split-engine`, shared with the mobile client and T066's publish path. The route
 * itself persists nothing: no expense, split, due or event is created by a preview, which
 * is the Roadmap's first acceptance criterion and is measured by the integration suite
 * rather than asserted here.
 */

@ApiTags("expenses")
@ApiExpensePreviewErrors()
@ApiSocietyContext()
@Controller("expenses")
export class ExpensesController {
  constructor(private readonly preview: PreviewSplitUseCase) {}

  /**
   * Prices a split for a selector — stateless, deterministic, no writes.
   *
   * `200` rather than `201`: nothing is created. The response is the PRD's own preview
   * shape — total, participant count, allocations with flat labels and weights, residual
   * and warnings — plus the flagged `unassigned` list T063 introduced, so a flat nobody can
   * be billed through is visible to the treasurer's queue instead of missing from the table.
   */
  @Post("preview-split")
  @RequirePermission("expense.create")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Preview an expense split",
    description:
      "Resolves the participant selector, computes the split with the same engine publishing uses, and returns the allocations, residual and warnings without persisting anything. An omitted `splitStrategy`/`apartmentBasis` takes the named category's defaults; a flat with no member to address the charge to is returned in `unassigned` rather than dropped.",
  })
  @ApiOkResponse({
    description:
      "The computed split: every allocation with its flat's label, weight and amount, the residual (always 0 after distribution), any data-quality warnings, and the flagged unassigned flats.",
    schema: envelopeSchemaOf(previewSplitResponseSchema),
  })
  async previewSplit(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(previewSplitRequestSchema))
    body: PreviewSplitRequestPayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);

    const preview = await this.preview.preview(asUserId(userId), society.id, {
      amountPaise: body.amountPaise,
      // The parsed selector travels as-is: the domain re-validates it through the same
      // `createParticipantSelector` a stored selector replays through, so the two paths
      // cannot disagree about what a selector is (T063).
      selector: body.participantSelector,
      categoryId: body.categoryId,
      splitStrategy: body.splitStrategy,
      apartmentBasis: body.apartmentBasis,
      splitConfig: body.splitConfig,
    });

    return expenseSplitPreviewToDto(preview);
  }
}
