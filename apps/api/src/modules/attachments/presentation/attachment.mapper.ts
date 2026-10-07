import type {
  CompleteAttachmentUploadResponseDto,
  PresignAttachmentUploadResponseDto,
} from "@ses/contracts";
import type { AttachmentRecord } from "@ses/domain";

import type { CompleteUploadResult } from "../application/use-cases/complete-upload.use-case";
import type { PresignUploadResult } from "../application/use-cases/presign-upload.use-case";

/**
 * The attachment module's result → wire shapes — Roadmap T071.
 *
 * A mapper file rather than inline object literals in the controller, for the reason
 * every other module has one: the contract schema the client parses and the object
 * the handler returns must not be two definitions that drift, and a mapper is the
 * one place a field can be renamed deliberately.
 *
 * ## The presigned URL is passed through and never inspected
 *
 * `uploadUrl` travels as an opaque string. Nothing here parses it, validates its
 * scheme, rewrites a host or stores it: it is a signed, time-limited credential, and
 * the only component that may understand its structure is the adapter that minted it
 * — which is also the reason it is not logged. `requiredHeaders` carries the
 * signature's own expectations (`Content-Length`, `Content-Type`) and no secret; the
 * access key pair and any session token stay in the `S3Client`.
 */
export function presignUploadToDto(
  result: PresignUploadResult,
): PresignAttachmentUploadResponseDto {
  return {
    attachmentId: result.attachment.id,
    uploadUrl: result.uploadUrl,
    storageKey: result.storageKey,
    expiresAt: result.expiresAt,
    // Copied rather than passed by reference: the DTO is serialised and the
    // adapter's object is a live value on an injected singleton.
    requiredHeaders: { ...result.requiredHeaders },
  };
}

/**
 * The completion response.
 *
 * One field, and it is the literal `processing` — not `clean`, and not `ready`. The
 * verified object is *not* scanned (no scanner exists, ADR-0012 D3) and there is no
 * download route in T071, so either of those words would be a claim the
 * implementation does not make. The `attachment` the use case also returns is
 * deliberately dropped here rather than added to the wire: the contract fixes the
 * body, and a client that needs the row will read it from the expense detail it came
 * from.
 */
export function completeUploadToDto(
  _result: CompleteUploadResult,
): CompleteAttachmentUploadResponseDto {
  return { status: "processing" };
}

/**
 * A record → the wire's attachment shape.
 *
 * **No route in T071 returns this** (ADR-0012 D4: no list and no detail route), and
 * it is here anyway because two things need it as a mapping: the module's own unit
 * suite asserts the shape a later task will inherit, and T073's expense detail will
 * extend this object rather than invent a second one. Kept beside the two live
 * mappers so the three cannot diverge.
 */
export function attachmentToDto(record: AttachmentRecord) {
  return {
    id: record.id,
    entityType: record.entityType,
    entityId: record.entityId,
    originalFilename: record.originalFilename,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    checksum: record.checksum,
    scanStatus: record.scanStatus,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
  };
}
