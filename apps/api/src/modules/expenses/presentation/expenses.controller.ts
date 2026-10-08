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
  Put,
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
  addExpenseCommentSchema,
  approveExpenseSchema,
  approveExpenseResponseSchema,
  createExpenseSchema,
  expenseCommentResponseSchema,
  expenseCommentsResponseSchema,
  expenseGstResponseSchema,
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
  rejectExpenseSchema,
  rejectExpenseResponseSchema,
  updateExpenseSchema,
  upsertExpenseGstSchema,
  voidExpenseSchema,
  voidExpenseResponseSchema,
} from "@ses/contracts";
import type {
  AddExpenseCommentPayload,
  ApproveExpensePayload,
  CreateExpensePayload,
  IdempotencyKeyPayload,
  ListExpensesQueryPayload,
  PreviewSplitRequestPayload,
  PublishExpensePayload,
  RejectExpensePayload,
  UpdateExpensePayload,
  UpsertExpenseGstPayload,
  VoidExpensePayload,
} from "@ses/contracts";
import { asExpenseCommentId, asExpenseId, asUserId } from "@ses/domain";
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
import { AddCommentUseCase } from "../application/use-cases/add-comment.use-case";
import { ApproveExpenseUseCase } from "../application/use-cases/approve-expense.use-case";
import { CreateExpenseUseCase } from "../application/use-cases/create-expense.use-case";
import { DeleteCommentUseCase } from "../application/use-cases/delete-comment.use-case";
import { DeleteDraftUseCase } from "../application/use-cases/delete-draft.use-case";
import { GetExpenseUseCase } from "../application/use-cases/get-expense.use-case";
import { ListCommentsUseCase } from "../application/use-cases/list-comments.use-case";
import { ListExpensesUseCase } from "../application/use-cases/list-expenses.use-case";
import { ListRevisionsUseCase } from "../application/use-cases/list-revisions.use-case";
import { PreviewSplitUseCase } from "../application/use-cases/preview-split.use-case";
import { PublishExpenseUseCase } from "../application/use-cases/publish-expense.use-case";
import { RejectExpenseUseCase } from "../application/use-cases/reject-expense.use-case";
import { UpdateExpenseUseCase } from "../application/use-cases/update-expense.use-case";
import { UpsertGstDetailsUseCase } from "../application/use-cases/upsert-gst-details.use-case";
import { VoidExpenseUseCase } from "../application/use-cases/void-expense.use-case";
import {
  expenseCommentResponseToDto,
  expenseCommentsToDto,
  expenseGstResponseToDto,
  expenseListToDto,
  expensePublicationToDto,
  expenseResponseToDto,
  expenseRevisionsToDto,
  recalculateExpenseToDto,
  voidExpenseToDto,
} from "./expense.mapper";
import { expenseSplitPreviewToDto } from "./expense-preview.mapper";
import {
  ApiExpenseApproveErrors,
  ApiExpenseCommentErrors,
  ApiExpenseDraftErrors,
  ApiExpenseGstErrors,
  ApiExpensePreviewErrors,
  ApiExpensePublishErrors,
  ApiExpenseRecalculateErrors,
  ApiExpenseRejectErrors,
  ApiExpenseRevisionErrors,
  ApiExpenseVoidErrors,
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
const commentIdParam = z.uuid();

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
    private readonly voidExpense: VoidExpenseUseCase,
    private readonly approveExpense: ApproveExpenseUseCase,
    private readonly rejectExpense: RejectExpenseUseCase,
    private readonly upsertGstDetails: UpsertGstDetailsUseCase,
    private readonly listCommentsUseCase: ListCommentsUseCase,
    private readonly addComment: AddCommentUseCase,
    private readonly deleteComment: DeleteCommentUseCase,
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

  /**
   * Void a published expense — PRD §3.5's reversal, completed by T069.
   *
   * `200` rather than `201` or `204`: nothing is created and the caller needs the
   * voided row back (its `voidedAt`, `voidedBy`, `voidReason` and bumped `version`)
   * together with what the reversal did to the balances. The path is the PRD's
   * (`POST /expenses/:eid/void` under the global `/v1`), and the action is the
   * matrix's `expense.void` — Admin or Treasurer, because a Committee Member's
   * grant on that cell is own-drafts-only and a draft is not voidable.
   *
   * The body is the version the caller read plus the mandatory reason; everything
   * financial — which dues exist, what was paid against them, the exact balance
   * deltas and the credit the payments become — is computed server-side from the
   * persisted rows inside one `expense_void()` transaction (ADR-0010). No
   * `Idempotency-Key`: a void is not a retryable money-moving POST, and a second
   * attempt meets a terminal state with `409 INVALID_TRANSITION` rather than being
   * replayed as a success.
   *
   * The bill's splits and its historical dues are **not** deleted — a void reverses
   * obligations, it does not burn history (ADR-0010 Decision 1) — and the
   * `summary` reports the reversal: how many dues were superseded, how much paid
   * money became advance credit, and how many members' balances moved.
   */
  @Post(":expenseId/void")
  @RequirePermission("expense.void")
  @HttpCode(HttpStatus.OK)
  @ApiExpenseDraftErrors()
  @ApiExpenseVoidErrors()
  @ApiOperation({
    summary: "Void an expense",
    description:
      "Admin or Treasurer. Reverses a published expense in one transaction: every current principal due is superseded (its amount, paid history and split link preserved, its split untouched), and each member's balance moves by the exact deltas — total_due minus the obligation, total_paid minus what had been applied, advance_paise plus that same amount, outstanding minus the obligation. The paid amount becomes available member credit; it is not lost, and no payment or allocation row is invented. Requires the current `expectedVersion` and a reason of at least 10 characters. A second void is refused 409 INVALID_TRANSITION — void is terminal.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The voided expense (status `void`, with `voidedAt`, `voidedBy`, `voidReason` and the version the database stamped) plus the reversal summary: dues superseded, credits issued in paise and the affected member count — all measured over the rows the transaction committed.",
    schema: envelopeSchemaOf(voidExpenseResponseSchema),
  })
  async void(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(voidExpenseSchema)) body: VoidExpensePayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const voided = await this.voidExpense.void(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      { expectedVersion: body.expectedVersion, reason: body.reason },
    );
    return voidExpenseToDto(voided);
  }

  /**
   * Approve a pending expense — the Admin's decision, completed by T070.
   *
   * `200` rather than `201`: nothing is created, and the caller needs the approved
   * row back (its `approvedBy`, `approvedAt` and bumped `version`) — which is what
   * makes "approved, awaiting publication" a state a client can render without a
   * second read. The path is the product decision's (`POST /expenses/:eid/approve`
   * under the global `/v1`) and the action is the matrix's `expense.approve` — a
   * full Admin cell, so a Treasurer or Committee Member is refused by role.
   *
   * The whole payload is the version the Admin read. Everything else is the row's:
   * the approver is the caller's own membership, the instant is the database's
   * clock, and the *content* the approval applies to is the version the optimistic
   * lock pins. No `Idempotency-Key`: an approval is not a retryable money-moving
   * POST and a second attempt meets `409` rather than being replayed.
   *
   * Approval is **not** publication: the status stays `pending_approval`, no split
   * is priced and no due is created. `POST /publish` remains the one financial path,
   * and it re-evaluates the amount against the *current* threshold before writing
   * anything (ADR-0011 D4).
   */
  @Post(":expenseId/approve")
  @RequirePermission("expense.approve")
  @HttpCode(HttpStatus.OK)
  @ApiExpenseApproveErrors()
  @ApiOperation({
    summary: "Approve an expense",
    description:
      "Admin only. Records the approval of a pending_approval expense: `approvedBy`/`approvedAt` are stamped and any stale rejection metadata is cleared, all in one transaction with the row locked. The status deliberately stays `pending_approval` — approval is a decision, not a publication — and publishing remains a separate Admin/Treasurer act. Requires the current `expectedVersion`. An Admin may approve their own expense.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The approved expense: still `pending_approval`, with `approvedBy`, `approvedAt` and the version the database stamped. No financial row was written.",
    schema: envelopeSchemaOf(approveExpenseResponseSchema),
  })
  async approve(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(approveExpenseSchema)) body: ApproveExpensePayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const approved = await this.approveExpense.approve(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      { expectedVersion: body.expectedVersion },
    );
    return expenseResponseToDto(approved);
  }

  /**
   * Reject a pending expense — the Admin's other decision, completed by T070.
   *
   * `200` and the rejected row, for the same reasons the approve route answers with
   * its own: nothing is created and the caller needs the authoritative state — here
   * `status: "draft"` with `rejectedBy`/`rejectedAt`/`rejectionReason` set — to
   * render the outcome. The path is the product decision's (`POST
   * /expenses/:eid/reject`), the action is the same Admin cell `expense.approve`,
   * and the body is the version plus the mandatory reason.
   *
   * Rejection is `pending_approval → draft` (ADR-0011 D1): there is no `rejected`
   * status, because a rejected expense is one the creator corrects and resubmits. The
   * three rejection stamps are the durable record of the decision, and a
   * resubmission clears them. Nothing financial happens — no split, no due, no
   * balance, no event — and the publisher's one path through `expense_publish()` is
   * untouched.
   */
  @Post(":expenseId/reject")
  @RequirePermission("expense.approve")
  @HttpCode(HttpStatus.OK)
  @ApiExpenseRejectErrors()
  @ApiOperation({
    summary: "Reject an expense",
    description:
      "Admin only. Returns a pending_approval expense to `draft` with a mandatory reason of at least 10 characters, recording `rejectedBy`/`rejectedAt`/`rejectionReason` and clearing the approval in one transaction with the row locked. The creator may then edit and resubmit, which clears the rejection stamps. Requires the current `expectedVersion`. No financial row is written.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The rejected expense: status `draft`, with `rejectedBy`, `rejectedAt`, `rejectionReason` set, the approval cleared and the version the database stamped. No financial row was written.",
    schema: envelopeSchemaOf(rejectExpenseResponseSchema),
  })
  async reject(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(rejectExpenseSchema)) body: RejectExpensePayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const rejected = await this.rejectExpense.reject(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      { expectedVersion: body.expectedVersion, reason: body.reason },
    );
    return expenseResponseToDto(rejected);
  }

  /**
   * Record or replace an expense's GST details — PRD §3.5.3, completed by T072.
   *
   * `PUT` and not `PATCH`: the body is a full statement of the GST record, so the
   * route is idempotent and an omitted optional field clears its value rather than
   * leaving the stored one. The action is the matrix's `expense.create` — no
   * `gst.*` capability exists (D3) — so Admin and Treasurer may write any non-void
   * expense and a Committee Member only a draft, which is exactly the database
   * policy's own rule.
   *
   * `200` rather than `201`: the row's identity is its expense and there is no new
   * address to return. The response carries the stored GST record **and** a
   * `warnings` array: PRD §3.5.3 says a tax-total mismatch warns rather than
   * blocks, so a `TAX_TOTAL_MISMATCH` travels beside a successful write, never as
   * an error envelope. A `void` expense is refused `409 INVALID_TRANSITION` before
   * any row is written (D4), and the GSTIN is checksum-validated at the contract.
   *
   * Recording GST details does **not** invalidate a T070 approval (D5): the write
   * names only `expense_gst_details`, so `approvedBy`/`approvedAt` survive and an
   * approved expense is not silently sent back for a fresh decision.
   */
  @Put(":expenseId/gst")
  @RequirePermission("expense.create")
  @HttpCode(HttpStatus.OK)
  @ApiExpenseGstErrors()
  @ApiOperation({
    summary: "Record an expense's GST details",
    description:
      "Admin, Treasurer, or the Committee Member who owns a draft. Replaces the whole GST record (a PUT, so an omitted optional field is cleared). The GSTIN is validated structurally and by its check digit, and an invoice that carries both IGST and CGST/SGST is refused. A void expense cannot be changed. `taxable_value + taxes` that does not equal the amount is returned as a non-blocking `TAX_TOTAL_MISMATCH` warning, never an error.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The stored GST record plus a `warnings` array. `warnings` is empty when the tax components reconcile with the amount; a `TAX_TOTAL_MISMATCH` entry means the write succeeded but the two do not add up.",
    schema: envelopeSchemaOf(expenseGstResponseSchema),
  })
  async upsertGst(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(upsertExpenseGstSchema)) body: UpsertExpenseGstPayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const outcome = await this.upsertGstDetails.upsert(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      body,
    );
    return expenseGstResponseToDto(outcome);
  }

  /**
   * The discussion stream of one expense — PRD §3.5.3 "Notes", completed by T072.
   *
   * Oldest first, ordered by the database's own per-expense sequence, and readable
   * by every member who can see the expense (`expense.view` — every role but
   * Guest). Deleted comments keep their position in the stream and carry
   * `deleted: true`; their body is `null`. Deliberately not paginated: a comment
   * stream on a single bill is bounded by the conversation, and a cursor here would
   * be complexity no screen needs.
   */
  @Get(":expenseId/comments")
  @RequirePermission("expense.view")
  @ApiExpenseCommentErrors()
  @ApiOperation({
    summary: "List an expense's comments",
    description:
      "Every comment on the expense, oldest first, visible to any member who can see the expense. Soft-deleted comments are returned in place with `deleted: true` and a null `body`; the stored prose is not published.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiOkResponse({
    description:
      "The comment stream, oldest first. An expense with no comments answers `{ comments: [] }`.",
    schema: envelopeSchemaOf(expenseCommentsResponseSchema),
  })
  async listComments(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const comments = await this.listCommentsUseCase.list(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
    );
    return expenseCommentsToDto(comments);
  }

  /**
   * Append one comment — PRD §3.5.3 "Notes", completed by T072.
   *
   * `201` with the appended comment. The author is the caller's own membership
   * (the body carries only the text), the position is the database's, and the
   * stream is flat — there are no replies and no `parent_id` (D1). A Guest is
   * refused by the `expense.view` guard, which is D2's "Guest must not comment"
   * with no extra rule: a role that cannot see the bill has no voice in its
   * discussion.
   */
  @Post(":expenseId/comments")
  @RequirePermission("expense.view")
  @HttpCode(HttpStatus.CREATED)
  @ApiExpenseCommentErrors()
  @ApiOperation({
    summary: "Add a comment to an expense",
    description:
      "Any member who can see the expense. Appends the comment to the flat stream and returns it with the database-assigned `sequence`. There is no reply structure and no edit route.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiCreatedResponse({
    description: "The appended comment.",
    schema: envelopeSchemaOf(expenseCommentResponseSchema),
  })
  async createComment(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(addExpenseCommentSchema)) body: AddExpenseCommentPayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    const comment = await this.addComment.add(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      { body: body.body },
    );
    return expenseCommentResponseToDto(comment);
  }

  /**
   * Soft-delete one comment — PRD §3.5.3's "soft-delete by author or admin", T072.
   *
   * `204` and no body: the comment's prose is gone from every read, and the row
   * that remains is the tombstone (its position in the stream, its author and the
   * deletion metadata). The verb is `DELETE` and the effect is a **soft** delete —
   * no SQL `DELETE` is issued anywhere on this path (D8) — which is the module's
   * existing delete-route convention (`DELETE /expenses/:expenseId` also answers
   * 204).
   *
   * Authorised when the caller wrote the comment **or** holds the Admin-only
   * `expense.approve` capability (D2): a rank-and-file member can remove their own
   * words, an Admin can remove anyone's, and nobody else can. The guard declares
   * `expense.view` only so a Guest is kept out; the real decision is the use case's,
   * and the database's `expense_comment_soft_delete()` enforces the same two facts.
   */
  @Delete(":expenseId/comments/:commentId")
  @RequirePermission("expense.view")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiExpenseCommentErrors()
  @ApiOperation({
    summary: "Delete a comment",
    description:
      "Soft-deletes one comment, by its author or a society Admin. The comment keeps its position in the stream and is returned with `deleted: true` and a null body on subsequent reads; the stored body is never hard-deleted. Idempotent — deleting an already-deleted comment succeeds and changes nothing.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiParam({ name: "commentId", description: "Comment UUID." })
  @ApiNoContentResponse({
    description:
      "Deleted. The comment's body is gone from every read; the tombstone remains in place.",
  })
  async removeComment(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Param("commentId", new ZodPipe(commentIdParam)) commentId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    await this.deleteComment.softDelete(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      asExpenseCommentId(commentId),
    );
  }
}
