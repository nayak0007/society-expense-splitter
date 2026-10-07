import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  asAttachmentError,
  attachmentError,
  validateChecksum,
  verifyContentMatchesMimeType,
} from "@ses/domain";
import type {
  AttachmentError,
  AttachmentMembershipReader,
  AttachmentRecord,
  AttachmentRepository,
  Result,
  SocietyId,
  StorageProvider,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { STORAGE_PROVIDER } from "../../../../infrastructure/storage/storage.tokens";
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
 * Verify a finished upload and stamp it complete — Roadmap T071, ADR-0012.
 *
 * ## Completion trusts nothing the upload said
 *
 * The presigned PUT is a credential handed to a device, and this is the step that
 * decides whether what the credential wrote is the thing that was promised. It
 * re-derives every fact from the stored object:
 *
 * ```text
 *   1  membership
 *   2  the persisted attachment row            (404 for a foreign or unknown id)
 *   3  the parent expense                      (society isolation, lifecycle)
 *   4  canOnResource("expense.create", row)    (the same 🟡 narrowing as presign)
 *   5  the request's checksum == the row's     (a 422 with no object read at all)
 *   6  HEAD                                    (exists? length == reserved?)
 *   7  read the object                         (bytes)
 *   8  SHA-256 of those bytes == the checksum  (computed here, never an ETag)
 *   9  magic bytes are the row's declared type
 *  10  stamp completed_at
 *  11  retain scan_status
 *  12  answer { status: 'processing' }
 * ```
 *
 * ## Why `ETag` is not the checksum
 *
 * An S3 `ETag` is the object's MD5 **for a single-part upload** and something else
 * entirely for a multipart one, and Supabase Storage's is neither. Treating it as a
 * digest would pass a wrong file whenever a client used multipart, which is exactly
 * the case a large bill is — so the digest is computed here from the bytes this
 * process read. `etag` is still returned by `readObject` and still logged; it is
 * never compared.
 *
 * ## Replay is a 200 no-op
 *
 * ADR-0012 fixes the semantics: completing an already-complete upload answers
 * `{ status: 'processing' }` again and writes nothing. It is **not** a 409, because
 * a client whose connection dropped after the server committed has no way to tell a
 * lost response from a lost request, and refusing it would leave an upload that
 * succeeded permanently unreportable. `AttachmentRepository.markComplete` expresses
 * this as a conditional `UPDATE … WHERE completed_at IS NULL` plus a re-read, so the
 * replay is the database's own answer rather than a check this file makes.
 *
 * ## A failed verification deletes nothing
 *
 * When the checksum or the magic bytes disagree, the row is left exactly as it was:
 * not complete, not clean, `scan_status` untouched. ADR-0012 is silent on whether
 * the invalid object should be removed immediately, and the brief for this task says
 * to use the safest documented behaviour and report the gap rather than inventing a
 * destructive lifecycle — so nothing is deleted here, and the object is left for the
 * **abandoned-object sweep** the ADR already lists as a required obligation. The
 * object is unreachable through the application (no completed row references it, no
 * route serves it), and the row still ages out of the quota after 15 minutes.
 *
 * ## Nothing is marked clean
 *
 * `scan_status` is read from the row and written back unchanged — which, for every
 * row this API creates, is `pending`. No scanner exists (ADR-0012 D3), so `clean` is
 * never written and the serving gate stays inert; the response says `processing`,
 * never `clean`, because claiming otherwise would be a security claim the
 * implementation does not make.
 */
@Injectable()
export class CompleteUploadUseCase {
  constructor(
    @Inject(ATTACHMENT_REPOSITORY)
    private readonly attachments: AttachmentRepository,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: AttachmentMembershipReader,
  ) {}

  async complete(
    actor: UserId,
    societyId: SocietyId,
    attachmentId: string,
    command: CompleteUploadCommand,
  ): Promise<CompleteUploadResult> {
    // 1 · The subject.
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // 2 · The row. RLS and the explicit society predicate make a cross-society id
    //     unaddressable, which is the 404 the contract promises.
    const attachment = await this.loadAttachmentOrNotFound(
      attachmentId,
      societyId,
      actor,
    );

    // 3 · The parent expense, and the lifecycle gate. Read rather than trusted from
    //     the row: an expense can be voided between presign and complete, and
    //     completing against a void one would attach a bill to a closed record.
    const expense = await loadExpenseOrNotFound(
      this.attachments,
      actor,
      societyId,
      attachment.entityId,
    );
    assertExpenseAcceptsAttachments(expense);

    // 4 · The same narrowing site as presign, against the same stored row.
    if (!mayOnExpense(membership, "expense.create", expense)) {
      throw toAppError(
        attachmentError("forbidden", ATTACHMENT_CREATE_FORBIDDEN),
      );
    }

    // 5 · The declared digest, checked against the row before any bytes are read.
    //     A disagreement here is the caller telling us it uploaded a different file
    //     than it reserved — a 422 naming `checksum`, and no storage traffic at all.
    const declared = unwrap(validateChecksum(command.checksum));
    if (declared !== attachment.checksum) {
      throw toAppError(
        attachmentError(
          "validation",
          "That checksum is not the one this upload reserved. Complete the upload with the checksum you sent when you asked for the URL.",
          { field: "checksum" },
        ),
      );
    }

    // 6 · `HEAD`. Existence first, then the length: the signature pinned the exact
    //     `Content-Length`, so a stored object of another size means the reservation
    //     and the object are not the same upload. Reported as a `conflict` because
    //     the request is well formed and the *store's state* disagrees with it.
    const metadata = await this.readFromStore(() =>
      this.storage.head(attachment.storageKey),
    );
    if (metadata === null) {
      throw toAppError(
        attachmentError(
          "conflict",
          "No uploaded file was found for this attachment. Upload it before completing.",
          { field: "attachmentId", storageKeyPresent: true },
        ),
      );
    }

    if (metadata.contentLength !== attachment.sizeBytes) {
      throw toAppError(
        attachmentError(
          "conflict",
          "The uploaded file is not the size this upload reserved.",
          {
            expectedBytes: attachment.sizeBytes,
            actualBytes: metadata.contentLength,
          },
        ),
      );
    }

    // 7 · The bytes.
    const object = await this.readFromStore(() =>
      this.storage.readObject(attachment.storageKey),
    );
    if (object === null) {
      throw toAppError(
        attachmentError(
          "conflict",
          "No uploaded file was found for this attachment. Upload it before completing.",
        ),
      );
    }

    // 8 · The digest, computed from the stored bytes. A malformed row checksum
    //     cannot reach here (the column's `CHECK` and the parse both refuse it), but
    //     a disagreement is still possible and is the whole point of the step.
    const actual = sha256Hex(object.bytes);
    if (actual !== attachment.checksum) {
      throw toAppError(
        attachmentError(
          "content_mismatch",
          "The uploaded file's contents do not match the checksum you declared. Upload the file again, unchanged.",
          { expectedChecksum: attachment.checksum, actualChecksum: actual },
        ),
      );
    }

    // 9 · The magic number against the declared type. This is the check the
    //     Roadmap's own test list demands: a `.jpg` holding `%PDF-` is refused, and
    //     so is the reverse. The declared type is metadata; the bytes decide.
    unwrap(verifyContentMatchesMimeType(object.bytes, attachment.mimeType));

    // 10–11 · The stamp. `markComplete` is a conditional update, so a concurrent
    //         completion loses the race, matches nothing, and re-reads to answer the
    //         same success the winner got. `scan_status` is not written: the
    //         repository's update touches `completed_at` only, and no grant admits
    //         anything else.
    const completed = await this.attachments.markComplete(
      attachment.id,
      societyId,
      actor,
    );
    if (!completed.ok) {
      // The row exists, is not complete, and the update matched nothing — which can
      // only be the row's own policy refusing. That happens when the expense moved
      // to `void` between the gate above and the write, or when the caller's role
      // narrowed. The lifecycle refusal is the honest answer.
      throw toAppError(
        completed.error.code === "forbidden"
          ? attachmentError("invalid_transition", VOID_OR_NARROWED)
          : completed.error,
      );
    }

    return { status: "processing", attachment: completed.value };
  }

  /**
   * One read against the store, with the adapter's own classification preserved.
   *
   * The adapter already separates "the store refused this" (`conflict`) from "the
   * store is unreachable" (`storage_unavailable` → 503, which the S3 adapter raises
   * for a 5xx, a 408, a 429 and every timeout). Letting that error escape unmapped
   * would render an outage as a 500 `INTERNAL` — this API's own defect, with a
   * client's retry logic and a monitor's alerting both pointed at the wrong thing.
   * The presign path maps the same way, so the three routes answer one catalogue.
   */
  private async readFromStore<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      throw toAppError(asAttachmentError(error));
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

/** What the route hands the use case — already parsed by the contract schema. */
export interface CompleteUploadCommand {
  readonly checksum: string;
}

/** What the use case answers; the controller maps `status` alone to the wire. */
export interface CompleteUploadResult {
  readonly status: "processing";
  readonly attachment: AttachmentRecord;
}

/**
 * The row moved into a state that refuses completion, between the read and the
 * write. Deliberately not "the upload was already complete" — that path answers 200
 * from the repository, and telling the two apart matters because only one of them is
 * retryable.
 */
const VOID_OR_NARROWED =
  "This expense no longer accepts that upload. A void expense is a closed record.";

/** SHA-256, lowercase hex — the column's `CHECK` shape, and the same one the client declared. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Unwraps a domain `Result` into a value or a mapped `AppError`. */
function unwrap<T>(result: Result<T, AttachmentError>): T {
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
