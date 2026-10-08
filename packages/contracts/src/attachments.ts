import {
  ATTACHMENT_SCAN_STATUSES,
  CHECKSUM_PATTERN,
  EXPENSE_ATTACHMENT_MAX_BYTES,
  EXPENSE_ATTACHMENT_MIME_TYPES,
  ORIGINAL_FILENAME_MAX_LENGTH,
} from "@ses/domain";
import { z } from "zod";

/**
 * Attachment wire contract — Roadmap T071, ADR-0012 D4.
 *
 * ## Three routes, and the ones that are deliberately absent
 *
 * ```text
 * POST   /v1/expenses/:expenseId/attachments  -> 201 { attachmentId, uploadUrl, storageKey, expiresAt, requiredHeaders }
 * POST   /v1/attachments/:attachmentId/complete -> 200 { status: 'processing' }
 * DELETE /v1/attachments/:attachmentId        -> 204
 * ```
 *
 * There is **no list route and no download route in T071** (ADR-0012 D4). The
 * consumers that would need them — T073's expense detail, T076's capture flow,
 * T132's OCR — need the presign/complete/delete trio first, and a list route
 * invented before its screen exists would be a route nobody asked for behind a
 * permission nobody chose. `presignDownload` exists on the storage port (SAD
 * §10.2) with no HTTP surface yet.
 *
 * ## Every bound is imported, not re-spelled
 *
 * `EXPENSE_ATTACHMENT_MIME_TYPES`, `EXPENSE_ATTACHMENT_MAX_BYTES`,
 * `CHECKSUM_PATTERN`, `ORIGINAL_FILENAME_MAX_LENGTH` and
 * `ATTACHMENT_SCAN_STATUSES` all come from `@ses/domain`. A literal
 * `z.enum(["image/jpeg", …])` here would be a second spelling of the type list,
 * and its failure mode is silent: a type the domain accepts and the contract does
 * not is simply unuploadable from every client, which reads as a product
 * limitation rather than as a typo. The same argument `expenses.ts` records for
 * `SPLIT_STRATEGIES` applies verbatim.
 *
 * ## Request bodies are strict, responses are not
 *
 * SAD §7.8 stage 1: an unknown inbound field is a caller mistake worth reporting,
 * while an added outbound field must not break a client that has not been rebuilt.
 * So the request schemas are `strictObject` and the response schemas are plain
 * `z.object`.
 */

/**
 * `POST /expenses/:expenseId/attachments` — reserve an upload and get its URL.
 *
 * ## What the client declares, and what it does not
 *
 * The body is four facts the device genuinely knows before it has uploaded
 * anything: the name it will show, the type it believes the file is, how many
 * bytes it will send, and the file's SHA-256. `sizeBytes` is the load-bearing one —
 * it becomes the **exact** length the presigned PUT's signature pins (ADR-0012 D1),
 * so a wrong value is refused by the storage layer at upload time rather than
 * silently accepted.
 *
 * Deliberately absent, and `strictObject` so they are refused rather than ignored:
 * `storageKey` (server-minted — accepting one would be accepting a path from the
 * request, which is the traversal case the key builder exists to make
 * unrepresentable), `societyId` (the `X-Society-Id` header, SAD §1.1),
 * `attachmentId` (server-minted; a client-supplied id is the "client-generated
 * attachment IDs used as authority" case), `uploadedBy`, `scanStatus`,
 * `completedAt` and `entityType` (the route's path fixes it to `expense`). None of
 * those is a field a client has standing to send, so each is a refusal rather than
 * an ignored key.
 *
 * ## `fileName` is display metadata
 *
 * Its suffix is **never** used to type the upload: the extension is derived from the
 * validated `mimeType` (see `MIME_EXTENSIONS`), because a `.jpg` whose bytes are a
 * PDF has to be refused and a check that consults the client's own filename cannot
 * do that. The value here is sanitised again server-side (path separators stripped)
 * — a browser that reports `C:\Users\me\bill.jpg` should store `bill.jpg`, not fail.
 */
export const presignAttachmentUploadSchema = z.strictObject({
  fileName: z
    .string()
    .trim()
    .min(1, "A file name is required")
    .max(ORIGINAL_FILENAME_MAX_LENGTH),
  mimeType: z.enum(EXPENSE_ATTACHMENT_MIME_TYPES),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(
      EXPENSE_ATTACHMENT_MAX_BYTES,
      `A bill may be at most ${EXPENSE_ATTACHMENT_MAX_BYTES} bytes`,
    ),
  /**
   * SHA-256 of the file's bytes, lowercase hex. Lower-cased before the pattern
   * check rather than after it, so an uppercase digest — the same digest — is
   * accepted instead of refused for its spelling.
   */
  checksum: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      CHECKSUM_PATTERN,
      "The checksum must be the file's SHA-256 as 64 hexadecimal characters",
    ),
});
export type PresignAttachmentUploadPayload = z.infer<
  typeof presignAttachmentUploadSchema
>;

/**
 * The presign response.
 *
 * `uploadUrl` is an **opaque string** to every consumer — it is a signed,
 * time-limited credential, and nothing outside the storage adapter may parse,
 * store or reconstruct it. It is deliberately not validated as a URL here: the
 * local store's is `http://…` and the hosted provider's is `https://…`, and pinning
 * a scheme in the contract would be the contract knowing about a provider.
 *
 * `requiredHeaders` is part of the response because the signature covers
 * `content-length` and `host`. A client that omits `Content-Length` is refused by
 * the storage layer (`411 MissingContentLength`, measured), so publishing the
 * headers the signature expects turns a confusing upload failure into a mechanical
 * one. `Content-Type` is included because the provider records it and completion
 * compares it.
 *
 * `expiresAt` is the API's own answer for when the URL dies (900 seconds from
 * issuance). It is not the credential itself and carries no secret.
 *
 * No field of this response is a credential: the service-role key, the S3 access
 * key and any session token stay server-side, and the OpenAPI document never sees
 * them (see the storage adapter's own note).
 */
export const presignAttachmentUploadResponseSchema = z.object({
  attachmentId: z.uuid(),
  uploadUrl: z.string().min(1),
  storageKey: z.string().min(1),
  expiresAt: z.iso.datetime(),
  requiredHeaders: z.record(z.string(), z.string()),
});
export type PresignAttachmentUploadResponseDto = z.infer<
  typeof presignAttachmentUploadResponseSchema
>;

/**
 * `POST /attachments/:attachmentId/complete` — say the upload has finished.
 *
 * ## Why the body carries the checksum again
 *
 * The checksum is already on the row, so this looks redundant — and it is not.
 * Completion's whole job is to compare the object that landed against what was
 * promised, and the digest is the one field where "the client says" and "the server
 * verifies" must be two values that can differ: the row holds the declaration, the
 * stored bytes hold the truth, and the request's value is checked against the row
 * before any bytes are read (a mismatch is a `422` naming `checksum` with no object
 * read at all). It also makes the route self-describing — a caller cannot complete
 * an upload with a digest it did not promise, which is what keeps completion
 * replayable without being forgeable.
 *
 * `strictObject`, and there is exactly one field: everything else — the size, the
 * type, the storage key, `completed_at` and `scan_status` — is the row's, and a body
 * field for any of them would be a claim the server must ignore.
 */
export const completeAttachmentUploadSchema = z.strictObject({
  checksum: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      CHECKSUM_PATTERN,
      "The checksum must be the file's SHA-256 as 64 hexadecimal characters",
    ),
});
export type CompleteAttachmentUploadPayload = z.infer<
  typeof completeAttachmentUploadSchema
>;

/**
 * The completion response — one word, and deliberately not more.
 *
 * `processing` is SAD §10.1's own answer and the honest one: the object has been
 * verified, the row is complete, and nothing else has happened. It is *not*
 * `clean` — no scanner exists, so nothing writes `clean` and the serving gate stays
 * inert (ADR-0012 D3); reporting `clean` here would be a security claim the
 * implementation does not make. It is *not* `ready` either, because the download
 * route does not exist yet.
 *
 * The value is a literal rather than an enum of the scan vocabulary: this is a
 * *response* state, not a stored one, and the two must not be conflated — which is
 * exactly how a client ends up believing an unscanned file is clean.
 */
export const completeAttachmentUploadResponseSchema = z.object({
  status: z.literal("processing"),
});
export type CompleteAttachmentUploadResponseDto = z.infer<
  typeof completeAttachmentUploadResponseSchema
>;

/**
 * One attachment, as a read would return it.
 *
 * **T071 shipped no route that returned this** (ADR-0012 D4 consigned the list and
 * download routes to T073's expense detail, which now adds them). It is returned by
 * `GET /expenses/:expenseId/attachments` and carries one thing a client must read
 * carefully: `scanStatus`. `pending` is not `clean` — a bill that has not been
 * scanned is not a bill that has been verified safe (ADR-0012 D3), and the field
 * exists so a screen can say so.
 *
 * Its fields are the row's and **none of them is a URL**: a download link is minted
 * per read and never stored, so there is nothing here to leak or expire.
 */
export const attachmentSchema = z.object({
  id: z.uuid(),
  entityType: z.literal("expense"),
  entityId: z.uuid(),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  checksum: z.string(),
  scanStatus: z.enum(ATTACHMENT_SCAN_STATUSES),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AttachmentDto = z.infer<typeof attachmentSchema>;

/**
 * `GET /expenses/:expenseId/attachments` — the expense's **completed** bills.
 *
 * Only rows with a non-null `completedAt` are listed: an outstanding presign
 * reservation is an upload that has not arrived, and its `completedAt === null` is
 * exactly the difference the list must not blur. Deleted attachments are absent
 * because the row is gone (ADR-0012 D6.3 removes the row, not the object).
 *
 * Ordered oldest first, the order the expense detail renders, and unpaginated for
 * the reason the split list is: an expense has a handful of bills (PRD §3.4's cap is
 * five), and a cursor over a set that small would be complexity without a screen.
 */
export const expenseAttachmentsResponseSchema = z.object({
  attachments: z.array(attachmentSchema),
});
export type ExpenseAttachmentsResponseDto = z.infer<
  typeof expenseAttachmentsResponseSchema
>;

/**
 * `GET /attachments/:attachmentId/download` — a short-lived, authorized URL.
 *
 * ## The URL is the whole point, and it is the only secret in the body
 *
 * `url` is an opaque, time-limited signed credential for a **private** object
 * (ADR-0012: "Attachments are never served without a time-limited URL; no bucket is
 * public"). It is never persisted and never logged, and the client must treat it as
 * opaque — nothing outside the storage adapter may parse it.
 *
 * ## `filename` is returned for the client to *use*, not to trust
 *
 * The stored `originalFilename` was sanitised at presign time (path separators
 * stripped) and is exposed so a viewer can title the download and a "save as" can
 * offer a sensible name. It is display metadata: the response deliberately does not
 * put it into a `Content-Disposition` the server controls, so no header is built from
 * client-influenced text and there is no header-injection surface at all.
 *
 * ## `scanStatus` travels, so the UI cannot imply safety it does not have
 *
 * The download is permitted — the serving gate is inert while no scanner is
 * configured (ADR-0012 D3) — but the response says what the scan actually found, so
 * the mobile client can label an unscanned bill as unscanned rather than rendering it
 * as verified. It is the same value the list carries; repeating it here means a caller
 * that jumped straight to a download link still sees it.
 */
export const attachmentDownloadUrlSchema = z.object({
  url: z.string().min(1),
  expiresAt: z.iso.datetime(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  scanStatus: z.enum(ATTACHMENT_SCAN_STATUSES),
});
export type AttachmentDownloadUrlDto = z.infer<
  typeof attachmentDownloadUrlSchema
>;
