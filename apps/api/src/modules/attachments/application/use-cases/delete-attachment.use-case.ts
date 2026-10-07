import { Inject, Injectable, Logger } from "@nestjs/common";
import { asAttachmentError, attachmentError } from "@ses/domain";
import type {
  AttachmentMembershipReader,
  AttachmentRecord,
  AttachmentRepository,
  SocietyId,
  StorageProvider,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { STORAGE_PROVIDER } from "../../../../infrastructure/storage/storage.tokens";
import { toAppError } from "../attachment-error.mapper";
import { ATTACHMENT_REPOSITORY } from "../attachment.tokens";
import {
  ATTACHMENT_DELETE_FORBIDDEN,
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  mayOnExpense,
} from "./attachment.support";

/**
 * Delete one attachment — Roadmap T071, ADR-0012 D6.3/D6.4.
 *
 * ## Who may delete: the uploader, or a caller authorized to manage the expense
 *
 * ADR-0012 D6.4, and both halves are needed rather than one:
 *
 * ```text
 *   the uploader's own row            — the person who made a mistake fixes it
 *   OR  canOnResource("expense.void", the parent expense)   — D5's cells
 * ```
 *
 * The second branch is `expense.void`'s own cell, checked with `canOnResource`
 * against the **persisted** expense, so a Committee Member reaches their own
 * unpublished expense and nobody else's, while an Admin or Treasurer reaches the
 * society's. There is no uploader-only restriction because a bill attached to a
 * published expense is part of the society's financial record and the people who
 * manage that record must be able to remove a wrong one; and there is no inline
 * role string anywhere, because `docs/guides/AUTHORIZATION.md` §4 forbids it and a
 * role check is not a resource decision.
 *
 * Note what the first branch does *not* do: it does not bypass the membership
 * check. `loadMembershipOrNotFound` runs first for everybody, so a removed member
 * cannot delete their own historical upload.
 *
 * ## The ordering, and what happens when the second half fails
 *
 * **Row first, object second** (D6.3). A stranded object is invisible to the
 * application and sweepable; a stranded row points at bytes that are gone, which is
 * a broken live reference and is worse. So:
 *
 * 1. the row is deleted, in the caller's own transaction, under RLS — if this fails
 *    the object is untouched and the whole operation is a clean refusal;
 * 2. the object is deleted, best-effort. If *it* fails, the row is **not**
 *    recreated, no failed transaction is reported, and a structured line records
 *    enough to sweep. The attachment is already unreachable through every
 *    application path, so the caller's answer is a success — reporting a failure
 *    would be a lie about a row that is genuinely gone.
 *
 * The `logger.warn` rather than `logger.error` is deliberate: an unreachable object
 * in a bucket is an operational chore, not an incident, and the ADR already lists
 * the abandoned-object sweep as a required obligation. It is also the only signal
 * that sweep has, which is why the line carries the key and the society.
 *
 * ## Nothing financial, and no revision
 *
 * No split, due, balance, `member_balances` column, `expense_revisions` row or
 * approval stamp is touched. Deleting a bill does not change what a member owes,
 * does not invalidate an approval (D6.2) and does not publish or void anything —
 * the integration suite proves the money numbers and the approval stamps are
 * byte-identical across this call.
 */
@Injectable()
export class DeleteAttachmentUseCase {
  private readonly logger = new Logger(DeleteAttachmentUseCase.name);

  constructor(
    @Inject(ATTACHMENT_REPOSITORY)
    private readonly attachments: AttachmentRepository,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: AttachmentMembershipReader,
  ) {}

  async remove(
    actor: UserId,
    societyId: SocietyId,
    attachmentId: string,
  ): Promise<void> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    const attachment = await this.loadAttachmentOrNotFound(
      attachmentId,
      societyId,
      actor,
    );

    // The parent is read for the resource decision, and a missing parent is a
    // `not_found`: an attachment whose expense has been hard-deleted (D6.5's
    // cleanup) must not be deletable through a route that no longer has a record to
    // authorise against.
    const expense = await loadExpenseOrNotFound(
      this.attachments,
      actor,
      societyId,
      attachment.entityId,
    );

    const isUploader = attachment.uploadedBy === membership.id;
    const mayManage = mayOnExpense(membership, "expense.void", expense);

    if (!isUploader && !mayManage) {
      throw toAppError(
        attachmentError("forbidden", ATTACHMENT_DELETE_FORBIDDEN),
      );
    }

    // 1 · The row. A refusal here is the database's own half of the same decision,
    //     classified as `forbidden` (PRD T041's 404-not-403 applies to reads; this is
    //     a write the caller was allowed to see).
    try {
      await this.attachments.deleteById(attachmentId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asAttachmentError(error));
    }

    // 2 · The object, after the row, best-effort.
    await this.deleteObject(attachment);
  }

  /**
   * Best-effort object removal, with the sweep's evidence on failure.
   *
   * Deliberately swallows: see the class note. The log line carries the storage key
   * (which names the society and the expense through SAD §10.3's own layout — so a
   * sweeper can act on it without a database read), the attachment id and the
   * reason.
   */
  private async deleteObject(attachment: AttachmentRecord): Promise<void> {
    try {
      await this.storage.delete(attachment.storageKey);
    } catch (error: unknown) {
      this.logger.warn(
        `Orphaned storage object after attachment delete: society=${attachment.societyId} ` +
          `attachment=${attachment.id} key=${attachment.storageKey}. The row is gone and ` +
          `the object is unreachable through the API; it needs the abandoned-object sweep. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The row, or a `not_found` — one answer for absent and invisible alike. */
  private async loadAttachmentOrNotFound(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<AttachmentRecord> {
    let attachment: AttachmentRecord | null;
    try {
      attachment = await this.attachments.findById(
        attachmentId,
        societyId,
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asAttachmentError(error));
    }

    if (attachment === null) {
      throw toAppError(
        attachmentError(
          "not_found",
          "That attachment is not available to you.",
        ),
      );
    }
    return attachment;
  }
}
