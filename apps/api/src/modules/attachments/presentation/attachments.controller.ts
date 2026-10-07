import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  completeAttachmentUploadResponseSchema,
  completeAttachmentUploadSchema,
  presignAttachmentUploadResponseSchema,
  presignAttachmentUploadSchema,
} from "@ses/contracts";
import type {
  CompleteAttachmentUploadPayload,
  PresignAttachmentUploadPayload,
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
import {
  envelopeSchemaOf,
  errorEnvelopeJsonSchema,
} from "../../../common/swagger/zod-openapi";
import { CompleteUploadUseCase } from "../application/use-cases/complete-upload.use-case";
import { DeleteAttachmentUseCase } from "../application/use-cases/delete-attachment.use-case";
import { PresignUploadUseCase } from "../application/use-cases/presign-upload.use-case";
import { completeUploadToDto, presignUploadToDto } from "./attachment.mapper";
import { ApiAttachmentErrors, ATTACHMENT_EXTRA_STATUS_COPY } from "./openapi";

/**
 * Attachment endpoints — Roadmap T071, ADR-0012 D4.
 *
 * ```text
 *   POST   /v1/expenses/:expenseId/attachments   -> 201 { attachmentId, uploadUrl, storageKey, expiresAt, requiredHeaders }
 *   POST   /v1/attachments/:attachmentId/complete -> 200 { status: 'processing' }
 *   DELETE /v1/attachments/:attachmentId         -> 204
 * ```
 *
 * ## Why two nouns, and why the upload route is nested
 *
 * The upload route is expense-scoped because the only live `entity_type` in T071 is
 * `expense`: the permission check, the resource narrowing and the SAD §10.3 key
 * layout all need the expense, so taking it from the path keeps **one**
 * authorization path instead of a body field that must be re-validated against the
 * society header (ADR-0012 D4). Completion and deletion are flat because an
 * attachment id is unique across the tenant — the caller's own membership decides
 * the society, and the use case re-reads the parent from the row rather than
 * trusting anything in the URL.
 *
 * PRD §8.2's `POST /expenses/:eid/attachments` and `DELETE /attachments/:aid` are
 * both honoured exactly. SAD §10.1's flat `POST /attachments/presign
 * {entityType, entityId, …}` body is **not** shipped — it is the generic form a
 * later multi-entity task can add as an alias over the same use case.
 *
 * ## No list route and no download route
 *
 * ADR-0012 D4, and the reason is worth repeating where a reader looks for the
 * missing route: the consumers that need them (T073's expense detail, T076's capture
 * flow, T132's OCR) need the presign/complete/delete trio first, and a route invented
 * before its screen exists would be a route nobody asked for behind a permission
 * nobody chose. `presignDownload` ships on the storage port with no HTTP surface.
 *
 * ## The controller decides nothing
 *
 * It parses input through the contract's own schemas, reads the actor and the
 * society from the guard's resolution (never re-reading the header), calls one use
 * case and maps its result. Every rule — who may upload, which types are bills, the
 * plan quota, the size the signature pins, whether the stored bytes are what was
 * declared — lives in the use cases, `@ses/domain` and the storage adapter.
 *
 * ## Both path parameters are validated as UUIDs before any query runs
 *
 * A non-UUID would reach Postgres as `$1::uuid` and fail with a `22P02` the
 * classifier can only report as `unknown`, turning a client bug into a 500 — the
 * same argument `expenses.controller.ts` records.
 */

const expenseIdParam = z.uuid();
const attachmentIdParam = z.uuid();

@ApiTags("attachments")
@ApiSocietyContext()
@Controller()
@ApiAttachmentErrors()
export class AttachmentsController {
  constructor(
    private readonly presignUpload: PresignUploadUseCase,
    private readonly completeUpload: CompleteUploadUseCase,
    private readonly deleteAttachment: DeleteAttachmentUseCase,
  ) {}

  /**
   * Reserve an upload and mint its presigned PUT.
   *
   * `201` with the URL, its expiry and the headers the signature expects. The row is
   * created **before** the URL is issued — that ordering is the quota's enforcement
   * (ADR-0012 D2) — and the URL's signature pins the exact byte count the caller
   * declared, so a different payload is refused by the object store itself
   * (`403 SignatureDoesNotMatch`, or `411` if the length is omitted) with no object
   * created. The client must therefore send the `Content-Length` and `Content-Type`
   * returned in `requiredHeaders`.
   *
   * Bytes never pass through this API (SAD §10.1): the device writes straight to the
   * store, which is why nothing here streams and why the response is a credential
   * rather than a body.
   *
   * The action is `expense.create` narrowed against the **stored** expense, so a
   * Committee Member reaches their own draft and nobody else's — and a `published`
   * or `pending_approval` expense is not a draft, which is the stricter reading the
   * matrix's 🟡 cell requires. A `void` expense refuses everybody.
   */
  @Post("expenses/:expenseId/attachments")
  @RequirePermission("expense.create")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Reserve an attachment upload",
    description:
      "Admin, Treasurer, or a Committee Member on their own draft. Creates the attachment row as an outstanding reservation, checks the society's plan quota under a society-level lock, and returns a presigned PUT whose signature pins the exact `sizeBytes` you declared for 900 seconds, together with the `Content-Length`/`Content-Type` headers the signature expects. Accepted types: image/jpeg, image/png, image/heic, application/pdf. Maximum 10 MB. A `void` expense cannot take new bills. Bytes never pass through this API.",
  })
  @ApiParam({ name: "expenseId", description: "Expense UUID." })
  @ApiResponse({
    status: 402,
    description: ATTACHMENT_EXTRA_STATUS_COPY.planLimit,
    schema: errorEnvelopeJsonSchema(),
  })
  @ApiCreatedResponse({
    description:
      "The reservation: the attachment id, the presigned upload URL, the storage key it will occupy, when the URL expires, and the headers to send with the PUT.",
    schema: envelopeSchemaOf(presignAttachmentUploadResponseSchema),
  })
  async presign(
    @Ctx() context: RequestCtx,
    @Param("expenseId", new ZodPipe(expenseIdParam)) expenseId: string,
    @Body(new ZodPipe(presignAttachmentUploadSchema))
    body: PresignAttachmentUploadPayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);

    const result = await this.presignUpload.presign(
      asUserId(userId),
      society.id,
      asExpenseId(expenseId),
      body,
    );
    return presignUploadToDto(result);
  }

  /**
   * Verify a finished upload and stamp it complete.
   *
   * `200` with `{ status: 'processing' }` — and the word matters. The object has
   * been verified against the reservation (length, SHA-256 over the stored bytes, and
   * magic number against the declared type), the row is complete, and **nothing has
   * been scanned**: no scanner exists in T071, so nothing writes `clean` and the
   * serving gate stays inert (ADR-0012 D3). The response deliberately says neither
   * `clean` nor `ready`.
   *
   * The checksum in the body must be the one the reservation was made with, checked
   * against the row before any bytes are read — a mismatch is a `422` naming
   * `checksum` with no storage traffic at all. The digest the *object* must satisfy
   * is always the row's, recomputed here from the stored bytes; an `ETag` is never
   * used as a checksum (it is an MD5 for a single-part upload and something else for
   * a multipart one).
   *
   * Replaying a successful completion is a `200` no-op, not a `409`: a client whose
   * connection dropped after the server committed cannot tell a lost response from a
   * lost request, so refusing it would leave a successful upload unreportable.
   */
  @Post("attachments/:attachmentId/complete")
  @RequirePermission("expense.create")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Complete an attachment upload",
    description:
      "Verifies the stored object against the reservation — it exists, its length equals the reserved `sizeBytes`, its SHA-256 equals the reserved checksum, and its magic number matches the reserved MIME type — then stamps `completed_at`. The MIME type is never inferred from the filename: a `.jpg` whose bytes are a PDF is refused with `422` and `code: CONTENT_MISMATCH`. The file is not virus-scanned (no scanner exists in T071) so the answer is `processing`, never `clean`. Replaying a completed upload answers `200` and writes nothing.",
  })
  @ApiParam({ name: "attachmentId", description: "Attachment UUID." })
  @ApiResponse({
    status: 422,
    description: ATTACHMENT_EXTRA_STATUS_COPY.contentMismatch,
    schema: errorEnvelopeJsonSchema(),
  })
  @ApiOkResponse({
    description:
      "The upload is verified and recorded. `processing` — not `clean`: the file has not been virus-scanned and is not served without a time-limited URL.",
    schema: envelopeSchemaOf(completeAttachmentUploadResponseSchema),
  })
  async complete(
    @Ctx() context: RequestCtx,
    @Param("attachmentId", new ZodPipe(attachmentIdParam)) attachmentId: string,
    @Body(new ZodPipe(completeAttachmentUploadSchema))
    body: CompleteAttachmentUploadPayload,
  ) {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);

    const result = await this.completeUpload.complete(
      asUserId(userId),
      society.id,
      attachmentId,
      body,
    );
    return completeUploadToDto(result);
  }

  /**
   * Delete one attachment.
   *
   * `204` and no body: the row is gone from every read path, and any representation
   * returned here would have to bypass the very absence that makes the delete
   * meaningful — the same argument the draft-delete route makes.
   *
   * Permitted to the **uploader** or to a caller authorized to manage the expense
   * (ADR-0012 D6.4), checked with `canOnResource` against the persisted expense and
   * never with an inline role string.
   *
   * The **row is removed first and the object second** (D6.3). If the object removal
   * fails after the row is gone, the row is *not* recreated, no failure is reported —
   * the attachment is already unreachable through every application path — and a
   * structured line records the key for the abandoned-object sweep, which the ADR
   * lists as a required obligation. A stranded object is invisible; a stranded row
   * pointing at missing bytes is a broken live reference, which is worse.
   *
   * Nothing financial happens: no split, due, balance, `member_balances` column,
   * `expense_revisions` row or approval stamp is touched. Deleting a bill does not
   * invalidate a T070 approval (D6.2).
   */
  @Delete("attachments/:attachmentId")
  @RequirePermission("expense.void")
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoEnvelope()
  @ApiOperation({
    summary: "Delete an attachment",
    description:
      "The uploader, or an Admin/Treasurer, or a Committee Member on their own unpublished expense. Removes the attachment row and then the stored object: if the object deletion fails the row stays deleted, the attachment becomes unreachable through the API, and the object is recorded for the abandoned-object sweep. Does not change any financial row, does not create a revision, and does not clear an approval.",
  })
  @ApiParam({ name: "attachmentId", description: "Attachment UUID." })
  @ApiNoContentResponse({
    description:
      "Deleted. The attachment is gone from every read path. A storage object whose removal failed is swept later and is never reachable through the API.",
  })
  async remove(
    @Ctx() context: RequestCtx,
    @Param("attachmentId", new ZodPipe(attachmentIdParam)) attachmentId: string,
  ): Promise<void> {
    const { userId } = requireActor(context);
    const { society } = requireSociety(context);
    await this.deleteAttachment.remove(
      asUserId(userId),
      society.id,
      attachmentId,
    );
  }
}
