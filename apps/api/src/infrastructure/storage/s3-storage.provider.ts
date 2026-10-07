import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { AttachmentError, attachmentError } from "@ses/domain";
import type {
  PresignUploadRequest,
  PresignedUpload,
  StorageObjectMetadata,
  StorageProvider,
  StoredObject,
} from "@ses/domain";

import { AppConfig } from "../../config/app-config";

/**
 * The one S3-compatible storage adapter — Roadmap T071, ADR-0012 D1.
 *
 * ## Why one adapter and not two
 *
 * ADR-0012 measured both providers directly and the finding is structural, not
 * convenient: a presigned `PutObject`, a `HEAD`, a `DELETE`, a `COPY` and a private
 * object are **the same protocol** on the hosted project and on the local store.
 * What differs is five configuration values — endpoint, region, credentials,
 * bucket and path-style addressing — and nothing else. A `SupabaseStorageProvider`
 * and a `MinioProvider` would therefore be two copies of one algorithm whose
 * divergence would be invisible until a bill uploaded in staging could not be
 * fetched in development. The class is one; the constructor decides which store it
 * is talking to.
 *
 * ## The size gate this adapter carries, and the one it does not
 *
 * `presignUpload` signs `content-length` (`X-Amz-SignedHeaders=content-length;host`)
 * along with the URL's method, bucket and key. Measured on the hosted provider and
 * on the local store alike (ADR-0012 D1 probes 10, 16–18 and 29–35):
 *
 * ```text
 * signed N / sent N     -> 200
 * signed N / sent > N   -> 403 SignatureDoesNotMatch   (no object created)
 * signed N / sent < N   -> 403 SignatureDoesNotMatch   (no object created)
 * signed N / no length  -> 403 SignatureDoesNotMatch   (no object created)
 * ```
 *
 * The last line is the one worth reading twice, because it is where the pin earns its
 * keep: the length is not merely *required* here, it is *signed*, so a request that
 * omits the header cannot match the signature at all. A URL minted **without** the pin
 * behaves quite differently — measured: an unframed 1 KB body answers `200` and stores
 * a **zero-byte** object, and a 2 MB body is accepted outright (probes 33 and 35).
 * That is the whole difference between "the client declared a size" and "the storage
 * layer enforces one", and it is why this adapter never mints an unpinned PUT.
 *
 * That is the exact-size pin, and it is why the client's declared `sizeBytes` is
 * reserved *before* the URL is minted: the number in the signature and the number
 * on the row are the same number.
 *
 * What this adapter deliberately does **not** carry is the per-object bucket cap.
 * Supabase Storage's `file_size_limit` is enforced (probe 9: `413 EntityTooLarge`),
 * MinIO has no equivalent (probe 28: a 10 MB + 1 B object was accepted), and the
 * setting is not even reachable through the S3 API this adapter speaks. It is
 * therefore a provider-console defence-in-depth layer for the hosted project — set
 * to 10 MB, SAD §10.4's largest live cap — and explicitly **not** part of the
 * provider contract. Locally, exact-size pinning plus completion verification are
 * the guarantee, which the ADR records as acceptable for a development store.
 *
 * ## Credentials never leave this process
 *
 * The access key pair is read once, through `AppConfig`, and lives only in the
 * `S3Client`. Nothing in this file logs it, returns it, or puts it in an error
 * message, and the presigned URL it produces is a *derived* credential bound to one
 * key, one method, one byte count and one expiry. The `requiredHeaders` it returns
 * are the signature's own expectations and carry no secret — which is the whole
 * reason the API returns a URL-and-headers pair rather than a credential.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: AppConfig) {
    this.bucket = config.storageBucket;

    // Built by assignment rather than by conditional spread, because this project
    // compiles with `exactOptionalPropertyTypes: true`: a spread of `{ endpoint }`
    // through a ternary widens the property to `string | undefined`, which the SDK's
    // `S3ClientConfig` refuses — and refusing it is right. An `endpoint: undefined`
    // key is not the same as an absent one, and the SDK reads the difference.
    const clientConfig: S3ClientConfig = {
      region: config.storageRegion,
      forcePathStyle: config.storageForcePathStyle,
      // No request checksums. The SDK's default for this command attaches an unsigned
      // `x-amz-checksum-crc32` + `x-amz-sdk-checksum-algorithm=CRC32` pair to the
      // presigned URL, computed over an **empty** body — the URL is minted before any
      // bytes exist, so the value is meaningless and, being unsigned, verifies
      // nothing. It is also a vendor-specific extra riding on a credential handed to a
      // third-party client, which a different S3-compatible provider is free to
      // validate and reject; the contract in `ports.ts` offers a method, a key, a
      // pinned length and an expiry, and nothing else. Measured: with
      // `WHEN_REQUIRED` the pair disappears and `content-length;host` remains the whole
      // signed header set (ADR-0012 probe 36).
      requestChecksumCalculation: "WHEN_REQUIRED",
    };

    const endpoint = this.resolveEndpoint();
    if (endpoint !== undefined) {
      clientConfig.endpoint = endpoint;
    }

    const credentials = this.resolveCredentials();
    if (credentials !== undefined) {
      clientConfig.credentials = credentials;
    }

    this.client = new S3Client(clientConfig);
  }

  // ── the port ────────────────────────────────────────────────────────────────

  /**
   * A presigned PUT whose signature pins the exact byte count.
   *
   * `signableHeaders: new Set(["content-length"])` is the load-bearing argument and
   * the only reason this is not a two-line function. Without it the SDK signs only
   * the host and the query string, the `ContentLength` on the command becomes a
   * *client hint* rather than a constraint, and a payload of any size is accepted —
   * which is exactly probe 11's "presigned PUT without a pinned length: a 2 MB body
   * → 200 accepted". With it, the header is in `X-Amz-SignedHeaders` and the
   * storage layer does the enforcing.
   *
   * `ContentType` is set so the provider records it (completion compares it), but it
   * is deliberately **not** signable: a signed `content-type` would make every
   * client's `charset` suffix a `SignatureDoesNotMatch`, and the type is metadata
   * that completion re-derives from the bytes rather than a security control.
   */
  async presignUpload(request: PresignUploadRequest): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: request.storageKey,
      ContentType: request.contentType,
      ContentLength: request.contentLength,
    });

    const url = await this.sign(command, request.ttlSeconds);
    const expiresAt = new Date(
      Date.now() + request.ttlSeconds * 1000,
    ).toISOString();

    return {
      url,
      storageKey: request.storageKey,
      expiresAt,
      requiredHeaders: {
        "Content-Length": String(request.contentLength),
        "Content-Type": request.contentType,
      },
    };
  }

  /**
   * A presigned GET — SAD §10.2's `presignDownload`.
   *
   * **No route in T071 serves this.** It is here because it is one of the port's
   * five capabilities and because the consumers that need it (T073's expense
   * detail, T132's OCR download) must be able to add a route without changing the
   * interface. Note what it does *not* do: it does not consult `scan_status`. SAD
   * §10.7's serving gate belongs to whatever route mints the URL, and arming it
   * here would make the gate unreachable-but-tested rather than tested.
   */
  async presignDownload(
    storageKey: string,
    ttlSeconds: number,
  ): Promise<string> {
    return this.sign(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      ttlSeconds,
    );
  }

  /** `HEAD`, with a missing object as `null` rather than a throw. */
  async head(storageKey: string): Promise<StorageObjectMetadata | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      return {
        contentLength: normalizeContentLength(response.ContentLength),
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
      };
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw this.translate(error, "head");
    }
  }

  /**
   * The object's bytes — completion verification's only input.
   *
   * The body is buffered whole rather than streamed, and that is a decision rather
   * than laziness: the caller is the completion path, which must compute the
   * object's SHA-256, and a digest is definitionally a function of every byte.
   * Streaming would compute the same digest with more code and one more failure
   * mode (a truncated read that still produced a plausible-length buffer). The
   * bound is SAD §10.4's own 10 MB cap — the largest object the product accepts —
   * so the buffer this can allocate is bounded by the same number the database
   * `CHECK`s.
   */
  async readObject(storageKey: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );

      const body = response.Body;
      if (body === undefined || body === null) {
        throw attachmentError(
          "storage_unavailable",
          "The stored object could not be read.",
        );
      }

      const bytes = await toByteArray(body);
      return {
        bytes,
        contentLength: normalizeContentLength(
          response.ContentLength ?? bytes.byteLength,
        ),
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
      };
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw this.translate(error, "read");
    }
  }

  /**
   * Server-side copy — SAD §10.2's `copy`.
   *
   * No caller in T071. It exists for the same reason `presignDownload` does: the
   * port is §10.2's and the thumbnail/OCR pipelines are its consumers. A copy —
   * rather than a download and re-upload — is the point: 10 MB of bytes never
   * travel through the API process (SAD §10.1: "Bytes never pass through the API").
   */
  async copy(fromStorageKey: string, toStorageKey: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: toStorageKey,
          CopySource: `${this.bucket}/${encodeKey(fromStorageKey)}`,
        }),
      );
    } catch (error: unknown) {
      throw this.translate(error, "copy");
    }
  }

  /**
   * `DELETE`, idempotent by construction.
   *
   * S3's `DeleteObject` answers `204` for a key that never existed, which is the
   * semantics the delete use case needs: ADR-0012 D6.3 removes the row *first*, and
   * a retry of the object half must not fail because the first attempt succeeded.
   * There is no "was it there" answer to plumb back, and inventing one would mean a
   * `HEAD` before every delete.
   */
  async delete(storageKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
    } catch (error: unknown) {
      throw this.translate(error, "delete");
    }
  }

  /**
   * Create the bucket when the deployment asks for it.
   *
   * Called once at boot, and only when `STORAGE_AUTO_CREATE_BUCKET` is on — which
   * is local development and the integration suite, never a deployed environment.
   * It replaces a `createbuckets` compose service that ran `minio/mc`; that image
   * no longer exists, and a second long-running service (or a second image) to run
   * one `CreateBucket` is a poor trade for one idempotent SDK call
   * (`infra/docker/docker-compose.dev.yml` records the same reasoning).
   *
   * `HeadBucket` first because `CreateBucket` is *not* idempotent on every
   * implementation — Supabase Storage answers `BucketAlreadyExists` where S3
   * answers `200` to the owner — so "check, then create" is the portable form. A
   * race between two API instances is handled by tolerating the already-exists
   * error rather than by locking.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error: unknown) {
      if (!isNotFound(error)) throw this.translate(error, "head-bucket");
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error: unknown) {
      if (isAlreadyExists(error)) return;
      throw this.translate(error, "create-bucket");
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** One `getSignedUrl`, so both presign methods share the expiry handling. */
  private async sign(
    command: PutObjectCommand | GetObjectCommand,
    ttlSeconds: number,
  ): Promise<string> {
    try {
      return await getSignedUrl(this.client, command, {
        expiresIn: ttlSeconds,
        // The pin. See `presignUpload` for why this argument is the feature.
        signableHeaders: new Set(["content-length"]),
      });
    } catch (error: unknown) {
      throw this.translate(error, "presign");
    }
  }

  /**
   * The endpoint, resolved from configuration or the provider's own default.
   *
   * `undefined` is a real answer for `s3`/`r2`-less AWS configuration (the SDK
   * derives it from the region), so the caller omits the key rather than passing an
   * empty string — an empty `endpoint` makes the SDK send every request to the
   * process's own origin, which fails in a way that reads like a permissions bug.
   */
  private resolveEndpoint(): string | undefined {
    const configured = this.config.storageEndpoint;
    if (configured !== undefined && configured !== "") return configured;

    const provider = this.config.storageProvider;
    if (provider === "minio") {
      // The compose service's own address. A default here — rather than a required
      // variable — is what makes a fresh checkout upload a bill with no storage
      // configuration at all; the production guard in the schema refuses `minio`
      // outside development, so this default cannot be shipped by accident.
      return "http://localhost:9000";
    }
    if (provider === "supabase") {
      return this.config.supabaseStorageEndpoint ?? undefined;
    }
    return undefined;
  }

  /**
   * The access key pair, or `undefined` for the SDK's own chain (environment,
   * shared config, instance role).
   *
   * The `minio` default matches `infra/docker/docker-compose.dev.yml`'s own
   * throwaway credentials, which are the store's `MINIO_ROOT_USER`/`PASSWORD` on a
   * laptop and not a secret anywhere: they are committed in that file already, and
   * the alternative — a required variable on every developer's machine — buys no
   * confidentiality for a local bucket. Outside development the schema makes both
   * variables required, so this branch cannot be reached.
   */
  private resolveCredentials():
    { accessKeyId: string; secretAccessKey: string } | undefined {
    const { accessKeyId, secretAccessKey } = this.config.storageCredentials;
    if (accessKeyId !== undefined && secretAccessKey !== undefined) {
      return { accessKeyId, secretAccessKey };
    }
    if (this.config.storageProvider === "minio" && !this.isDeployed()) {
      return { accessKeyId: "ses_minio", secretAccessKey: "ses_minio_local" };
    }
    return undefined;
  }

  private isDeployed(): boolean {
    const environment = this.config.environment;
    return environment === "production" || environment === "staging";
  }

  /**
   * An SDK failure → the module's own vocabulary.
   *
   * The distinction that matters is retryable or not: a 5xx, a timeout or a socket
   * error is `storage_unavailable` → the catalogue's `DEPENDENCY_UNAVAILABLE` → 503,
   * which a client may retry and a monitor should alert on, while a 4xx is the
   * caller's or the configuration's fault and is only useful as a log line. Falling
   * through to the `unknown` → 500 shape for both would make an outage look like a
   * bug in this API, which is the failure mode the catalogue's `DEPENDENCY_UNAVAILABLE`
   * exists to prevent.
   *
   * Nothing here echoes the SDK message into the response: an S3 error string can
   * carry the bucket name and the key, and the key names a society. The `what`
   * argument and the status code are enough to find the request in a log.
   */
  private translate(error: unknown, what: string): AttachmentError {
    const status = statusOf(error);
    const retryable =
      status === undefined || status === 408 || status === 429 || status >= 500;

    if (retryable) {
      return attachmentError(
        "storage_unavailable",
        "The file store is temporarily unavailable. Try again in a moment.",
        { operation: what, ...(status === undefined ? {} : { status }) },
      );
    }

    return attachmentError(
      "conflict",
      "The file store refused the operation.",
      { operation: what, status },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers — deliberately module-level, so the class is only the port's shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A missing object, across the three spellings the SDK uses.
 *
 * `HeadObject` answers a bare `404` with no error name — a documented S3 wart —
 * while `GetObject` answers `NoSuchKey` and a bucket-level miss answers
 * `NotFound`. Treating a missing *bucket* as a missing *object* is the same answer
 * for the caller (`null`), and the alternative — distinguishing them — would leak
 * which buckets exist.
 */
function isNotFound(error: unknown): boolean {
  const name = nameOf(error);
  if (name === "NoSuchKey" || name === "NotFound") return true;
  return statusOf(error) === 404;
}

/** Supabase answers this where S3 answers 200; both mean "already there". */
function isAlreadyExists(error: unknown): boolean {
  const name = nameOf(error);
  return (
    name === "BucketAlreadyExists" ||
    name === "BucketAlreadyOwnedByYou" ||
    statusOf(error) === 409
  );
}

function nameOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** The HTTP status the SDK attaches, whichever field carries it. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    $metadata?: { httpStatusCode?: unknown };
    status?: unknown;
  };
  const fromMetadata = candidate.$metadata?.httpStatusCode;
  if (typeof fromMetadata === "number") return fromMetadata;
  return typeof candidate.status === "number" ? candidate.status : undefined;
}

/**
 * `ContentLength` is a `number` in the SDK's own types but arrives as a string from
 * some implementations, and `Number(undefined)` is `NaN` — which would silently
 * compare unequal to every reserved size and refuse a correct upload. A missing
 * length is reported as `0`, which can never equal a reservation's positive
 * `sizeBytes`, so the failure is a clean refusal rather than a `NaN` comparison.
 */
function normalizeContentLength(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** The `GetObject` body → bytes, across the SDK's node/browser body shapes. */
async function toByteArray(body: unknown): Promise<Uint8Array> {
  const candidate = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };

  if (typeof candidate.transformToByteArray === "function") {
    return candidate.transformToByteArray();
  }

  if (typeof candidate[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of candidate as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  throw attachmentError(
    "storage_unavailable",
    "The stored object could not be read.",
  );
}

/** RFC 3986 path escaping for a `CopySource`, segment by segment. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
