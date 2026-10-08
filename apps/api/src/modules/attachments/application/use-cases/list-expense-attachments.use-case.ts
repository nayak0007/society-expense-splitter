import { Inject, Injectable } from "@nestjs/common";
import { asAttachmentError } from "@ses/domain";
import type {
  AttachmentRecord,
  AttachmentRepository,
  ExpenseId,
  SocietyId,
  UserId,
} from "@ses/domain";

import { toAppError } from "../attachment-error.mapper";
import { ATTACHMENT_REPOSITORY } from "../attachment.tokens";
import { loadExpenseOrNotFound } from "./attachment.support";

/**
 * The **completed** bills of one expense — Roadmap T073, ADR-0012 D4's deferred list
 * route.
 *
 * ## Two steps, and the first is the authorization
 *
 * The expense is loaded through the module's existing projection
 * (`findExpenseForAttachment`), which answers `null` for a cross-society or unknown
 * id, and that becomes a `not_found` (404, never 403 — PRD T041: a caller cannot tell a
 * foreign society's expense from an absent one). Only then are the attachments read,
 * and only the **completed** ones: a row with a null `completedAt` is an outstanding
 * presign reservation, an upload that never arrived, and listing it would show a bill in
 * the expense detail that is not in the bucket.
 *
 * ## Why no `canOnResource` narrowing
 *
 * The route declares `expense.view` — a green cell for every role but Guest — so there
 * is nothing to narrow: the only question the matrix asks about a read is the tenant
 * one, which the projection and RLS answer. This is the same shape `GET
 * /expenses/:expenseId` and `GET …/revisions` have. No financial row is read for
 * writing and none is written.
 */
@Injectable()
export class ListExpenseAttachmentsUseCase {
  constructor(
    @Inject(ATTACHMENT_REPOSITORY)
    private readonly attachments: AttachmentRepository,
  ) {}

  async list(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<readonly AttachmentRecord[]> {
    // 1 · The parent expense — 404 for a foreign or unknown id, before any attachment
    //     is read. Failures are classified into the module's vocabulary.
    await loadExpenseOrNotFound(this.attachments, actor, societyId, expenseId);

    // 2 · The completed bills, oldest first, under the caller's own RLS identity.
    try {
      return await this.attachments.listCompletedForExpense(
        expenseId,
        societyId,
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asAttachmentError(error));
    }
  }
}
