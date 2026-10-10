/**
 * Local file primitives — Roadmap T076 (audit §9/§6).
 *
 * ## Why this module exists beside `mmkv.ts`
 *
 * `mmkv.ts` is the key-value store (drafts, UI state). This is the other half of
 * `src/lib/storage`: the **bytes** half — how big a picked file is, how to read it,
 * how to hash it and how to send it. It is deliberately feature-free (it knows
 * nothing about expenses or attachments) so the expense feature owns the *policy*
 * (which types, how big, how much to compress) and this file owns only the
 * mechanics.
 *
 * ## The one rule that matters: hash what you send
 *
 * T071's completion endpoint recomputes the SHA-256 of the **stored object** and
 * refuses the upload when it differs from the digest the reservation was made with
 * (`422 CONTENT_MISMATCH`). The only way that check is useful on the client is if
 * the digest is computed over the *exact bytes that are uploaded* — not over the
 * pre-compression original, and not over a base64 rendering of the file. So
 * `sha256OfFile` reads the bytes once and returns them beside the digest, and the
 * upload step hands the **same file URI** to the transport. There is no second
 * read between hashing and sending.
 *
 * ## The transport is `expo-file-system`'s native upload, not `fetch`
 *
 * React Native's `fetch` cannot report upload progress and cannot stream a file
 * from disk without holding it in JS memory. `File.upload` (SDK 57's
 * `expo-file-system`) does both natively, and — critically — sends a
 * `BINARY_CONTENT` body, which is what a presigned S3 PUT expects. A
 * `multipart/form-data` body would be refused by the signature, so the upload type
 * is pinned here rather than left to a caller.
 */

import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File, Paths, UploadType } from 'expo-file-system';

/** Progress reported by the native uploader — bytes sent of bytes to send. */
export interface UploadProgressEvent {
  readonly bytesSent: number;
  readonly totalBytes: number;
}

/** What a finished (or refused) upload answered. The body is never surfaced. */
export interface RawUploadResult {
  readonly status: number;
}

/** A file's bytes plus the digest computed over exactly those bytes. */
export interface HashedFile {
  readonly checksum: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** True when the URI names a file that currently exists. */
export function localFileExists(uri: string): boolean {
  return new File(uri).exists;
}

/**
 * The file's size in bytes, or `0` when it cannot be read.
 *
 * `0` rather than a throw: the caller's next move is a size check, and every cap
 * this app enforces is `size <= N`, so an unreadable file is refused by the same
 * comparison that refuses an oversized one. A missing file is also what a deleted
 * cache entry looks like after a pick — this is the honest answer, not an outage.
 */
export function localFileSize(uri: string): number {
  const file = new File(uri);
  return file.exists ? file.size : 0;
}

/** The file's bytes. Rejects when the file is gone or unreadable. */
export async function readLocalFileBytes(uri: string): Promise<Uint8Array<ArrayBuffer>> {
  return new File(uri).bytes();
}

/**
 * Remove a local file, ignoring anything that is already gone.
 *
 * Used to tidy the intermediate render of the compression pipeline's second pass.
 * It never throws: a cleanup that fails must not turn a successful preparation into
 * an error the user sees.
 */
export function deleteLocalFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // A cache file the system already reclaimed, or a URI the platform refuses.
    // Both are the state this function produces, so there is nothing to report.
  }
}

/** A new file inside the app's cache directory, e.g. for a compression output. */
export function newCacheFile(name: string): File {
  return new File(Paths.cache, name);
}

/** Lowercase hex of a byte buffer — the shape T071's `CHECKSUM_PATTERN` accepts. */
export function bytesToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * SHA-256 of a byte array, as 64 lowercase hex characters.
 *
 * `Crypto.digest` (not `digestStringAsync`) because the input is bytes: hashing a
 * base64 string would produce a digest of the base64 text, which is a different
 * value from the digest of the file and would be refused at completion.
 */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const buffer = await digest(CryptoDigestAlgorithm.SHA256, bytes);
  return bytesToHex(buffer);
}

/**
 * Read a file once and return its bytes with their digest.
 *
 * The two travel together on purpose: the caller hashes and uploads the *same*
 * bytes, so the digest the API verifies against the stored object is the digest of
 * what was actually sent. Nothing re-reads the file between this call and the
 * upload.
 */
export async function sha256OfFile(uri: string): Promise<HashedFile> {
  const bytes = await readLocalFileBytes(uri);
  return { checksum: await sha256Hex(bytes), bytes };
}

export interface RawUploadOptions {
  readonly url: string;
  /** The signature's own headers (`Content-Length`, `Content-Type`) — passed through verbatim. */
  readonly headers: Readonly<Record<string, string>>;
  readonly mimeType: string;
  readonly onProgress?: (event: UploadProgressEvent) => void;
  readonly signal?: AbortSignal | undefined;
}

/**
 * PUT the file's bytes straight to object storage — no API hop, no multipart.
 *
 * The presigned URL is treated as **opaque**: nothing here parses it, rewrites its
 * host or inspects its signature, and nothing logs it or the headers. A non-2xx
 * response resolves rather than throws, so the caller decides what a refusal means
 * (an expired signature is a different recovery from an outage); the response body
 * is discarded rather than returned, because an object-store error body names the
 * bucket and the key.
 */
export async function uploadFileRaw(
  uri: string,
  options: RawUploadOptions,
): Promise<RawUploadResult> {
  const file = new File(uri);
  const result = await file.upload(options.url, {
    httpMethod: 'PUT',
    // The presigned PUT is signed for the raw body. `MULTIPART` would wrap the
    // bytes in a form envelope the signature does not cover.
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...options.headers },
    mimeType: options.mimeType,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return { status: result.status };
}
