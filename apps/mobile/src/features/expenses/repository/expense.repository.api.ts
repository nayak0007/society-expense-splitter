/**
 * `ExpenseRepository` over the Resident 360 API.
 *
 * ## The society is a header, the actor is the token
 *
 * Same as the member and structure adapters: every call sends `X-Society-Id` from the
 * active society store and never names the actor — over HTTP the actor *is* the verified
 * JWT, and forwarding an id would be strictly weaker.
 *
 * ## Responses are parsed, not trusted
 *
 * Each call passes the shared `@ses/contracts` schema to `apiRequest`, so a renamed or
 * added-required field fails loudly at the boundary rather than rendering `undefined`. This
 * is the same rule every other adapter follows (SAD §7.8).
 *
 * ## `null`, not a throw, for an absent expense
 *
 * `findById` folds the API's `404` into `null` — a cross-society or removed expense is an
 * ordinary "not available to you" answer the caller renders as an empty state, exactly as
 * `ApiMemberRepository.findById` does.
 */

import {
  attachmentDownloadUrlSchema,
  completeAttachmentUploadResponseSchema,
  completeAttachmentUploadSchema,
  expenseAttachmentsResponseSchema,
  presignAttachmentUploadResponseSchema,
  presignAttachmentUploadSchema,
  expenseCategoryListResponseSchema,
  expenseCommentsResponseSchema,
  expenseListResponseSchema,
  expenseResponseSchema,
  expenseRevisionsResponseSchema,
  expenseSplitsResponseSchema,
  previewSplitResponseSchema,
  buildingListResponseSchema,
  memberListResponseSchema,
} from '@ses/contracts';
import type {
  CreateExpensePayload,
  ExpenseDto,
  PreviewSplitResponseDto,
  UpdateExpensePayload,
} from '@ses/contracts';

import { apiRequest, isApiError } from '@/lib/api/api-client';

import type {
  AttachmentCompletion,
  AttachmentUploadRequest,
  AttachmentUploadTarget,
  ExpenseAttachmentDownload,
  ExpenseAttachmentView,
  ExpenseCategoryOption,
  ExpenseCommentView,
  ExpenseListQuery,
  ExpensePage,
  ExpensePayerOption,
  ExpenseRepository,
  ExpenseRevisionView,
  ExpenseSplitView,
  ExpenseSummary,
  SplitPreviewRequest,
} from './expense.repository';

/** One expense DTO → the port's summary. Copying fields is deliberate: the wire shape is
 * free to grow, and the view model is only what a screen renders. */
function toSummary(dto: ExpenseDto): ExpenseSummary {
  return {
    id: dto.id,
    societyId: dto.societyId,
    categoryId: dto.categoryId,
    title: dto.title,
    description: dto.description,
    amountPaise: dto.amountPaise,
    expenseDate: dto.expenseDate,
    vendorName: dto.vendorName,
    paymentSource: dto.paymentSource,
    paidByMemberId: dto.paidByMemberId,
    createdBy: dto.createdBy,
    status: dto.status,
    splitStrategy: dto.splitStrategy,
    apartmentBasis: dto.apartmentBasis,
    splitConfig: dto.splitConfig,
    participantSelector: dto.participantSelector,
    version: dto.version,
    publishedAt: dto.publishedAt,
    voidedAt: dto.voidedAt,
    voidReason: dto.voidReason,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/**
 * The list query as a query string.
 *
 * `undefined` and empty strings are omitted rather than sent empty: the contract is
 * `.strict()`, and `status=` is a value it refuses, so an omitted parameter is what makes
 * "no filter" mean no filter. Every value is encoded — a search term is free text, and an
 * `&` in it would otherwise silently change what was asked for.
 */
function listPath(query: ExpenseListQuery): string {
  const parameters: [string, string][] = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    parameters.push([key, String(value)]);
  };

  push('categoryId', query.categoryId);
  push('status', query.status);
  push('dateFrom', query.dateFrom);
  push('dateTo', query.dateTo);
  push('amountPaiseMin', query.amountPaiseMin);
  push('amountPaiseMax', query.amountPaiseMax);
  push('buildingId', query.buildingId);
  push('createdBy', query.createdBy);
  push('q', query.q?.trim());
  push('cursor', query.cursor);
  push('limit', query.limit);

  const search = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return search.length === 0 ? 'expenses' : `expenses?${search}`;
}

export class ApiExpenseRepository implements ExpenseRepository {
  async list(societyId: string, _actor: string, query: ExpenseListQuery): Promise<ExpensePage> {
    const response = await apiRequest('GET', listPath(query), {
      schema: expenseListResponseSchema,
      societyId,
    });
    return {
      expenses: response.expenses.map(toSummary),
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
    };
  }

  async findById(id: string, societyId: string, _actor: string): Promise<ExpenseSummary | null> {
    try {
      const { expense } = await apiRequest('GET', `expenses/${id}`, {
        schema: expenseResponseSchema,
        societyId,
      });
      return toSummary(expense);
    } catch (error: unknown) {
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async listSplits(
    expenseId: string,
    societyId: string,
    _actor: string,
  ): Promise<readonly ExpenseSplitView[]> {
    const { splits } = await apiRequest('GET', `expenses/${expenseId}/splits`, {
      schema: expenseSplitsResponseSchema,
      societyId,
    });
    return splits.map((split) => ({
      id: split.id,
      memberId: split.memberId,
      apartmentId: split.apartmentId,
      amountPaise: split.amountPaise,
      weight: split.weight,
      percent: split.percent,
      assignedReason: split.assignedReason,
      memberName: split.snapshot.memberName ?? null,
      apartmentNumber: split.snapshot.apartmentNumber ?? null,
    }));
  }

  async listRevisions(
    expenseId: string,
    societyId: string,
    _actor: string,
  ): Promise<readonly ExpenseRevisionView[]> {
    const { revisions } = await apiRequest('GET', `expenses/${expenseId}/revisions`, {
      schema: expenseRevisionsResponseSchema,
      societyId,
    });
    return revisions.map((revision) => ({
      id: revision.id,
      version: revision.version,
      changedBy: revision.changedBy,
      changeNote: revision.changeNote,
      createdAt: revision.createdAt,
    }));
  }

  async listComments(
    expenseId: string,
    societyId: string,
    _actor: string,
  ): Promise<readonly ExpenseCommentView[]> {
    const { comments } = await apiRequest('GET', `expenses/${expenseId}/comments`, {
      schema: expenseCommentsResponseSchema,
      societyId,
    });
    return comments.map((comment) => ({
      id: comment.id,
      authorId: comment.authorId,
      body: comment.body,
      deleted: comment.deleted,
      createdAt: comment.createdAt,
    }));
  }

  async listAttachments(
    expenseId: string,
    societyId: string,
    _actor: string,
  ): Promise<readonly ExpenseAttachmentView[]> {
    const { attachments } = await apiRequest('GET', `expenses/${expenseId}/attachments`, {
      schema: expenseAttachmentsResponseSchema,
      societyId,
    });
    return attachments.map((attachment) => ({
      id: attachment.id,
      originalFilename: attachment.originalFilename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      scanStatus: attachment.scanStatus,
      completedAt: attachment.completedAt,
    }));
  }

  async requestDownloadUrl(
    attachmentId: string,
    societyId: string,
    _actor: string,
  ): Promise<ExpenseAttachmentDownload> {
    const { url, expiresAt, filename, mimeType, sizeBytes, scanStatus } = await apiRequest(
      'GET',
      `attachments/${attachmentId}/download`,
      { schema: attachmentDownloadUrlSchema, societyId },
    );
    return { url, expiresAt, filename, mimeType, sizeBytes, scanStatus };
  }

  /**
   * Reserve an upload and get its presigned PUT.
   *
   * The request goes through the contract's own `strictObject` before it is sent, so a
   * unknown field or an out-of-range size is caught here rather than being refused by the
   * API — and the checksum is lower-cased by the same schema the server parses with. The
   * response's `uploadUrl` is treated as an opaque credential: it is passed through and
   * never logged, and only the storage transport ever sees it.
   */
  async requestAttachmentUpload(
    expenseId: string,
    societyId: string,
    _actor: string,
    request: AttachmentUploadRequest,
  ): Promise<AttachmentUploadTarget> {
    const body = presignAttachmentUploadSchema.parse(request);
    const response = await apiRequest('POST', `expenses/${expenseId}/attachments`, {
      schema: presignAttachmentUploadResponseSchema,
      societyId,
      body,
    });
    return {
      attachmentId: response.attachmentId,
      uploadUrl: response.uploadUrl,
      storageKey: response.storageKey,
      expiresAt: response.expiresAt,
      requiredHeaders: response.requiredHeaders,
    };
  }

  /**
   * Confirm a finished upload.
   *
   * Only `{ checksum }` travels: the size, type, storage key and scan status are the row's
   * on the server, and a body field for any of them would be a claim the server must ignore.
   * The answer is the literal `processing` — a verified upload is *not* a scanned one.
   */
  async completeAttachmentUpload(
    attachmentId: string,
    societyId: string,
    _actor: string,
    checksum: string,
  ): Promise<AttachmentCompletion> {
    const body = completeAttachmentUploadSchema.parse({ checksum });
    const response = await apiRequest('POST', `attachments/${attachmentId}/complete`, {
      schema: completeAttachmentUploadResponseSchema,
      societyId,
      body,
    });
    return { status: response.status };
  }

  async listCategoryNames(societyId: string, _actor: string): Promise<ReadonlyMap<string, string>> {
    const { categories } = await apiRequest('GET', 'expense-categories', {
      schema: expenseCategoryListResponseSchema,
      societyId,
    });
    return new Map(categories.map((category) => [category.id, category.name]));
  }

  async listBuildingOptions(
    societyId: string,
    _actor: string,
  ): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const { buildings } = await apiRequest('GET', 'buildings', {
      schema: buildingListResponseSchema,
      societyId,
    });
    return buildings.map((building) => ({ id: building.id, name: building.name }));
  }

  async listCategoryOptions(
    societyId: string,
    _actor: string,
  ): Promise<readonly ExpenseCategoryOption[]> {
    const { categories } = await apiRequest('GET', 'expense-categories', {
      schema: expenseCategoryListResponseSchema,
      societyId,
    });
    // `isActive` is the server's own flag and the picker's only filter: a deactivated category is
    // still returned so historical rows can be labelled, and re-offering it on a new bill is
    // exactly what T062's deactivation exists to prevent.
    return categories
      .filter((category) => category.isActive)
      .map((category) => ({
        id: category.id,
        name: category.name,
        defaultSplitStrategy: category.defaultSplitStrategy,
        defaultApartmentBasis: category.defaultApartmentBasis,
      }));
  }

  async listPayerOptions(
    societyId: string,
    _actor: string,
  ): Promise<readonly ExpensePayerOption[]> {
    // A bounded page rather than the whole directory: the payer is one tap out of the members a
    // treasurer actually bills, and pulling a 300-member society into a form field would be a
    // request made on every mount. `limit` is clamped server-side, and the query orders by name.
    const { members } = await apiRequest('GET', 'members?limit=100', {
      schema: memberListResponseSchema,
      societyId,
    });
    return members
      .filter((member) => member.status === 'active')
      .map((member) => ({ id: member.id, displayName: member.displayName }));
  }

  async previewSplit(
    societyId: string,
    _actor: string,
    request: SplitPreviewRequest,
  ): Promise<PreviewSplitResponseDto> {
    const { signal, ...fields } = request;
    // Absent and `null` are different facts on the wire and the same one here: an omitted
    // `categoryId` means "consult no category defaults", which is exactly what `null` says,
    // and the strict schema refuses neither. Every optional dimension is omitted when it has
    // no value so the request the server sees is the smallest one that means what was asked.
    const body = {
      amountPaise: fields.amountPaise,
      ...(fields.categoryId == null ? {} : { categoryId: fields.categoryId }),
      ...(fields.splitStrategy === undefined ? {} : { splitStrategy: fields.splitStrategy }),
      ...(fields.apartmentBasis == null ? {} : { apartmentBasis: fields.apartmentBasis }),
      ...(fields.splitConfig === undefined || Object.keys(fields.splitConfig).length === 0
        ? {}
        : { splitConfig: fields.splitConfig }),
      participantSelector: fields.participantSelector,
    };

    return apiRequest('POST', 'expenses/preview-split', {
      schema: previewSplitResponseSchema,
      societyId,
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async create(
    societyId: string,
    _actor: string,
    payload: CreateExpensePayload,
  ): Promise<ExpenseSummary> {
    const { expense } = await apiRequest('POST', 'expenses', {
      schema: expenseResponseSchema,
      societyId,
      body: payload,
    });
    return toSummary(expense);
  }

  async update(
    expenseId: string,
    societyId: string,
    _actor: string,
    payload: UpdateExpensePayload,
  ): Promise<ExpenseSummary> {
    // The published-edit door answers `{ expense, recalculation }`; `expenseResponseSchema` is a
    // non-strict object, so the same parse reads both shapes and the extra key is ignored. The
    // form never takes that door (it only offers draft/pending-approval rows), but a PATCH that
    // crossed the threshold between load and save must still return a usable row rather than
    // throwing at the boundary.
    const { expense } = await apiRequest('PATCH', `expenses/${expenseId}`, {
      schema: expenseResponseSchema,
      societyId,
      body: payload,
    });
    return toSummary(expense);
  }
}
