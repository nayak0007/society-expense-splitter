import type { AttachmentError } from "./errors";
import { attachmentError } from "./errors";
import type { Result } from "../shared/result";

/**
 * Magic-number detection for the four types a bill may be — Roadmap T071,
 * ADR-0012 D1 layer 3.
 *
 * ## Why a hand-rolled sniffer rather than a detection package
 *
 * The brief allowed "an appropriate maintained magic-byte detection package *if
 * justified*". It is not, here, and the reasons are concrete rather than a
 * preference for fewer dependencies:
 *
 * 1. **The required coverage is four signatures.** SAD §10.4 admits exactly
 *    JPEG, PNG, PDF and HEIC for a bill. A general-purpose package carries
 *    several hundred type definitions, a stream/`Uint8Array`/`File` API and its
 *    own dependency tree — a real supply-chain addition — to answer four
 *    questions whose entire answers are the constants below.
 * 2. **The question this module asks is a *comparison*, not an identification.**
 *    Detection packages answer "what is this?". Completion needs "does the stored
 *    object's signature match the type the caller declared?" — a stricter, smaller
 *    question, and one a package answers only after its own guess is interpreted
 *    by a caller that then has to encode the comparison anyway.
 * 3. **Being wrong here is boundedly wrong.** The signature check is one of three
 *    independent gates (ADR-0012 D1): the size is pinned by the signature on the
 *    upload URL, the SHA-256 is verified against the client's declared digest, and
 *    the bytes themselves were written by the presigned URL's holder. A sniffer
 *    that recognises only the four accepted families cannot *admit* anything the
 *    other two gates have not already agreed to; the failure mode is refusing a
 *    file, never accepting a wrong one.
 *
 * The consequence worth stating plainly: this is deliberately not a general
 * detector, and it must not be grown into one. A type that a family cannot be
 * added to is a `MIME_FAMILIES` entry; a type whose *sniffing* would need to
 * disambiguate container variants (say, every `iso` media brand) is a decision for
 * the task that admits it, with tests for the real signatures.
 *
 * ## How much of an object is read
 *
 * `SIGNATURE_PREFIX_BYTES` — twelve bytes. JPEG, PNG and PDF are decided inside
 * the first eight; HEIC needs the `ftyp` box header at offset 4 and its brand at
 * offset 8, so twelve is the smallest prefix that decides all four. The completion
 * path therefore reads a bounded prefix of the object rather than the whole
 * upload where it can, and still hashes the full object for the checksum — the two
 * reads are separate on purpose (see the completion use case).
 */

/** The prefix every signature below is decided within. */
export const SIGNATURE_PREFIX_BYTES = 12;

/**
 * The families a stored object can be recognised as.
 *
 * A *family* and not a MIME type: HEIC is one container with a dozen accepted
 * brands, so the honest unit is "this is an ISO-BMFF still image", and the
 * declared MIME type is checked against the family rather than against a brand.
 */
export const CONTENT_FAMILIES = ["jpeg", "png", "pdf", "heic"] as const;
export type ContentFamily = (typeof CONTENT_FAMILIES)[number];

/** The declared MIME type → the family its bytes must belong to. */
export const MIME_FAMILIES: Readonly<Record<string, ContentFamily>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

/** The file-signature constants, named so a reader can check them against ISO 10918 / 15948 / 32000 / 14496-12. */
const JPEG_START = [0xff, 0xd8, 0xff] as const;
/** `%PDF-` — the header, not the `%%EOF` trailer, because a truncated PDF has none. */
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** `ftyp` — the ISO base-media file-type box, at offset 4 in every BMFF file. */
const FTYP = [0x66, 0x74, 0x79, 0x70] as const;

/**
 * The `ftyp` major brands that mean "a HEIC/HEIF still image".
 *
 * `heic`/`heix` are the still-image brands, `hevc`/`hevx` the image-sequence
 * brands an iPhone writes for a burst or a live photo, `heim`/`heis`/`hevm`/`hevs`
 * their scalable/multiview variants, and `mif1`/`msf1` the generic HEIF brands a
 * third-party encoder emits. A brand outside this list is *not* accepted: `mp41`,
 * `isom` and `qt  ` are video containers, and a `.heic` whose bytes are a video is
 * exactly the mismatch this check exists to find.
 */
const HEIC_BRANDS: readonly string[] = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let text = "";
  for (let index = offset; index < offset + length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return "";
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * The family the bytes belong to, or `null` for anything unrecognised.
 *
 * `null` is not "no opinion" — the caller treats it as a refusal, because the
 * product admits four types and "some other file" is not one of them.
 *
 * The checks are ordered by how cheaply they are decided and each is guarded by a
 * length test of its own, so a one-byte object cannot read past the end of the
 * buffer. That matters: the bytes come from an object store and the length is not
 * trusted to be the signed one at the moment this runs.
 */
export function detectContentFamily(bytes: Uint8Array): ContentFamily | null {
  if (startsWith(bytes, JPEG_START)) return "jpeg";
  if (startsWith(bytes, PNG_HEADER)) return "png";
  if (startsWith(bytes, PDF_HEADER)) return "pdf";

  // HEIC: `[size:4][ftyp][brand:4]`. The box size is not checked — it varies with
  // the number of compatible brands and a wrong size is not a content mismatch —
  // but the brand is, because that is what separates a still image from a video.
  if (asciiAt(bytes, 4, 4) === String.fromCharCode(...FTYP)) {
    const brand = asciiAt(bytes, 8, 4);
    if (HEIC_BRANDS.includes(brand)) return "heic";
  }

  return null;
}

/**
 * The bytes → the declared type's verdict. `null` means agreement.
 *
 * Returns the refusal rather than a boolean so the caller has one thing to do with
 * the answer, and so the *reason* is carried in `details` — a mismatch against a
 * PDF header and a completely unrecognised object both refuse, but only the second
 * is worth telling an operator about, and only the first is worth telling a caller
 * which fields to check.
 */
export function verifyContentMatchesMimeType(
  bytes: Uint8Array,
  declaredMimeType: string,
): Result<ContentFamily, AttachmentError> {
  const expected = MIME_FAMILIES[declaredMimeType];
  if (expected === undefined) {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        "Unsupported file type. A bill may be a JPEG, PNG, HEIC or PDF.",
        { field: "mimeType" },
      ),
    };
  }

  const detected = detectContentFamily(bytes);
  if (detected === null) {
    return {
      ok: false,
      error: attachmentError(
        "content_mismatch",
        "The uploaded file is not a JPEG, PNG, HEIC or PDF. Its contents were checked, not its name.",
        { expectedFamily: expected, detectedFamily: null },
      ),
    };
  }

  if (detected !== expected) {
    return {
      ok: false,
      error: attachmentError(
        "content_mismatch",
        `The uploaded file's contents are a ${detected.toUpperCase()} file, not a ${declaredMimeType}. Its contents were checked, not its name.`,
        { expectedFamily: expected, detectedFamily: detected },
      ),
    };
  }

  return { ok: true, value: detected };
}
