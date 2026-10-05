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
  Res,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiHeader,
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
  expenseRevisionsResponseSchema,
  idempotencyKeySchema,
  listExpensesQuerySchema,
  previewSplitRequestSchema,
  previewSplitResponseSchema,
  publishExpenseSchema,
  publishExpenseResponseSchema,
  recalculateExpenseResponseSchema,
  updateExpenseSchema,
} from "@ses/contracts";
import type {
  CreateExpensePayload,
  IdempotencyKeyPayload,
  ListExpensesQueryPayload,
  PreviewSplitRequestPayload,
  PublishExpensePayload,
  UpdateExpensePayload,
} from "@ses/contracts";
import { asExpenseId, asUserId } from "@ses/domain";
import { z } from "zod";

import { ApiSocietyContext } from "../../../common/authorization/api-society-context.decorator";
import { writeResponseHeader } from "../../../common/http/http-access";
import {
  Ctx,
  requireActor,
  requireSociety,
  type RequestCtx,
} from "../../../common/decorators/ctx.decorator";
import { HeaderParam } from "../../../common/decorators/header-param.decorator";
import { NoEnvelope } from "../../../common/decorators/no-envelope.decorator";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { ZodPipe } from "../../../common/pipes/zod.pipe";
import { envelopeSchemaOf } from "../../../common/swagger/zod-openapi";
import { CreateExpenseUseCase } from "../application/use-cases/create-expense.use-case";
import { DeleteDraftUseCase } from "../application/use-cases/delete-draft.use-case";
import { GetExpenseUseCase } from "../application/use-cases/get-expense.use-case";
import { ListExpensesUseCase } from "../application/use-cases/list-expenses.use-case";
import { ListRevisionsUseCase } from "../application/use-cases/list-revisions.use-case";
import { PreviewSplitUseCase } from "../application/use-cases/preview-split.use-case";
import { PublishExpenseUseCase } from "../application/use-cases/publish-expense.use-case";
import { UpdateExpenseUseCase } from "../application/use-cases/update-expense.use-case";
import {
  expenseListToDto,
  expensePublicationToDto,
  expenseResponseToDto,
  expenseRevisionsToDto,
  recalculateExpenseToDto,
} from "./expense.mapper";
import { expenseSplitPreviewToDto } from "./expense-preview.mapper";
import {
  ApiExpenseDraftErrors,
  ApiExpensePreviewErrors,
  ApiExpensePublishErrors,
  ApiExpenseRecalculateErrors,
  ApiExpenseRevisionErrors,
} from "./openapi";

/**
 * Expense endpoints — Roadmap T064's preview, T065's draft lifecycle and T066's
 * publication.
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
    private readonly publishExpense: PublishExpenseUseCase,
    private readonly listRevisions: ListRevisionsUseCase,
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
   * Edit an expense — PRD §3.5's "freely editable while draft" **and** T068's
   * recalculation for a published one.
   *
   * One address, two doors, and the stored row decides which: a draft or
   * `pending_approval` expense is edited as a draft (`{ expense }`), while a
   * **published** expense is revised — participants re-resolved, the split
   * re-priced, the dues moved and one revision recorded, all in one transaction —
   * and answers `{ expense, recalculation }` with the diff measured over the rows
   * that committed (ADR-0009).
   *
   * `expectedVersion` is required on both doors, because both are writes keyed on
   * it: a caller that lost the race receives `409 VERSION_MISMATCH` carrying the
   * row's current version. On the published door the optimistic lock is the **only**
   * lock — there is no idempotency record, because a retry with a stale version is
   * refused rather than replayed and the reload-and-retry is unambiguous.
   *
   * An omitted field is left unchanged and an explicit `null` clears a nullable one.
   * Four fields are immutable after publication — `expenseDate`, `categoryId`,
   * `paymentSource`, `paidByMemberId` — and are refused with a field error rather
   * than dropped, and `changeNote` (T068's operator note, stored on the revision) is
   * refused on a draft edit, which has no revision to annotate. A `void` expense is
   * refused on both doors: T069 owns reversal by voiding.
   */
  @Patch(":expenseId")
  @RequirePermission("expense.void")
  @ApiExpenseDraftErrors()
  @ApiExpenseRecalculateErrors()
  @ApiOperation({
    summary: "Edit an expense",
    description:
      "Admin, Treasurer, or a Committee Member editing their own draft. Requires `expectedVersion`; a stale version answers 409 VERSION_MISMATCH with the current version in `details`. A draft or pending_approval expense is edited (an omitted field is unchanged; `null` clears a nullable field; crossing the approval threshold promotes a draft to pending_approval for Admin/Treasurer callers) and answers `{ expense }`. A **published** expense is recalculated by Admin/Treasurer: the participants are re-resolved and the split re-priced from the persisted row, the dues move through their lifecycle without deleting one, a BEFORE snapshot is recorded, and the response carries the resulting diff. A revision that would leave an obligation below a verified payment is refused whole with 409 DUE_PAID_EXCEEDS_NEW_AMOUNT.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The updated expense. A draft or pending_approval edit answers `{ expense }`; a published edit answers `{ expense, recalculation }`, where `recalculation` reports how many dues were updated, superseded and created, the signed total delta and the affected member count — all measured over the rows the revision committed.",
    schema: {
      oneOf: [
        envelopeSchemaOf(expenseResponseSchema),
        envelopeSchemaOf(recalculateExpenseResponseSchema),
      ],
    },
  })
  async update(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(updateExpenseSchema)) body: UpdateExpensePayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const outcome = await this.updateExpense.update(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      body,
    );

    // The one place the two doors differ on the wire: a revision reports what it
    // changed, a draft edit has nothing to report. The expense DTO is the same
    // mapping either way.
    return outcome.recalculation === null
      ? expenseResponseToDto(outcome.expense)
      : recalculateExpenseToDto(outcome.recalculation);
  }

  /**
   * The revision history of one expense — PRD §3.5.3's "edited" chip, tapped through.
   *
   * Oldest first, so the history reads forward from the state the first revision
   * replaced, and every entry carries the **pre-edit** version plus the complete
   * BEFORE snapshot (ADR-0009 §17) — the configuration and the authoritative splits
   * that existed before the edit, which is what makes a bill reconstructible rather
   * than merely annotated.
   *
   * Readable by every role that can see the expense (`expense.view`, every role but
   * Guest) and scoped by the same `X-Society-Id` and RLS identity as the expense
   * itself: another tenant's history is structurally invisible, and an id the caller
   * cannot see answers 404. An expense that has never been revised answers an empty
   * list, not a 404 — it has a history, and that history is empty.
   */
  @Get(":expenseId/revisions")
  @RequirePermission("expense.view")
  @ApiExpenseRevisionErrors()
  @ApiOperation({
    summary: "List an expense's revisions",
    description:
      "Every revision of one expense, oldest first. Each entry carries the pre-edit `version` and the complete BEFORE snapshot the edit replaced — the expense's allocation-driving configuration and its authoritative splits — plus the editor and their optional note. Readable by every member who can see the expense; append-only, with no update or delete route.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The revision history, oldest first. An expense that has never been revised answers `{ revisions: [] }`.",
    schema: envelopeSchemaOf(expenseRevisionsResponseSchema),
  })
  async revisions(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const revisions = await this.listRevisions.list(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
    );
    return expenseRevisionsToDto(revisions);
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

  /**
   * Publish a draft or a pending expense — the PRD's bill becomes real.
   *
   * `200` rather than `201`: nothing is created at a new address, and a retry has to
   * be able to answer the same way. The path is the PRD's (`POST
   * /expenses/:eid/publish` under the global `/v1`), the action is the matrix's
   * `expense.publish` (Admin or Treasurer — a Committee Member's draft-only cell does
   * not reach it), and the body is one number: the version the caller believed it was
   * publishing. Everything financial — amount, strategy, config, selector,
   * participants, allocations — is recomputed server-side from the persisted row and
   * the current society state, so a stale preview cannot be replayed as an
   * authorisation.
   *
   * `Idempotency-Key` is **required** (SAD §7.7: mandatory on every POST that creates
   * money movement). A key that already published this request's expense answers the
   * stored response verbatim with `Idempotency-Replayed: true` and writes nothing; a
   * key used for a *different* request is `409 IDEMPOTENCY_KEY_REUSE`.
   *
   * The refusal this route is most likely to produce in practice is the flagged-flat
   * one: if any resolved, billable flat has nobody to charge (no owner for an
   * owner-only charge, or no member at all), publication is refused with
   * `422 VALIDATION_ERROR` and one `details` entry per flat rather than a bill that
   * silently omits it. See `PublishExpenseUseCase` for why that is the only
   * implementable option today.
   */
  @Post(":expenseId/publish")
  @RequirePermission("expense.publish")
  @HttpCode(HttpStatus.OK)
  @ApiExpensePublishErrors()
  @ApiOperation({
    summary: "Publish an expense",
    description:
      "Admin or Treasurer. Recomputes the split from the persisted expense and the current participant roster — a preview is never trusted as input — and writes the splits, the transition and the idempotency record in one transaction. Requires the current `expectedVersion` and an `Idempotency-Key`. Refused while any billable flat has nobody to charge, rather than publishing a bill that omits it.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "SAD §7.7's mandatory retry key for money-moving POSTs, 8–128 characters. Replaying a key returns the stored response with `Idempotency-Replayed: true` and publishes nothing.",
  })
  @ApiOkResponse({
    description:
      "The published expense (status `published`, with `publishedAt` and the version the database stamped) plus the split summary measured over the rows that committed.",
    schema: envelopeSchemaOf(publishExpenseResponseSchema),
    headers: {
      "Idempotency-Replayed": {
        description:
          "`true` when this response is the stored one from an earlier request with the same key; absent on a fresh publication.",
        schema: { type: "string" },
      },
    },
  })
  async publish(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @HeaderParam("idempotency-key", new ZodPipe(idempotencyKeySchema))
    idempotencyKey: IdempotencyKeyPayload,
    @Body(new ZodPipe(publishExpenseSchema)) body: PublishExpensePayload,
    // `passthrough: true` keeps Nest's serialization and the envelope interceptor in
    // charge of the body; this controller only ever writes one header on it.
    @Res({ passthrough: true }) response: unknown,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);

    const publication = await this.publishExpense.publish(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      { expectedVersion: body.expectedVersion, idempotencyKey },
    );

    // The one header, and only on a replay: a client that lost the first response
    // needs to know this body is stored rather than freshly computed, and the body
    // itself is deliberately identical either way. Written through
    // `writeResponseHeader`, which tries Node's `setHeader` and falls back to
    // Fastify's `header` — the adapter this API actually runs on exposes only the
    // latter, so `response.setHeader(...)` here was a 500 on every replay.
    if (publication.replayed) {
      writeResponseHeader(response, "Idempotency-Replayed", "true");
    }

    return expensePublicationToDto(publication);
  }
}
