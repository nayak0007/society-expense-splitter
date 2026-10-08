import { createHash } from "node:crypto";

import {
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  attachmentError,
  err,
  ok,
} from "@ses/domain";
import type {
  AttachmentError,
  AttachmentExpenseSnapshot,
  AttachmentMembershipReader,
  AttachmentRecord,
  AttachmentRepository,
  ExpenseId,
  MemberId,
  Result,
  SocietyId,
  SocietyMembership,
  StorageObjectMetadata,
  StorageProvider,
  StoredObject,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { CompleteUploadUseCase } from "../complete-upload.use-case";

/**
 * The completion use case over contract doubles — Roadmap T071, ADR-0012 D4.
 *
 * ## What this file is for
 *
 * Completion is the step that decides whether the bytes a device put in the bucket
 * are the file the API promised to accept, and it decides it from evidence rather
 * than from anything the upload said. Most of that decision is pure orchestration
 * and can be pinned here, in order:
 *
 * ```text
 *   the request's checksum must equal the reserved row's   (before any storage I/O)
 *   the object must exist                                  (HEAD)
 *   the object must be the reserved length                 (HEAD)
 *   its SHA-256 must be the reserved checksum              (computed here, not the ETag)
 *   its magic bytes must be the row's declared type        (the extension is not)
 *   a completed upload replays as a 200 no-op              (the repository's answer)
 * ```
 *
 * The other claims — that the row is invisible across societies, that the conditional
 * `UPDATE` is one statement under RLS, that a concurrent completion loses the race and
 * still answers 200, and that `scan_status` is never widened — need PostgreSQL and are
 * asserted in `test/integration/attachments.integration-spec.ts`.
 *
 * ## What the doubles deliberately do not do
 *
 * They record *order* (which of `head`/`readObject`/`markComplete` was reached) and
 * they can answer each failure a caller must meet. They contain no rule: every refusal
 * asserted below is raised by production code.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const ATTACHMENT = "30000000-0000-4000-8000-000000000001";

const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const COMMITTEE_MEMBER = asMemberId("10000000-0000-4000-8000-000000000007");
const RESIDENT_MEMBER = asMemberId("10000000-0000-4000-8000-000000000003");
const SOMEBODY_ELSE = asMemberId("10000000-0000-4000-8000-000000000099");

const KEY = `societies/${SOCIETY}/expenses/${EXPENSE}/${ATTACHMENT}.jpg`;

/** Bytes whose magic number is genuinely a JPEG's. */
function jpeg(size = 64): Buffer {
  const body = Buffer.alloc(size, 0x41);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[3] = 0xe0;
  return body;
}

function pdf(size = 64): Buffer {
  const body = Buffer.alloc(size, 0x20);
  body.write("%PDF-1.7", 0, "ascii");
  return body;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function membershipOf(
  actor: UserId,
  role: SocietyMembership["role"],
  id: MemberId,
  societyId: SocietyId = SOCIETY,
): SocietyMembership {
  return {
    id,
    societyId,
    userId: actor,
    role,
    status: "active",
    occupancyType: "owner",
    joinedAt: null,
  };
}

const ADMIN_MEMBERSHIP = membershipOf(ADMIN, "admin", ADMIN_MEMBER);
const COMMITTEE_MEMBERSHIP = membershipOf(
  COMMITTEE,
  "committee_member",
  COMMITTEE_MEMBER,
);
const RESIDENT_MEMBERSHIP = membershipOf(RESIDENT, "resident", RESIDENT_MEMBER);
/** The same person, a member of somebody else's society. */
const ADMIN_ELSEWHERE = membershipOf(
  ADMIN,
  "admin",
  ADMIN_MEMBER,
  OTHER_SOCIETY,
);

class FakeMemberships implements AttachmentMembershipReader {
  readonly memberships = new Map<string, SocietyMembership>();

  seed(membership: SocietyMembership): void {
    this.memberships.set(
      `${membership.societyId}:${membership.userId}`,
      membership,
    );
  }

  findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null> {
    return Promise.resolve(
      this.memberships.get(`${societyId}:${actor}`) ?? null,
    );
  }
}

/** The repository's answers, and the order it was asked in. */
class FakeAttachments implements AttachmentRepository {
  expense: AttachmentExpenseSnapshot | null = null;
  row: AttachmentRecord | null = null;
  /** Set to make `markComplete` refuse — the void race the integration suite runs. */
  completeFailure: AttachmentError | null = null;
  readonly markedComplete: string[] = [];

  findExpenseForAttachment(
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<AttachmentExpenseSnapshot | null> {
    const candidate = this.expense;
    if (candidate === null) return Promise.resolve(null);
    const visible =
      candidate.societyId === societyId && candidate.id === expenseId;
    return Promise.resolve(visible ? candidate : null);
  }

  readSocietySubscriptionPlan(): Promise<string | null> {
    return Promise.resolve("free");
  }

  reserve(): Promise<Result<AttachmentRecord, AttachmentError>> {
    return Promise.reject(new Error("completion never reserves"));
  }

  findById(
    attachmentId: string,
    societyId: SocietyId,
  ): Promise<AttachmentRecord | null> {
    const candidate = this.row;
    if (candidate === null) return Promise.resolve(null);
    // The society predicate is the repository's, and the whole reason a
    // cross-society id is a 404 rather than a distinguishable refusal.
    const visible =
      candidate.id === attachmentId && candidate.societyId === societyId;
    return Promise.resolve(visible ? candidate : null);
  }

  // T073's read: completion never lists an expense's bills.
  listCompletedForExpense(): Promise<readonly AttachmentRecord[]> {
    return Promise.resolve([]);
  }

  markComplete(
    attachmentId: string,
  ): Promise<Result<AttachmentRecord, AttachmentError>> {
    this.markedComplete.push(attachmentId);
    if (this.completeFailure !== null) {
      return Promise.resolve(err(this.completeFailure));
    }
    const row = this.row!;
    // A replay answers the row as it stands: already complete stays complete, which
    // is why the use case can report the same success without a second branch.
    return Promise.resolve(
      ok({
        ...row,
        completedAt: row.completedAt ?? "2026-10-07T10:05:00.000Z",
      }),
    );
  }

  deleteById(): Promise<void> {
    return Promise.resolve();
  }

  listStorageKeysForExpense(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

interface StoreDoubles {
  head?: () => Promise<StorageObjectMetadata | null>;
  read?: () => Promise<StoredObject | null>;
}

/** The store's answers, and whether it was asked at all. */
class FakeStorage implements StorageProvider {
  headResult: StorageObjectMetadata | null = null;
  object: StoredObject | null = null;
  /** Set to answer a specific failure instead of the canned result. */
  headOverride: StoreDoubles["head"] = undefined;
  readOverride: StoreDoubles["read"] = undefined;
  readonly heads: string[] = [];
  readonly reads: string[] = [];

  presignUpload(): Promise<never> {
    return Promise.reject(new Error("completion never presigns"));
  }

  presignDownload(): Promise<string> {
    return Promise.resolve("https://store.test/download");
  }

  head(key: string): Promise<StorageObjectMetadata | null> {
    this.heads.push(key);
    if (this.headOverride !== undefined) return this.headOverride();
    return Promise.resolve(this.headResult);
  }

  readObject(key: string): Promise<StoredObject | null> {
    this.reads.push(key);
    if (this.readOverride !== undefined) return this.readOverride();
    return Promise.resolve(this.object);
  }

  copy(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

interface World {
  readonly useCase: CompleteUploadUseCase;
  readonly attachments: FakeAttachments;
  readonly storage: FakeStorage;
  readonly memberships: FakeMemberships;
}

/**
 * One society with a draft, an Admin, a Committee Member, a Resident and one
 * reserved-but-not-completed attachment holding `bytes` under `mimeType`.
 */
function build(options: { bytes?: Buffer; mimeType?: string } = {}): World {
  const bytes = options.bytes ?? jpeg();
  const mimeType = options.mimeType ?? "image/jpeg";

  const attachments = new FakeAttachments();
  const storage = new FakeStorage();
  const memberships = new FakeMemberships();

  memberships.seed(ADMIN_MEMBERSHIP);
  memberships.seed(COMMITTEE_MEMBERSHIP);
  memberships.seed(RESIDENT_MEMBERSHIP);

  attachments.expense = {
    id: EXPENSE,
    societyId: SOCIETY,
    status: "draft",
    createdBy: ADMIN_MEMBER,
  };
  attachments.row = {
    id: ATTACHMENT,
    societyId: SOCIETY,
    entityType: "expense",
    entityId: EXPENSE,
    storageKey: KEY,
    originalFilename: "bill.jpg",
    mimeType,
    sizeBytes: bytes.byteLength,
    checksum: sha256(bytes),
    uploadedBy: ADMIN_MEMBER,
    scanStatus: "pending",
    completedAt: null,
    createdAt: "2026-10-07T10:00:00.000Z",
  };

  storage.headResult = {
    contentLength: bytes.byteLength,
    contentType: mimeType,
    etag: "an-md5-that-is-not-a-sha256",
  };
  storage.object = {
    bytes,
    contentLength: bytes.byteLength,
    contentType: mimeType,
    etag: "an-md5-that-is-not-a-sha256",
  };

  return {
    useCase: new CompleteUploadUseCase(attachments, storage, memberships),
    attachments,
    storage,
    memberships,
  };
}

/** The thrown `AppError`, for asserting the code, the status and the payload. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as AppError;
  }
  throw new Error("expected the use case to refuse");
}

function declare(world: World, checksum?: string) {
  return world.useCase.complete(ADMIN, SOCIETY, ATTACHMENT, {
    checksum: checksum ?? world.attachments.row!.checksum,
  });
}

describe("the order of the refusals", () => {
  it("answers 404 for a caller with no membership, before reading the row", async () => {
    const world = build();
    world.memberships.memberships.clear();
    world.memberships.seed(RESIDENT_MEMBERSHIP);

    const error = await failure(declare(world));

    expect(error.code).toBe("NOT_FOUND");
    expect(world.attachments.markedComplete).toHaveLength(0);
    expect(world.storage.heads).toHaveLength(0);
  });

  it("answers 404 for an attachment id this society does not hold", async () => {
    const world = build();
    world.attachments.row = null;

    const error = await failure(declare(world, "a".repeat(64)));

    expect(error.code).toBe("NOT_FOUND");
    expect(world.storage.heads).toHaveLength(0);
  });

  it("answers 404 for a row in another society — the same answer as absent", async () => {
    const world = build();
    // The same person, a member of the other society too, holding the same member
    // id. The membership gate passes and the row's society predicate is the only
    // thing left, which is exactly the claim under test.
    world.memberships.seed(ADMIN_ELSEWHERE);

    const error = await failure(
      world.useCase.complete(ADMIN, OTHER_SOCIETY, ATTACHMENT, {
        checksum: world.attachments.row!.checksum,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
    expect(world.storage.heads).toHaveLength(0);
  });

  it("answers 404 when the parent expense is gone, before any storage traffic", async () => {
    const world = build();
    world.attachments.expense = null;

    const error = await failure(declare(world));

    expect(error.code).toBe("NOT_FOUND");
    expect(world.storage.heads).toHaveLength(0);
  });

  it("refuses a void parent outright, at the lifecycle gate", async () => {
    const world = build();
    world.attachments.expense = {
      ...world.attachments.expense!,
      status: "void",
    };

    const error = await failure(declare(world));

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.status).toBe(409);
    expect(world.storage.heads).toHaveLength(0);
  });

  it("fails closed on a status the domain has never heard of", async () => {
    const world = build();
    world.attachments.expense = {
      ...world.attachments.expense!,
      status: "archived",
    };

    expect((await failure(declare(world))).code).toBe("INVALID_TRANSITION");
  });

  it("refuses a Resident at the permission cell before touching the store", async () => {
    const world = build();

    const error = await failure(
      world.useCase.complete(RESIDENT, SOCIETY, ATTACHMENT, {
        checksum: world.attachments.row!.checksum,
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(world.storage.heads).toHaveLength(0);
  });

  it("refuses a Committee Member a submitted expense they did not author", async () => {
    const world = build();
    world.attachments.expense = {
      ...world.attachments.expense!,
      status: "pending_approval",
      createdBy: SOMEBODY_ELSE,
    };

    // `expense.create`'s scoped rule is `!published` and has no ownership clause at
    // all, so a *submitted* expense is refused whoever wrote it — the same cell the
    // presign suite asserts, reached through completion's own copy of the gate.
    const error = await failure(
      world.useCase.complete(COMMITTEE, SOCIETY, ATTACHMENT, {
        checksum: world.attachments.row!.checksum,
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(world.storage.heads).toHaveLength(0);
  });
});

describe("the checksum the caller declares", () => {
  it("refuses a request whose checksum is not the reserved one, without reading the object", async () => {
    const world = build();

    const error = await failure(declare(world, "b".repeat(64)));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(error.payload.field).toBe("checksum");
    // The decisive half: no HEAD, so completion cannot be used to probe what a
    // reservation points at.
    expect(world.storage.heads).toHaveLength(0);
    expect(world.storage.reads).toHaveLength(0);
  });

  it("refuses a malformed checksum as a validation failure naming the field", async () => {
    const world = build();

    const error = await failure(declare(world, "not-a-digest"));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("checksum");
  });

  it("accepts an uppercase checksum, because hex is case-insensitive", async () => {
    const world = build();
    const upper = world.attachments.row!.checksum.toUpperCase();

    await expect(declare(world, upper)).resolves.toMatchObject({
      status: "processing",
    });
  });
});

describe("the stored object", () => {
  it("409s when nothing was uploaded", async () => {
    const world = build();
    world.storage.headResult = null;

    const error = await failure(declare(world));

    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    expect(world.storage.reads).toHaveLength(0);
    expect(world.attachments.markedComplete).toHaveLength(0);
  });

  it("409s when the object is not the size that was reserved", async () => {
    const world = build();
    world.storage.headResult = {
      contentLength: world.attachments.row!.sizeBytes + 1,
      contentType: "image/jpeg",
      etag: null,
    };

    const error = await failure(declare(world));

    expect(error.code).toBe("CONFLICT");
    // The size disagreement is conclusive on its own, so the bytes are never fetched.
    expect(world.storage.reads).toHaveLength(0);
  });

  it("409s when the object vanished between HEAD and the read", async () => {
    const world = build();
    world.storage.object = null;

    const error = await failure(declare(world));

    expect(error.code).toBe("CONFLICT");
    expect(world.attachments.markedComplete).toHaveLength(0);
  });

  it("maps an unreachable store to 503 rather than a 500", async () => {
    const world = build();
    world.storage.headOverride = () =>
      Promise.reject(
        attachmentError("storage_unavailable", "the store is unreachable"),
      );

    const error = await failure(declare(world));

    // The adapter already separated an outage from a refusal; letting it escape
    // unmapped would report this API's own defect and defeat a client's retry.
    expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(error.status).toBe(503);
  });
});

describe("the bytes decide, not the metadata", () => {
  it("refuses bytes whose digest is not the reserved checksum", async () => {
    const world = build();
    const size = world.attachments.row!.sizeBytes;
    const tampered = jpeg();
    tampered[40] = 0x7a;

    // Same length, same declared type, one different byte — so the length gate
    // passes and only the digest can catch it.
    expect(tampered.byteLength).toBe(size);
    expect(sha256(tampered)).not.toBe(world.attachments.row!.checksum);
    world.storage.object = {
      bytes: tampered,
      contentLength: size,
      contentType: "image/jpeg",
      etag: null,
    };

    const error = await failure(declare(world));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(world.attachments.markedComplete).toHaveLength(0);
  });

  it("refuses a .jpg whose stored bytes are a PDF — the Roadmap's own test", async () => {
    const body = pdf();
    const world = build({ bytes: body, mimeType: "image/jpeg" });
    // The checksum agrees with the row's, so this can only be the magic number.
    expect(world.attachments.row!.checksum).toBe(sha256(body));

    const error = await failure(declare(world));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.details?.[0]?.code).toBe("CONTENT_MISMATCH");
    expect(world.attachments.markedComplete).toHaveLength(0);
  });

  it("refuses the reverse mismatch: a declared PDF whose bytes are a JPEG", async () => {
    const world = build({ bytes: jpeg(), mimeType: "application/pdf" });

    const error = await failure(declare(world));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(world.attachments.markedComplete).toHaveLength(0);
  });

  it("ignores the ETag rather than treating it as a digest", async () => {
    const world = build();

    // `readObject` still returns the ETag; nothing compares it. An S3 ETag is an MD5
    // for a single-part upload and something else for a multipart one, so trusting it
    // would pass a wrong file exactly when the file is large.
    await expect(declare(world)).resolves.toMatchObject({
      status: "processing",
    });
  });
});

describe("the completion stamp", () => {
  it("answers `processing` and never `clean`, and leaves scan_status alone", async () => {
    const world = build();

    const result = await declare(world);

    expect(result.status).toBe("processing");
    expect(world.attachments.markedComplete).toEqual([ATTACHMENT]);
    // The repository writes `completed_at` and nothing else — no grant admits
    // `scan_status` — so with no scanner having run, the row is still `pending`.
    expect(result.attachment.scanStatus).toBe("pending");
    expect(result.attachment.completedAt).toBe("2026-10-07T10:05:00.000Z");
  });

  it("replays an already-complete upload as the same 200 answer", async () => {
    const world = build();
    world.attachments.row = {
      ...world.attachments.row!,
      completedAt: "2026-10-07T10:04:00.000Z",
    };

    const result = await declare(world);

    // ADR-0012: not a 409. A client whose response was lost has no way to tell a
    // lost reply from a lost request, so refusing it would strand a real upload.
    expect(result.status).toBe("processing");
    expect(result.attachment.completedAt).toBe("2026-10-07T10:04:00.000Z");
  });

  it("reports a row the policy refused as an invalid transition, not a 403", async () => {
    const world = build();
    world.attachments.completeFailure = attachmentError(
      "forbidden",
      "the row's own policy refused",
    );

    const error = await failure(declare(world));

    // The expense moved to `void` between the gate and the write. The caller was
    // allowed to see the row, so the honest answer is the state, not the permission.
    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.status).toBe(409);
  });

  it("passes any other repository failure through with its own classification", async () => {
    const world = build();
    world.attachments.completeFailure = attachmentError(
      "storage_unavailable",
      "the store is unreachable",
    );

    const error = await failure(declare(world));

    expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(error.status).toBe(503);
  });
});
