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
  expenseAttachmentsResponseSchema,
  expenseCategoryListResponseSchema,
  expenseCommentsResponseSchema,
  expenseListResponseSchema,
  expenseResponseSchema,
  expenseRevisionsResponseSchema,
  expenseSplitsResponseSchema,
  buildingListResponseSchema,
} from '@ses/contracts';
import type { ExpenseDto } from '@ses/contracts';

import { apiRequest, isApiError } from '@/lib/api/api-client';

import type {
  ExpenseAttachmentDownload,
  ExpenseAttachmentView,
  ExpenseCommentView,
  ExpenseListQuery,
  ExpensePage,
  ExpenseRepository,
  ExpenseRevisionView,
  ExpenseSplitView,
  ExpenseSummary,
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
    status: dto.status,
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
}
