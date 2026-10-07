import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  asAttachmentError,
  attachmentError,
  buildAttachmentStorageKey,
  extensionForMimeType,
  sanitiseOriginalFilename,
  validateAttachmentMimeType,
  validateAttachmentSize,
  validateChecksum,
} from "@ses/domain";
import type {
  AttachmentError,
  AttachmentMembershipReader,
  AttachmentRecord,
  AttachmentRepository,
  ExpenseId,
  Result,
  SocietyId,
  StorageProvider,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { STORAGE_PROVIDER } from "../../../../infrastructure/storage/storage.tokens";
import { AppConfig } from "../../../../config/app-config";
import {
  attachmentQuotaBytesForPlan,
  pricedAttachmentPlans,
} from "../../../../config/plan-quotas";
import { toAppError } from "../attachment-error.mapper";
import { ATTACHMENT_REPOSITORY } from "../attachment.tokens";
import {
  ATTACHMENT_CREATE_FORBIDDEN,
  assertExpenseAcceptsAttachments,
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  mayOnExpense,
} from "./attachment.support";

/**
 * Reserve an upload and mint its presigned PUT — Roadmap T071, ADR-0012.
 *
 * ## The order of the fifteen steps, and why it is this order
 *
 * ```text
 *   1  membership                    (the authorisation subject)
 *   2  expense of this society       (404 for a foreign or unknown id)
 *   3  lifecycle gate                (void refuses; ADR-0012 D6.1)
 *   4  canOnResource("expense.create", stored row)   (D5's 🟡 narrowing)
 *   5  MIME type                     (SAD §10.4's four)
 *   6  size                          (the per-type cap)
 *   7  checksum shape                (server-side, before a row exists)
 *   8  the society's plan cap        (ADR-0012 D2; fail closed on an unpriced plan)
 *   9  attachmentId                  (server-minted)
 *  10  extension                     (from the validated MIME, never the filename)
 *  11  storage key                   (SAD §10.3, built in one place)
 *  12  reserve                      (lock → sum → compare → insert; one transaction)
 *  13  presign                      (exact signed Content-Length, 900 s)
 *  14  (failure at 13 discards 12 — see below)
 *  15  respond
 * ```
 *
 * Each refusal precedes every one that could only be reached after it, so a caller
 * who fixes the first error always reaches the next: a cross-society expense never
 * costs a plan read, and a 20 MB file never takes a society lock.
 *
 * ## Nothing the caller sends decides anything structural
 *
 * `attachmentId` is `randomUUID()` here, the key is built by
 * `buildAttachmentStorageKey` from the server's own ids, and the suffix comes from
 * `MIME_EXTENSIONS` — a map keyed by a type that has already been validated. The
 * client's `fileName` is reduced to display metadata by
 * `sanitiseOriginalFilename`, which strips path separators rather than refusing
 * them: a browser reporting `C:\Users\me\bill.jpg` should store `bill.jpg`.
 *
 * ## Why the row is inserted before the URL exists, and what happens if signing fails
 *
 * The reservation has to exist before the client can upload, or the quota would be
 * advisory: an issued URL that bypasses the cap is exactly the failure the
 * reservation exists to prevent. So the row goes in first — and because the row
 * insertion is its own transaction, a signing failure must not leave it behind.
 *
 * There is no cross-transaction rollback available (the bucket is not in the
 * database), so the compensation is explicit: if `presignUpload` throws, the
 * reservation is **deleted** before the error is rethrown, and a failure of *that*
 * delete is logged rather than reported — an orphaned row is not a quota breach
 * forever (it stops counting after the 15-minute window) and the client's request
 * already failed for a reason it needs to hear. The two failure modes are
 * deliberately different: a stuck reservation ages out, whereas a URL without a
 * reservation never would have.
 *
 * ## Nothing here moves money
 *
 * No split, due, balance, revision or expense row is read for writing, and no
 * approval stamp is touched. The only write is the attachment row. The integration
 * suite measures the financial tables before and after for exactly this reason.
 */
@Injectable()
export class PresignUploadUseCase {
  private readonly logger = new Logger(PresignUploadUseCase.name);

  constructor(
    @Inject(ATTACHMENT_REPOSITORY)
    private readonly attachments: AttachmentRepository,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: AttachmentMembershipReader,
    private readonly config: AppConfig,
  ) {}

  async presign(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: PresignUploadCommand,
  ): Promise<PresignUploadResult> {
    // 1 · The subject.
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // 2 · The record — never 403 for an id in another society (PRD T041).
    const expense = await loadExpenseOrNotFound(
      this.attachments,
      actor,
      societyId,
      expenseId,
    );

    // 3 · The lifecycle. Its own gate rather than folded into the authorisation,
    //     because a `void` expense refuses *everybody* — including an Admin — and
    //     the refusal is about the record's state rather than the caller's role.
    assertExpenseAcceptsAttachments(expense);

    // 4 · The 🟡 narrowing site the route inventory requires: `expense.create` is
    //     Admin/Treasurer full and Committee Member *draft only*, so the stored row
    //     decides for a Committee Member — and a `pending_approval` or `published`
    //     expense is not a draft.
    if (!mayOnExpense(membership, "expense.create", expense)) {
      throw toAppError(
        attachmentError("forbidden", ATTACHMENT_CREATE_FORBIDDEN),
      );
    }

    // 5–7 · The declared facts. Each is a `Result`, so the first refusal is the one
    //       the caller sees and no later step runs.
    const mimeType = unwrap(validateAttachmentMimeType(command.mimeType));
    const sizeBytes = unwrap(validateAttachmentSize(command.sizeBytes));
    const checksum = unwrap(validateChecksum(command.checksum));

    // 8 · The plan's cap. Read from the society row verbatim, mapped locally, and
    //     **refused** rather than defaulted when the plan is not priced — see
    //     `config/plan-quotas.ts` for why a default would be worse than a refusal.
    const capBytes = await this.resolvePlanCap(actor, societyId);

    // 9–11 · The server's own facts. `randomUUID` for the id, the map for the
    //        extension, and one builder for the key, so the insert policy's
    //        prefix assertion and the client's upload URL cannot disagree.
    const attachmentId = randomUUID();
    const extension = extensionForMimeType(mimeType);
    if (extension === null) {
      // Unreachable: `validateAttachmentMimeType` is the same closed map. Kept
      // because the two functions derive from one table by different routes.
      throw toAppError(
        attachmentError("validation", "Unsupported file type.", {
          field: "mimeType",
        }),
      );
    }

    const storageKey = unwrap(
      buildAttachmentStorageKey({
        societyId,
        entityType: "expense",
        entityId: expenseId,
        attachmentId,
        mimeType,
      }),
    );

    // 12 · The reservation. One transaction: lock, sum, compare, insert. The id
    //      travels with it so the row and the key name the same attachment.
    const reservation = await this.attachments.reserve(
      {
        id: attachmentId,
        societyId,
        entityType: "expense",
        entityId: expenseId,
        storageKey,
        originalFilename: sanitiseOriginalFilename(command.fileName),
        mimeType,
        sizeBytes,
        checksum,
        uploadedBy: membership.id,
        planCapBytes: capBytes,
      },
      actor,
    );

    if (!reservation.ok) {
      throw toAppError(reservation.error);
    }

    // 13 · The URL, whose signature pins `sizeBytes` exactly.
    try {
      const presigned = await this.storage.presignUpload({
        storageKey,
        contentType: mimeType,
        contentLength: sizeBytes,
        ttlSeconds: this.config.storagePresignTtlSeconds,
      });

      return {
        attachment: reservation.value,
        uploadUrl: presigned.url,
        storageKey: presigned.storageKey,
        expiresAt: presigned.expiresAt,
        requiredHeaders: presigned.requiredHeaders,
      };
    } catch (error: unknown) {
      // 14 · The compensation. The row is already committed, so it is removed
      //      explicitly; see the class note for why the two failures are treated
      //      differently.
      await this.discardReservation(reservation.value, actor, societyId);
      throw toAppError(asAttachmentError(error));
    }
  }

  /**
   * The society's cap, or a refusal that names the plan.
   *
   * Two distinct failures, one shape. A society row the caller cannot read is a
   * `not_found` — the same invisibility every other read answers — while a plan the
   * map does not price is a *server-side* gap and is reported as `unknown` (→ 500)
   * with the plan in the message, so an operator can act on it. Treating the second
   * as a quota refusal would tell a user to upgrade a plan they already have;
   * treating it as Free's 500 MB would silently limit them.
   */
  private async resolvePlanCap(
    actor: UserId,
    societyId: SocietyId,
  ): Promise<number> {
    const plan = await this.attachments.readSocietySubscriptionPlan(
      societyId,
      actor,
    );

    if (plan === null) {
      throw toAppError(
        attachmentError("not_found", "That society is not available to you."),
      );
    }

    const capBytes = attachmentQuotaBytesForPlan(plan);
    if (capBytes === null) {
      this.logger.warn(
        `Attachment quota: the stored plan "${plan}" has no entry in ` +
          `PLAN_ATTACHMENT_QUOTA_BYTES (priced: ${pricedAttachmentPlans().join(", ")}). ` +
          `Refusing rather than defaulting.`,
      );
      throw toAppError(
        attachmentError(
          "unknown",
          "This society's plan is not configured for file storage yet. Contact support.",
          { plan, priced: pricedAttachmentPlans() },
        ),
      );
    }

    return capBytes;
  }

  /**
   * Remove a reservation whose URL could not be minted.
   *
   * A failure here is logged, never thrown over the original error: the caller's
   * request already failed for a reason it needs to read, and the row that survived
   * is a *bounded* problem — an outstanding reservation stops counting against the
   * quota once its 15-minute window closes (ADR-0012 D2) — whereas replacing the
   * storage error with a delete error would hide the cause of the failure.
   */
  private async discardReservation(
    attachment: AttachmentRecord,
    actor: UserId,
    societyId: SocietyId,
  ): Promise<void> {
    try {
      await this.attachments.deleteById(attachment.id, societyId, actor);
    } catch (error: unknown) {
      this.logger.warn(
        `Could not discard presign reservation ${attachment.id} after the upload ` +
          `URL failed to sign. It stops counting against the plan quota after 15 ` +
          `minutes. Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** What the route hands the use case — already parsed by the contract schema. */
export interface PresignUploadCommand {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
}

/** What the use case answers; the controller maps it to the response DTO. */
export interface PresignUploadResult {
  readonly attachment: AttachmentRecord;
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

/** Unwraps a domain `Result` into a value or a mapped `AppError`. */
function unwrap<T>(result: Result<T, AttachmentError>): T {
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
