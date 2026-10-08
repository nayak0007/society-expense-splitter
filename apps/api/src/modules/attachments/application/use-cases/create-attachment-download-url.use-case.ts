import { Inject, Injectable } from "@nestjs/common";
import { asAttachmentError, attachmentError } from "@ses/domain";
import type {
  AttachmentRecord,
  AttachmentRepository,
  AttachmentScanStatus,
  SocietyId,
  StorageProvider,
  UserId,
} from "@ses/domain";

import { STORAGE_PROVIDER } from "../../../../infrastructure/storage/storage.tokens";
import { AppConfig } from "../../../../config/app-config";
import { toAppError } from "../attachment-error.mapper";
import { ATTACHMENT_REPOSITORY } from "../attachment.tokens";
import { assertAttachmentServable } from "../attachment-scan-gate";

/**
 * Mint a short-lived, authorized download URL for one attachment — Roadmap T073,
 * ADR-0012 D4/D5.
 *
 * ## The order, and why each step precedes the next
 *
 * ```text
 *   1  the attachment row, of this society, visible to this caller   (404 otherwise)
 *   2  completed only          (an outstanding reservation is not a bill -> 404)
 *   3  the serving gate        (inert while no scanner is configured; ADR-0012 D3)
 *   4  presignDownload          (private object, short-lived URL, no public bucket)
 *   5  respond                 (the URL, its expiry, and the row's own metadata)
 * ```
 *
 * ## Authorization
 *
 * The route declares `expense.view` (every role but Guest), and there is no resource
 * narrowing to perform. The read is scoped by the id **and** the caller's society and
 * runs under the caller's RLS identity (`attachments_select_member` →
 * `can_view_expenses`), so a cross-society or unknown id answers `not_found` (404),
 * never a distinguishable 403 — the same answer the expense read gives. No new
 * `attachment.*` permission family is introduced (ADR-0012 D5/D8): this reuses
 * `expense.view`.
 *
 * ## Void expenses
 *
 * Read is **allowed** on a `void` expense's attachments, deliberately. ADR-0012 D6.1
 * forbids *adding* a bill to a void expense (it is immutable historical evidence), but
 * viewing the evidence of a reversed bill is exactly what a resident auditing a void
 * needs, and the row's `completedAt` already gates it. Nothing is mutated by a read.
 *
 * ## Nothing about the object store leaks
 *
 * `presignDownload` returns a derived credential bound to one key, one method and one
 * expiry; the access key pair never leaves the adapter. The response carries the row's
 * already-sanitised `originalFilename` for the client to *use* as a display/save name —
 * the server does not build a `Content-Disposition` from it, so there is no
 * header-injection surface, and the URL itself is opaque and never logged.
 */
@Injectable()
export class CreateAttachmentDownloadUrlUseCase {
  constructor(
    @Inject(ATTACHMENT_REPOSITORY)
    private readonly attachments: AttachmentRepository,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    private readonly config: AppConfig,
  ) {}

  async create(
    actor: UserId,
    societyId: SocietyId,
    attachmentId: string,
  ): Promise<AttachmentDownloadResult> {
    // 1 · The row, visible to this caller in this society.
    let record: AttachmentRecord | null;
    try {
      record = await this.attachments.findById(attachmentId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asAttachmentError(error));
    }

    if (record === null) {
      throw toAppError(
        attachmentError(
          "not_found",
          "That attachment is not available to you.",
        ),
      );
    }

    // 2 · Completed only. An outstanding reservation has no object to serve, so it is the
    //     same invisibility as an absent id rather than a conflict — a client should not
    //     be able to tell "you never uploaded" from "that id is not yours".
    if (record.completedAt === null) {
      throw toAppError(
        attachmentError(
          "not_found",
          "That attachment is not available to you.",
        ),
      );
    }

    // 3 · The serving gate. Inert today (no scanner configured, ADR-0012 D3), shaped for
    //     the armed configuration so `409`/`403` are reachable the moment one is set.
    assertAttachmentServable(record);

    // 4 · The signed GET. The signature and the TTL are the provider's; the use case only
    //     states the product's window (the same 900 s the upload URL uses).
    let url: string;
    try {
      url = await this.storage.presignDownload(
        record.storageKey,
        this.config.storagePresignTtlSeconds,
      );
    } catch (error: unknown) {
      throw toAppError(asAttachmentError(error));
    }

    return {
      url,
      expiresAt: new Date(
        Date.now() + this.config.storagePresignTtlSeconds * 1000,
      ).toISOString(),
      filename: record.originalFilename,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      scanStatus: record.scanStatus,
    };
  }
}

/** What the route hands the mapper. */
export interface AttachmentDownloadResult {
  readonly url: string;
  readonly expiresAt: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly scanStatus: AttachmentScanStatus;
}
