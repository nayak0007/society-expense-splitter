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
  createExpenseSchema,
  expenseListResponseSchema,
  expenseResponseSchema,
  listExpensesQuerySchema,
  previewSplitRequestSchema,
  previewSplitResponseSchema,
  updateExpenseSchema,
} from "@ses/contracts";
import type {
  CreateExpensePayload,
  ListExpensesQueryPayload,
  PreviewSplitRequestPayload,
  UpdateExpensePayload,
} from "@ses/contracts";
import { asExpenseId, asUserId } from "@ses/domain";
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
import { CreateExpenseUseCase } from "../application/use-cases/create-expense.use-case";
import { DeleteDraftUseCase } from "../application/use-cases/delete-draft.use-case";
import { GetExpenseUseCase } from "../application/use-cases/get-expense.use-case";
import { ListExpensesUseCase } from "../application/use-cases/list-expenses.use-case";
import { PreviewSplitUseCase } from "../application/use-cases/preview-split.use-case";
import { UpdateExpenseUseCase } from "../application/use-cases/update-expense.use-case";
import { expenseListToDto, expenseResponseToDto } from "./expense.mapper";
import { expenseSplitPreviewToDto } from "./expense-preview.mapper";
import { ApiExpenseDraftErrors, ApiExpensePreviewErrors } from "./openapi";

/**
 * Expense endpoints — Roadmap T064's preview and T065's draft lifecycle.
 *
 * ## The addresses are the PRD's, under the module's own noun
 *
 * `POST /v1/expenses`, `GET /v1/expenses`, `GET|PATCH|DELETE /v1/expenses/:expenseId`
 * and `POST /v1/expenses/preview-split` — the PRD's API table lists exactly these,
 * and the `/v1` prefix is the bootstrap's global one (SAD §7.3), so no controller
 * writes it. The society comes from `X-Society-Id` and never from the body or the
 * path (SAD §1.1) — the header-scoped shape `/expense-categories`, `/buildings` and
 * `/apartments` already use, and the reason stated there: the guard chain is inert
 * unless a route declares a permission, and a permission is a per-membership grant
 * that has to be resolved *for a society* before the handler runs.
 *
 * ## Two conditional cells, four narrowed routes
 *
 * The matrix's `expense.create` is 🟡 * draft only* for a Committee Member and
 * `expense.void` is 🟡 *own drafts*; every route that declares one is listed in the
 * route inventory's `NARROWED_ROUTES`, and each has its `canOnResource` site in a use
 * case: preview and create against the intended draft, update and delete against the
 * stored row. Reads declare `expense.view`, a green cell, and narrow nothing.
 *
 * ## Nothing here decides anything
 *
 * The controller parses input through the contract's own schemas, reads the actor and
 * the society from the guard's resolution (never re-reading the header), calls one use
 * case and maps its result to a DTO. Every rule — who may write, what a draft starts
 * as, what the threshold promotes, which filters exist, whether a caller may delete a
 * row — lives in the use cases, `@ses/domain` and the database policies.
 *
 * Path parameters are validated as UUIDs before any query runs: a non-UUID would
 * reach Postgres as `$1::uuid` and fail with a `22P02` the classifier can only report
 * as `unknown`, turning a client bug into a 500.
 */

const expenseIdParam = z.uuid();

@ApiTags("expenses")
@ApiSocietyContext()
@Controller("expenses")
export class ExpensesController {
  constructor(
    private readonly preview: PreviewSplitUseCase,
    private readonly createExpense: CreateExpenseUseCase,
    private readonly updateExpense: UpdateExpenseUseCase,
    private readonly getExpense: GetExpenseUseCase,
    private readonly listExpenses: ListExpensesUseCase,
    private readonly deleteDraft: DeleteDraftUseCase,
  ) {}

  /**
   * Create a draft — the PRD's "Add expense", completed by T065.
   *
   * `201` with the created expense. The server decides the state: a new expense is a
   * draft, and the only transition this route can apply is PRD §2.2's threshold rule —
   * an expense **above** the society's `approval_threshold_paise` lands in
   * `pending_approval` for an Admin or Treasurer, while a Committee Member's expense
   * stays a draft (their cell is draft-only, and the database's insert policy requires
   * `status = 'draft'` from them). Nothing is published, split or charged here; that
   * is T066.
   */
  @Post()
  @RequirePermission("expense.create")
  @HttpCode(HttpStatus.CREATED)
  @ApiExpenseDraftErrors()
  @ApiOperation({
    summary: "Create an expense",
    description:
      "Admin, Treasurer or Committee Member. The expense starts as a draft; an expense above the society's approval threshold is moved to pending_approval for Admin/Treasurer callers, while a Committee Member's expense stays a draft. The category's default strategy and basis fill an omitted splitStrategy/apartmentBasis through the same resolution the preview uses. No splits, dues or publication are produced.",
  })
  @ApiCreatedResponse({
    description: "The created expense.",
    schema: envelopeSchemaOf(expenseResponseSchema),
  })
  async create(
    @Ctx() context: RequestCtx,
    @Body(new ZodPipe(createExpenseSchema)) body: CreateExpensePayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const record = await this.createExpense.create(
      asUserId(userId),
      society.id,
      body,
    );
    return expenseResponseToDto(record);
  }

  /**
   * One page of the society's expenses, newest first.
   *
   * Every filter is a named parameter (SAD §7.5) and the pagination is cursor-based
   * (SAD §7.4). Drafts are included and visible to every member, which is the
   * product's transparency principle rather than an oversight: the draft state is
   * not a secrecy state, and the transaction lines a Treasurer is preparing are
   * exactly what a resident is entitled to inspect.
   */
  @Get()
  @RequirePermission("expense.view")
  @ApiExpenseDraftErrors()
  @ApiOperation({
    summary: "List expenses",
    description:
      "One page of the society's expenses, newest first (expense_date, then id descending), with a base64 cursor for the next page. Supports categoryId, status, dateFrom, dateTo, amountPaiseMin, amountPaiseMax, createdBy and full-text `q` over title, description and vendor. Unknown parameters and unknown sort keys are refused rather than ignored.",
  })
  @ApiQuery({ name: "categoryId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "dateFrom", required: false })
  @ApiQuery({ name: "dateTo", required: false })
  @ApiQuery({ name: "amountPaiseMin", required: false })
  @ApiQuery({ name: "amountPaiseMax", required: false })
  @ApiQuery({ name: "createdBy", required: false })
  @ApiQuery({ name: "q", required: false })
  @ApiQuery({ name: "cursor", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiOkResponse({
    description: "One page of expenses, with `nextCursor` and `hasMore`.",
    schema: envelopeSchemaOf(expenseListResponseSchema),
  })
  async list(
    @Ctx() context: RequestCtx,
    @Query(new ZodPipe(listExpensesQuerySchema))
    query: ListExpensesQueryPayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const result = await this.listExpenses.list(
      asUserId(userId),
      society.id,
      query,
    );
    return expenseListToDto(result);
  }

  /**
   * Pricing a split for a selector — T064's stateless preview, unchanged.
   *
   * `200` rather than `201`: nothing is created. The response is the PRD's own
   * preview shape — total, participant count, allocations with flat labels and
   * weights, residual and warnings — plus the flagged `unassigned` list T063
   * introduced, so a flat nobody can be billed through is visible to the treasurer's
   * queue instead of missing from the table.
   */
  @Post("preview-split")
  @RequirePermission("expense.create")
  @HttpCode(HttpStatus.OK)
  @ApiExpensePreviewErrors()
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

  /**
   * One expense by id — draft or otherwise.
   *
   * A cross-society or unknown id answers `404`, never `403`: the read is scoped by
   * both ids under the caller's own RLS identity, so the two cases are the same
   * invisibility and a caller cannot enumerate another tenant's expense ids (PRD
   * T041).
   */
  @Get(":expenseId")
  @RequirePermission("expense.view")
  @ApiExpenseDraftErrors()
  @ApiOperation({
    summary: "Get an expense",
    description:
      "One expense of the society named in X-Society-Id, whatever its status — residents may inspect any expense and its bill by design. Cross-society or unknown ids answer 404 rather than 403.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description: "The expense.",
    schema: envelopeSchemaOf(expenseResponseSchema),
  })
  async get(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const record = await this.getExpense.get(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
    );
    return expenseResponseToDto(record);
  }

  /**
   * Edit a draft or pending expense — PRD §3.5's "freely editable while draft or
   * pending_approval".
   *
   * `expectedVersion` is required: the write is one atomic statement keyed on it
   * (`WHERE version = expectedVersion AND status IN ('draft','pending_approval')`),
   * and a caller that lost the race receives `409 VERSION_MISMATCH` carrying the
   * row's current version. An absent field is left unchanged and an explicit `null`
   * clears a nullable one. A published or void expense is refused — its door is
   * T068's recalculation and T069's void.
   */
  @Patch(":expenseId")
  @RequirePermission("expense.void")
  @ApiExpenseDraftErrors()
  @ApiOperation({
    summary: "Edit an expense",
    description:
      "Admin, Treasurer, or a Committee Member editing their own draft. Requires `expectedVersion`; a stale version answers 409 VERSION_MISMATCH with the current version in `details`. Only draft and pending_approval expenses are editable. An omitted field is unchanged; `null` clears a nullable field. Crossing the society's approval threshold while editing promotes a draft to pending_approval for Admin/Treasurer callers.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description: "The updated expense.",
    schema: envelopeSchemaOf(expenseResponseSchema),
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(updateExpenseSchema)) body: UpdateExpensePayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const record = await this.updateExpense.update(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      body,
    );
    return expenseResponseToDto(record);
  }

  /**
   * Hard-delete a draft — creator only.
   *
   * `204` and no body: the row is gone from every read path, and any representation
   * returned here would have to bypass the very absence that makes the delete
   * meaningful. The database's `expense_draft_delete()` enforces creator, draft-ness
   * and the absence of splits, so a stale client cannot delete anything the rules
   * refuse.
   */
  @Delete(":expenseId")
  @RequirePermission("expense.void")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiExpenseDraftErrors()
  @ApiOperation({
    summary: "Delete a draft expense",
    description:
      "Hard-deletes one draft, by its creator only. A published expense is voided rather than deleted; a pending_approval expense, an expense with splits, or one the caller did not create is refused. There is no soft delete.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiNoContentResponse({
    description: "Deleted. The expense is gone from every read path.",
  })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    await this.deleteDraft.delete(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
    );
  }
}
