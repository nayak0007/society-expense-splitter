import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider } from "@ses/domain";
import type postgres from "postgres";

import { STORAGE_PROVIDER } from "../../src/infrastructure/storage/storage.tokens";
import { resetData } from "../utils/integration-db";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";
import { STATE_FILE, type IntegrationState } from "./state";

/**
 * The storage layer, against a **real** local S3-compatible store — Roadmap T071.
 *
 * The Roadmap's own acceptance is "Presign, upload, complete flow works against
 * MinIO", and its test list names two claims no API-level test can demonstrate:
 * "Oversized upload rejected by the storage layer" and the 15-minute window. Both
 * are properties of the *object store's* response to a direct PUT, so this suite
 * speaks S3 itself and drives the real `S3StorageProvider` the API ships — through
 * the real environment, with no test-only storage seam.
 *
 * ## What each test would catch
 *
 * ```text
 *  exact signed length   → a body of another size is refused and no object is created
 *  the pin itself        → a URL minted without `content-length` in SignedHeaders
 *                          accepts anything (ADR-0012 D1 probe 11)
 *  omitted length        → 403 SignatureDoesNotMatch: the length is signed, so a
 *                          request that omits it cannot match — unlike an *unpinned*
 *                          URL, which answers 200 and stores a zero-byte object
 *                          (ADR-0012 probe 33)
 *  expiry                → a URL is a credential with a deadline
 *  private by default    → an unsigned GET is refused
 *  HEAD / DELETE         → the two operations completion and deletion depend on
 * ```
 *
 * ## Why the requests are hand-built
 *
 * `fetch` cannot express the three negative cases: it derives `Content-Length` from
 * the body, so a mismatched length is caught by the *client* and the server never
 * sees it — which would make a test that passes while the server-side gate is
 * removed. `node:http` is used instead so the header can deliberately disagree with
 * the payload, and so a request can be sent with no length at all.
 *
 * `node:http` still has one habit worth naming, because it silently defeated the first
 * version of this suite: given a single `Buffer` and no `Content-Length`, it computes
 * one from the body. The "omitted length" case therefore needs
 * `useChunkedEncodingByDefault = false`, or the test sends a header it believes it
 * did not send, gets a `200`, and asserts the wrong thing about the pin.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let storage: StorageProvider;
let rawS3: S3Client;
let state: IntegrationState;

beforeAll(async () => {
  // Read by the setup file too, and read again here because this suite needs the raw
  // facts to build its own client, while `process.env` is a stringly copy of them.
  state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as IntegrationState;

  harness = await startIntegrationHarness();
  owner = harness.owner;
  storage = harness.app.get<StorageProvider>(STORAGE_PROVIDER);

  rawS3 = new S3Client({
    endpoint: state.storageEndpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: state.storageAccessKeyId,
      secretAccessKey: state.storageSecretAccessKey,
    },
  });
}, 120_000);

afterAll(async () => {
  rawS3.destroy();
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

/** A key shaped like SAD §10.3's, so the objects live where real ones would. */
function keyFor(mime: string): string {
  return `societies/${randomUUID()}/expenses/${randomUUID()}/${randomUUID()}.${mime}`;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * A hand-built PUT whose declared length may deliberately disagree with the body.
 *
 * `declaredLength === undefined` sends no `Content-Length` at all, which makes the
 * request chunked — the case that must be refused with `411`, and the reason no
 * length is ever inferred from the body here.
 */
function putRaw(
  url: string,
  body: Buffer,
  options: {
    readonly declaredLength?: number | undefined;
    readonly contentType?: string;
    /** Send no `Content-Length` **and** no chunked framing. */
    readonly noLength?: boolean;
    /** Frame the body with `Transfer-Encoding: chunked` and no length. */
    readonly chunked?: boolean;
  } = {},
): Promise<RawResponse> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;

  const headers: Record<string, string> = {};
  if (options.declaredLength !== undefined) {
    headers["content-length"] = String(options.declaredLength);
  }
  if (options.contentType !== undefined) {
    headers["content-type"] = options.contentType;
  }
  if (options.chunked === true) {
    headers["transfer-encoding"] = "chunked";
  }

  return new Promise<RawResponse>((resolve, reject) => {
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "PUT",
        headers,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
      },
    );
    request.on("error", reject);

    // Without this, `end(buffer)` makes Node compute a `Content-Length` from the
    // body — the request would carry the very header the case under test omits.
    if (options.noLength === true) {
      request.useChunkedEncodingByDefault = false;
    }

    request.end(body);
  });
}

/** An unsigned GET — the request a caller without a presigned URL would make. */
function getRaw(url: string): Promise<RawResponse> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<RawResponse>((resolve, reject) => {
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

describe("the presigned PUT pins the exact length", () => {
  it("accepts a body of exactly the signed size and records it", async () => {
    const key = keyFor("jpg");
    const body = Buffer.alloc(1024, 0x41);

    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: body.byteLength,
      ttlSeconds: 900,
    });

    // The URL carries the pin and the wall-clock deadline.
    expect(presigned.url).toContain("X-Amz-SignedHeaders=content-length");
    expect(presigned.url).toContain("X-Amz-Expires=900");
    expect(presigned.requiredHeaders["Content-Length"]).toBe("1024");
    expect(presigned.requiredHeaders["Content-Type"]).toBe("image/jpeg");

    const response = await putRaw(presigned.url, body, {
      declaredLength: body.byteLength,
      contentType: "image/jpeg",
    });
    expect(response.status).toBe(200);

    const head = await storage.head(key);
    expect(head).not.toBeNull();
    expect(head?.contentLength).toBe(1024);
  });

  it("refuses a larger body and creates no object", async () => {
    const key = keyFor("jpg");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: 1024,
      ttlSeconds: 900,
    });

    const response = await putRaw(presigned.url, Buffer.alloc(2048, 0x42), {
      declaredLength: 2048,
      contentType: "image/jpeg",
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain("SignatureDoesNotMatch");
    // The bit that matters most: a refused request leaves **no** object behind, so
    // the completion path can never find bytes the reservation did not authorise.
    expect(await storage.head(key)).toBeNull();
  });

  it("refuses a smaller body and creates no object", async () => {
    const key = keyFor("jpg");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: 1024,
      ttlSeconds: 900,
    });

    const response = await putRaw(presigned.url, Buffer.alloc(512, 0x43), {
      declaredLength: 512,
      contentType: "image/jpeg",
    });

    expect(response.status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it("refuses a request that omits Content-Length entirely", async () => {
    const key = keyFor("jpg");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: 1024,
      ttlSeconds: 900,
    });

    // No `declaredLength` → no `Content-Length` is sent, and Node is told not to
    // substitute chunked framing either. The header is *signed*, so the refusal is a
    // signature failure rather than a "length required": a client cannot drop the
    // header that carries the size gate, which is a stronger answer than `411` —
    // measured on this image as `403 SignatureDoesNotMatch` (ADR-0012 probe 29).
    const response = await putRaw(presigned.url, Buffer.alloc(1024, 0x44), {
      contentType: "image/jpeg",
      noLength: true,
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain("SignatureDoesNotMatch");
    expect(await storage.head(key)).toBeNull();
  });

  it("refuses a chunked request rather than streaming an unbounded body", async () => {
    const key = keyFor("jpg");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: 1024,
      ttlSeconds: 900,
    });

    // The other unframed shape: `Transfer-Encoding: chunked`. The store answers
    // `400 BadRequest` and creates nothing (ADR-0012 probe 30) — neither a chunked
    // body nor an omitted header can reach the object, which is the property the
    // completion path depends on when it looks for bytes the reservation authorised.
    const response = await putRaw(presigned.url, Buffer.alloc(1024, 0x45), {
      contentType: "image/jpeg",
      chunked: true,
    });

    expect(response.status).toBe(400);
    expect(await storage.head(key)).toBeNull();
  });

  it("mints a URL whose signed header set is the pin and nothing else", async () => {
    const presigned = await storage.presignUpload({
      storageKey: keyFor("jpg"),
      contentType: "image/jpeg",
      contentLength: 1024,
      ttlSeconds: 900,
    });

    const url = new URL(presigned.url);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host",
    );
    // The SDK's default would attach an unsigned `x-amz-checksum-crc32` of an
    // *empty* body — a value that verifies nothing and is one more vendor-specific
    // extra for a non-MinIO provider to reject (ADR-0012 probe 36). Asserted here so
    // turning it back on is a test failure rather than a surprise in staging.
    expect(presigned.url).not.toContain("x-amz-checksum");
    expect(presigned.url).not.toContain("x-amz-sdk-checksum-algorithm");
  });

  it("would accept anything at all from an unpinned URL — which is why the pin is not optional", async () => {
    // The counterfactual, and the reason `signableHeaders` exists in the adapter:
    // this URL is minted by the *same SDK* for the *same command* with the same
    // `ContentLength`, differing only in the absence of the pin. A body 1024 times
    // the declared size is accepted, and the store records it — so "the client sent
    // sizeBytes" would be an honour-system gate. It is a *measurement reproduction*
    // rather than a guard: it uses its own URL and would keep passing if the
    // adapter's pin were removed, which is exactly why the pin has to be asserted
    // where it lives — in the URL's header set, above, and in the API's own size gate.
    const key = keyFor("jpg");
    const unpinned = await getSignedUrl(
      rawS3,
      new PutObjectCommand({
        Bucket: state.storageBucket,
        Key: key,
        ContentType: "image/jpeg",
        // `ContentLength` is omitted *entirely*, and that is the only way to build
        // this control: the SDK signs `content-length` whenever the command carries
        // it, with or without `signableHeaders`, so passing a declared length here
        // would produce the pinned URL and measure nothing.
      }),
      { expiresIn: 900 },
    );
    expect(new URL(unpinned).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "host",
    );

    const response = await putRaw(unpinned, Buffer.alloc(1024 * 1024, 0x4b), {
      declaredLength: 1024 * 1024,
      contentType: "image/jpeg",
    });

    expect(response.status).toBe(200);
    const head = await storage.head(key);
    expect(head?.contentLength).toBe(1024 * 1024);
    await rawS3.send(
      new DeleteObjectCommand({ Bucket: state.storageBucket, Key: key }),
    );
  }, 30_000);

  it("refuses an oversized object even when the URL was minted for the maximum", async () => {
    // The Roadmap's own sentence — "oversized upload rejected by the storage layer"
    // — applied to the largest size the product accepts: a body one byte past the
    // signed 10 MB is still refused, because the gate is the signature and not a
    // magic number a client could stay under.
    const key = keyFor("pdf");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "application/pdf",
      contentLength: 10 * 1024 * 1024,
      ttlSeconds: 900,
    });

    const response = await putRaw(
      presigned.url,
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x25),
      { declaredLength: 10 * 1024 * 1024 + 1, contentType: "application/pdf" },
    );

    expect(response.status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  }, 60_000);
});

describe("the credential is time-limited and the object is private", () => {
  it("refuses an expired presigned URL", async () => {
    const key = keyFor("jpg");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: 16,
      ttlSeconds: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const response = await putRaw(presigned.url, Buffer.alloc(16, 0x45), {
      declaredLength: 16,
      contentType: "image/jpeg",
    });

    expect(response.status).toBe(403);
    // "Expired" specifically, not a generic refusal: the signature is valid and the
    // grant has simply run out.
    expect(response.body.toLowerCase()).toContain("expired");
    expect(await storage.head(key)).toBeNull();
  }, 30_000);

  it("refuses an unsigned object GET", async () => {
    const key = keyFor("jpg");
    const body = Buffer.alloc(32, 0x46);
    await rawS3.send(
      new PutObjectCommand({
        Bucket: state.storageBucket,
        Key: key,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );

    // The bucket is private by default and no public policy is ever set (PRD
    // §11.4: signed URLs only, no public buckets) — so the bare object URL is a
    // refusal, which is the property a client cannot obtain by guessing a key.
    const response = await getRaw(
      `${state.storageEndpoint}/${state.storageBucket}/${key}`,
    );
    expect(response.status).toBe(403);
  });

  it("serves the object only through a presigned GET", async () => {
    const key = keyFor("png");
    const body = Buffer.alloc(64, 0x47);
    await rawS3.send(
      new PutObjectCommand({
        Bucket: state.storageBucket,
        Key: key,
        Body: body,
        ContentType: "image/png",
      }),
    );

    // `presignDownload` ships with no route (ADR-0012 D4) but is a port capability
    // SAD §10.2 names, and this is the one place it is exercised.
    const url = await storage.presignDownload(key, 900);
    const response = await getRaw(url);
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(64);
  });
});

describe("HEAD and DELETE", () => {
  it("answers null for a missing object rather than throwing", async () => {
    expect(await storage.head(keyFor("jpg"))).toBeNull();
    expect(await storage.readObject(keyFor("jpg"))).toBeNull();
  });

  it("removes the object and then reports it missing", async () => {
    const key = keyFor("jpg");
    const presigned = await storage.presignUpload({
      storageKey: key,
      contentType: "image/jpeg",
      contentLength: 8,
      ttlSeconds: 900,
    });
    await putRaw(presigned.url, Buffer.alloc(8, 0x48), {
      declaredLength: 8,
      contentType: "image/jpeg",
    });

    const stored = await storage.readObject(key);
    expect(stored?.bytes.byteLength).toBe(8);

    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();

    // Idempotent by construction: S3 answers 204 for a key that never existed, which
    // is what the delete use case's retry path relies on.
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it("copies server-side, without the bytes passing through this process", async () => {
    const from = keyFor("jpg");
    const to = keyFor("jpg");
    const body = Buffer.alloc(16, 0x49);
    await rawS3.send(
      new PutObjectCommand({
        Bucket: state.storageBucket,
        Key: from,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );

    await storage.copy(from, to);
    const copied = await storage.readObject(to);
    expect(copied?.contentLength).toBe(16);
    await rawS3.send(
      new DeleteObjectCommand({ Bucket: state.storageBucket, Key: to }),
    );
  });

  it("presigns a GET for an object that does not exist, and the GET then fails", async () => {
    // A signature is a grant, not a proof of existence — worth asserting so nobody
    // builds a "the object is there" check on presign instead of HEAD.
    const url = await storage.presignDownload(keyFor("jpg"), 900);
    expect(url).toContain("X-Amz-Signature");
    const response = await getRaw(url);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a URL whose signed path has been rewritten to another object", async () => {
    // A signature is bound to the object it names, so editing the path of a valid
    // grant must not read a different object — which is the property that makes the
    // key layout's tenant prefix meaningful rather than cosmetic.
    const readable = keyFor("jpg");
    const tampered = keyFor("jpg");
    await rawS3.send(
      new PutObjectCommand({
        Bucket: state.storageBucket,
        Key: tampered,
        Body: Buffer.alloc(4, 0x4a),
        ContentType: "image/jpeg",
      }),
    );

    const signed = await getSignedUrl(
      rawS3,
      new GetObjectCommand({ Bucket: state.storageBucket, Key: readable }),
      { expiresIn: 900 },
    );

    const rewritten = signed.replace(readable, tampered);
    const response = await getRaw(rewritten);
    expect(response.status).toBe(403);
  });
});
