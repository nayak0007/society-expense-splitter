/**
 * Attachment preparation — Roadmap T076 (audit §9).
 *
 * This module turns a picked file into an **uploadable one**: it normalises an image
 * to a JPEG of at most `1600 px` on its longest edge, applies the second pass when the
 * first overshoots the target, validates the result against T071's limits, and returns
 * the final file's size and SHA-256 — the two facts the presign request must carry.
 *
 * ## Why the digest is computed here and not by the uploader
 *
 * The presign request declares `sizeBytes` and `checksum`, and the signature on the
 * returned URL pins that exact byte count. Both facts must describe the file that is
 * about to be sent, so they are produced by the step that produced the file — the last
 * write to it. `sha256OfFile` reads the final bytes; `uploadFileRaw` sends the same
 * URI; nothing rewrites the file in between. That is the whole client half of
 * "SHA-256 computed client-side and verified server-side".
 *
 * ## Why a fresh JPEG is the EXIF strip, and not a separate pass
 *
 * `expo-image-manipulator` writes a new JPEG from decoded pixels. A JPEG encoder
 * emits no EXIF block, no GPS sub-IFD, no MakerNote and no orientation tag — so a
 * re-encode **is** the strip, and orientation is baked into the pixels as a side
 * effect (which is also why a rotated phone photo comes out upright). There is no
 * metadata-editing step to invoke and none is claimed: the guarantee is the format,
 * and the verification is that the uploaded bytes are the encoder's output.
 *
 * ## PDFs are passed through untouched
 *
 * PRD §3.4 and SAD §10.5 both say PDFs pass through untouched, and T076's brief
 * forbids converting a PDF to an image to simplify the upload. So a document keeps
 * its bytes exactly: the file is read only to measure and hash it.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { deleteLocalFile, localFileSize, sha256OfFile } from '@/lib/storage/files';

import {
  ATTACHMENT_DOCUMENT_MIME,
  ATTACHMENT_MAX_BYTES,
  AttachmentValidationError,
  IMAGE_MAX_EDGE_PX,
  IMAGE_PRIMARY_QUALITY,
  IMAGE_SECOND_PASS_QUALITY,
  IMAGE_TARGET_BYTES,
  assertAcceptableUpload,
  documentDisplayName,
  isImageMimeType,
  jpegDisplayName,
  resolvePickerMimeType,
} from '../schemas/attachment.schemas';

/** A file that is ready to reserve and upload: the bytes on disk, and their facts. */
export interface PreparedAttachment {
  /** The local `file://` URI of the exact bytes that will be uploaded. */
  readonly uri: string;
  /** The display name sent as `fileName` (display metadata — never a path). */
  readonly fileName: string;
  /** One of the four accepted types. Always `image/jpeg` for a compressed image. */
  readonly mimeType: string;
  /** The byte count of `uri`, which is what the presigned signature pins. */
  readonly sizeBytes: number;
  /** SHA-256 of `uri`'s bytes, lowercase hex. */
  readonly checksum: string;
  readonly isImage: boolean;
  /** Rendered pixel dimensions for an image; `null` for a document. */
  readonly width: number | null;
  readonly height: number | null;
}

/** What an image picker hands back — structurally, so the picker type is not imported. */
export interface PickedImage {
  readonly uri: string;
  readonly fileName?: string | null | undefined;
  readonly mimeType?: string | null | undefined;
}

/** What a document picker hands back. */
export interface PickedDocument {
  readonly uri: string;
  readonly name: string;
  readonly mimeType?: string | null | undefined;
}

interface RenderedImage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One manipulation + encode.
 *
 * The contextual API (`manipulate(uri).resize(…).renderAsync()`) is used rather than
 * the deprecated `manipulateAsync`: it is the SDK 57 surface, and `renderAsync`
 * returns a reference whose dimensions are the *output's*, which is what the second
 * pass and the returned width/height need.
 */
async function renderJpeg(
  uri: string,
  resize: { readonly width?: number; readonly height?: number } | null,
  compress: number,
): Promise<RenderedImage> {
  const context = ImageManipulator.manipulate(uri);
  if (resize !== null) context.resize(resize);
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({
    compress,
    format: SaveFormat.JPEG,
  });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}

/** The source image's pixel dimensions, read without writing a file. */
async function probeDimensions(
  uri: string,
): Promise<{ readonly width: number; readonly height: number }> {
  const rendered = await ImageManipulator.manipulate(uri).renderAsync();
  return { width: rendered.width, height: rendered.height };
}

/**
 * Compress one image into an uploadable JPEG.
 *
 * Order, and why:
 *
 *  1. probe the source dimensions (no file written);
 *  2. resize only when the longest edge exceeds 1600 — a smaller image is never
 *     upscaled, because upscaling adds bytes without adding detail;
 *  3. encode at q0.7, which is also the step that drops EXIF and applies orientation;
 *  4. if the result is still above the 400 KB target, encode it again at q0.55 and
 *     remove the intermediate file;
 *  5. refuse the result only if it breaches the *contract's* 10 MB cap, and hash the
 *     bytes that will actually be sent.
 *
 * A result between 400 KB and 10 MB is uploaded: the Roadmap calls 400 KB a target,
 * and refusing a legible dense scan for it would be inventing a limit.
 */
export async function prepareImage(uri: string, originalName: string): Promise<PreparedAttachment> {
  const { width, height } = await probeDimensions(uri);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AttachmentValidationError(
      'unreadable_file',
      'That image could not be read. Try choosing it again.',
    );
  }

  const longestEdge = Math.max(width, height);
  const resize =
    longestEdge > IMAGE_MAX_EDGE_PX
      ? width >= height
        ? { width: IMAGE_MAX_EDGE_PX }
        : { height: IMAGE_MAX_EDGE_PX }
      : null;

  let rendered = await renderJpeg(uri, resize, IMAGE_PRIMARY_QUALITY);
  let sizeBytes = localFileSize(rendered.uri);

  if (sizeBytes > IMAGE_TARGET_BYTES) {
    const secondPass = await renderJpeg(rendered.uri, null, IMAGE_SECOND_PASS_QUALITY);
    deleteLocalFile(rendered.uri);
    rendered = secondPass;
    sizeBytes = localFileSize(rendered.uri);
  }

  if (sizeBytes <= 0) {
    throw new AttachmentValidationError(
      'unreadable_file',
      'That image could not be read after compression. Try choosing it again.',
    );
  }

  assertAcceptableUpload({ fileName: originalName, mimeType: 'image/jpeg', sizeBytes });

  const { checksum } = await sha256OfFile(rendered.uri);

  return {
    uri: rendered.uri,
    fileName: jpegDisplayName(originalName),
    mimeType: 'image/jpeg',
    sizeBytes,
    checksum,
    isImage: true,
    width: rendered.width,
    height: rendered.height,
  };
}

/**
 * Prepare one picked image, refusing anything outside the product's four types.
 *
 * The **pre-compression size is deliberately not capped**: a modern phone camera
 * produces images above 10 MB, and the contract's 10 MB applies to the bytes that are
 * uploaded, not to the file the camera wrote. Capping the original would refuse a
 * perfectly ordinary photo. The cap is applied to the compressed result in
 * `prepareImage`.
 */
export async function preparePickedImage(picked: PickedImage): Promise<PreparedAttachment> {
  const originalName = picked.fileName ?? 'bill.jpg';
  const mimeType = resolvePickerMimeType(picked.mimeType, originalName);
  if (mimeType === null || !isImageMimeType(mimeType)) {
    throw new AttachmentValidationError(
      'unsupported_type',
      'That file is not an image this app can attach. A bill may be a JPEG, PNG or HEIC photo.',
    );
  }

  const sourceSize = localFileSize(picked.uri);
  if (sourceSize <= 0) {
    throw new AttachmentValidationError(
      'unreadable_file',
      'That image could not be read. Try choosing it again.',
    );
  }

  return prepareImage(picked.uri, originalName);
}

/**
 * Prepare one picked document — only a PDF is accepted, and its bytes are not touched.
 *
 * A PDF's original size *is* its uploaded size, so the 10 MB contract cap is applied
 * here, before any hashing or reservation.
 */
export async function preparePickedDocument(picked: PickedDocument): Promise<PreparedAttachment> {
  const mimeType = resolvePickerMimeType(picked.mimeType, picked.name);
  if (mimeType !== ATTACHMENT_DOCUMENT_MIME) {
    throw new AttachmentValidationError(
      'unsupported_type',
      'A bill document must be a PDF. Choose a photo for an image bill.',
    );
  }

  const sizeBytes = localFileSize(picked.uri);
  assertAcceptableUpload({ fileName: picked.name, mimeType, sizeBytes });

  const { checksum } = await sha256OfFile(picked.uri);

  return {
    uri: picked.uri,
    fileName: documentDisplayName(picked.name),
    mimeType,
    sizeBytes,
    checksum,
    isImage: false,
    width: null,
    height: null,
  };
}

/** True when the prepared result breaches the contract's ceiling — a defensive re-check. */
export function exceedsContractCap(prepared: PreparedAttachment): boolean {
  return prepared.sizeBytes > ATTACHMENT_MAX_BYTES;
}
