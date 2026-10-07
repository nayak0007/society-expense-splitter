import { ConfigService } from "@nestjs/config";
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
  PresignUploadRequest,
  PresignedUpload,
  ReserveAttachmentInput,
  Result,
  SocietyId,
  SocietyMembership,
  StorageProvider,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { AppConfig } from "../../../../../config/app-config";
import type { Env } from "../../../../../config/validation.schema";
import { PresignUploadUseCase } from "../presign-upload.use-case";

/**
 * The presign use case over contract doubles — Roadmap T071.
 *
 * ## What is real here, and what is doubled
 *
 * The doubles implement the two ports' contracts and none of the rules: the fake
 * repository records what it was asked to reserve and can answer the three failures a
 * caller must meet (no expense, no readable plan, a quota refusal), and the fake store
 * signs a URL without a bucket. Everything that decides anything — the order of the
 * refusals, the fail-closed unpriced plan, the server-minted id, the key builder and
 * the four MIME rules — is production code, so a regression in the domain or in the
 * orchestration fails here.
 *
 * What only the integration suite can prove is the other half: that the lock, the sum
 * and the insert are one transaction, that the insert policy's key-prefix assertion
 * holds, that a concurrent burst cannot over-reserve, and that the URL the real SDK
 * mints pins the size. Those are asserted against PostgreSQL and a real object store;
 * this file pins the ordering, the error mapping and the compensation.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const ABSENT_EXPENSE = asExpenseId("20000000-0000-4000-8000-0000000000ff");
const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const COMMITTEE_MEMBER = asMemberId("10000000-0000-4000-8000-000000000007");
const RESIDENT_MEMBER = asMemberId("10000000-0000-4000-8000-000000000003");

const CHECKSUM = "a".repeat(64);

function membershipOf(
  actor: UserId,
  role: SocietyMembership["role"],
  id: MemberId,
): SocietyMembership {
  return {
    id,
    societyId: SOCIETY,
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

/** The repository's decisions, without its SQL. */
class FakeAttachments implements AttachmentRepository {
  readonly expenses = new Map<string, AttachmentExpenseSnapshot>();
  readonly plans = new Map<string, string>();
  readonly reservations: ReserveAttachmentInput[] = [];
  readonly refusals: Result<AttachmentRecord, AttachmentError>[] = [];
  readonly deleted: string[] = [];
  deleteThrows = false;

  findExpenseForAttachment(
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<AttachmentExpenseSnapshot | null> {
    return Promise.resolve(
      this.expenses.get(`${societyId}:${expenseId}`) ?? null,
    );
  }

  readSocietySubscriptionPlan(societyId: SocietyId): Promise<string | null> {
    return Promise.resolve(this.plans.get(societyId) ?? null);
  }

  reserve(
    input: ReserveAttachmentInput,
  ): Promise<Result<AttachmentRecord, AttachmentError>> {
    this.reservations.push(input);
    return Promise.resolve(this.refusals.shift() ?? ok(recordFrom(input)));
  }

  findById(): Promise<AttachmentRecord | null> {
    return Promise.resolve(null);
  }

  markComplete(
    attachmentId: string,
  ): Promise<Result<AttachmentRecord, AttachmentError>> {
    const input = this.reservations.find(
      (candidate) => idFromKey(candidate.storageKey) === attachmentId,
    );
    return Promise.resolve(ok(recordFrom(input ?? this.reservations[0]!)));
  }

  deleteById(attachmentId: string): Promise<void> {
    if (this.deleteThrows) return Promise.reject(new Error("delete failed"));
    this.deleted.push(attachmentId);
    return Promise.resolve();
  }

  listStorageKeysForExpense(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

function idFromKey(storageKey: string): string {
  return storageKey
    .split("/")
    .pop()!
    .replace(/\.[a-z0-9]+$/, "");
}

function recordFrom(input: ReserveAttachmentInput): AttachmentRecord {
  return {
    // The row's id and the key's name are one value — the property the integration
    // suite asserts against the stored row.
    id: input.id,
    societyId: input.societyId,
    entityType: input.entityType,
    entityId: input.entityId,
    storageKey: input.storageKey,
    originalFilename: input.originalFilename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    checksum: input.checksum,
    uploadedBy: input.uploadedBy,
    scanStatus: "pending",
    completedAt: null,
    createdAt: "2026-10-07T10:00:00.000Z",
  };
}

class FakeStorage implements StorageProvider {
  readonly presigns: PresignUploadRequest[] = [];
  failure: AttachmentError | null = null;

  presignUpload(request: PresignUploadRequest): Promise<PresignedUpload> {
    this.presigns.push({ ...request });
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve({
      url: `https://store.test/${request.storageKey}?signed=yes`,
      storageKey: request.storageKey,
      expiresAt: "2026-10-07T10:15:00.000Z",
      requiredHeaders: {
        "Content-Length": String(request.contentLength),
        "Content-Type": request.contentType,
      },
    });
  }

  presignDownload(): Promise<string> {
    return Promise.resolve("https://store.test/download");
  }

  head(): Promise<null> {
    return Promise.resolve(null);
  }

  readObject(): Promise<null> {
    return Promise.resolve(null);
  }

  copy(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `AppConfig` over a `ConfigService` seeded with the storage defaults.
 *
 * Seeded explicitly rather than left to the schema, because `getOrThrow` is what
 * these accessors use and an unset key throws *inside* the use case's `try` — where
 * it would be mistaken for a storage outage. The numbers are the schema's own
 * defaults; the reader can check them against `validation.schema.ts`.
 */
function configWith(values: Record<string, unknown> = {}): AppConfig {
  return new AppConfig(
    new ConfigService<Env, true>({
      NODE_ENV: "test",
      STORAGE_PROVIDER: "minio",
      STORAGE_BUCKET: "ses-attachments",
      STORAGE_REGION: "us-east-1",
      STORAGE_FORCE_PATH_STYLE: true,
      STORAGE_AUTO_CREATE_BUCKET: false,
      STORAGE_PRESIGN_TTL_SECONDS: 900,
      ...values,
    }),
  );
}

const COMMAND = {
  fileName: "bill.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 1024,
  checksum: CHECKSUM,
};

interface World {
  readonly useCase: PresignUploadUseCase;
  readonly attachments: FakeAttachments;
  readonly storage: FakeStorage;
  readonly memberships: FakeMemberships;
}

function build(values: Record<string, unknown> = {}): World {
  const attachments = new FakeAttachments();
  const storage = new FakeStorage();
  const memberships = new FakeMemberships();

  // The default world: an Admin of a Free-plan society, a Committee Member, a
  // Resident, and one draft to attach to.
  memberships.seed(ADMIN_MEMBERSHIP);
  memberships.seed(COMMITTEE_MEMBERSHIP);
  memberships.seed(RESIDENT_MEMBERSHIP);
  attachments.plans.set(SOCIETY, "free");
  seedExpense(attachments, SOCIETY, "draft", ADMIN_MEMBER);

  return {
    useCase: new PresignUploadUseCase(
      attachments,
      storage,
      memberships,
      configWith(values),
    ),
    attachments,
    storage,
    memberships,
  };
}

function seedExpense(
  attachments: FakeAttachments,
  societyId: SocietyId,
  status: string,
  createdBy: MemberId,
  expenseId: ExpenseId = EXPENSE,
): void {
  attachments.expenses.set(`${societyId}:${expenseId}`, {
    id: expenseId,
    societyId,
    status,
    createdBy,
  });
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

describe("the order of the refusals", () => {
  it("answers 404 for a caller with no membership, before reading anything else", async () => {
    const world = build();
    world.memberships.memberships.clear();
    world.memberships.seed(RESIDENT_MEMBERSHIP);
    world.attachments.expenses.clear();

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(world.attachments.reservations).toHaveLength(0);
    expect(world.storage.presigns).toHaveLength(0);
  });

  it("answers 404 for an expense that is not there, without touching the plan", async () => {
    const world = build();
    world.attachments.plans.clear();

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, ABSENT_EXPENSE, COMMAND),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(world.storage.presigns).toHaveLength(0);
  });

  it("refuses a void expense for everybody, Admin included", async () => {
    const world = build();
    seedExpense(world.attachments, SOCIETY, "void", ADMIN_MEMBER);

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.status).toBe(409);
    expect(world.attachments.reservations).toHaveLength(0);
  });

  it("fails closed on a status the domain has never heard of", async () => {
    const world = build();
    seedExpense(world.attachments, SOCIETY, "archived", ADMIN_MEMBER);

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a Resident at the permission cell before examining the file", async () => {
    const world = build();

    const error = await failure(
      world.useCase.presign(RESIDENT, SOCIETY, EXPENSE, {
        ...COMMAND,
        mimeType: "application/x-msdownload",
      }),
    );

    // The permission refusal is reached first, so a Resident learns nothing about
    // which types are accepted — the ordering every other route in the API keeps.
    expect(error.code).toBe("FORBIDDEN");
  });

  it("lets a Committee Member attach to a draft they did not author", async () => {
    const world = build();
    seedExpense(world.attachments, SOCIETY, "draft", ADMIN_MEMBER);

    // The cell is 🟡 **draft only**, not "own drafts" (PRD §2.1: "Create expense |
    // ✅ | ✅ | 🟡 (draft only)"), so the narrowing reads the record's *state* and not
    // its author — a Committee Member may add a bill to a colleague's draft. The
    // ownership reading belongs to `expense.void`, which is the cell delete uses.
    const result = await world.useCase.presign(
      COMMITTEE,
      SOCIETY,
      EXPENSE,
      COMMAND,
    );

    expect(result.storageKey).toContain(`/expenses/${EXPENSE}/`);
  });

  it("refuses a Committee Member a pending_approval expense, their own included", async () => {
    const world = build();
    seedExpense(
      world.attachments,
      SOCIETY,
      "pending_approval",
      COMMITTEE_MEMBER,
    );

    // A submitted expense is not a draft, and `published` on the resource snapshot is
    // `status !== 'draft'` — so the 🟡 cell closes for the author too. That is the
    // stricter of the two readings, which is the one every 🟡 site takes.
    const error = await failure(
      world.useCase.presign(COMMITTEE, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("refuses a Committee Member a published expense, even though published ones accept attachments", async () => {
    const world = build();
    seedExpense(world.attachments, SOCIETY, "published", ADMIN_MEMBER);

    // The lifecycle gate lets a published expense take a bill (ADR-0012 D6.1); the
    // permission cell is what closes it for this role. The two gates are independent
    // on purpose, and this is the case where only one of them refuses.
    const error = await failure(
      world.useCase.presign(COMMITTEE, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("lets an Admin attach to a published expense somebody else never touched", async () => {
    const world = build();
    seedExpense(world.attachments, SOCIETY, "published", COMMITTEE_MEMBER);

    const result = await world.useCase.presign(
      ADMIN,
      SOCIETY,
      EXPENSE,
      COMMAND,
    );

    expect(result.storageKey).toContain(`/expenses/${EXPENSE}/`);
  });

  it("refuses a 20 MB file before taking the society lock", async () => {
    const world = build();

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
        ...COMMAND,
        sizeBytes: 20 * 1024 * 1024,
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("sizeBytes");
    expect(world.attachments.reservations).toHaveLength(0);
    expect(world.storage.presigns).toHaveLength(0);
  });
});

describe("the declared facts", () => {
  it("refuses a MIME type outside the four, naming the field", async () => {
    const world = build();

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
        ...COMMAND,
        mimeType: "image/gif",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("mimeType");
  });

  it("refuses a checksum that is not a sha256 hex digest", async () => {
    const world = build();

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
        ...COMMAND,
        checksum: "not-a-digest",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("checksum");
  });

  it("refuses a zero size", async () => {
    const world = build();

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
        ...COMMAND,
        sizeBytes: 0,
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts the exact 10 MB cap and refuses one byte more", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
      ...COMMAND,
      sizeBytes: 10 * 1024 * 1024,
    });
    expect(world.attachments.reservations).toHaveLength(1);

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
        ...COMMAND,
        sizeBytes: 10 * 1024 * 1024 + 1,
      }),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("lowercases an uppercase checksum rather than refusing it", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
      ...COMMAND,
      checksum: "A".repeat(64),
    });

    expect(world.attachments.reservations[0]!.checksum).toBe("a".repeat(64));
  });
});

describe("nothing the caller sends decides anything structural", () => {
  it("mints the id, the extension and the key from the server's own facts", async () => {
    const world = build();

    const result = await world.useCase.presign(
      ADMIN,
      SOCIETY,
      EXPENSE,
      COMMAND,
    );

    expect(result.storageKey).toMatch(
      new RegExp(
        `^societies/${SOCIETY}/expenses/${EXPENSE}/[0-9a-f-]{36}\\.jpg$`,
      ),
    );
    expect(result.storageKey.startsWith("societies/")).toBe(true);
  });

  it("derives the extension from the MIME type, never from the filename", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
      ...COMMAND,
      fileName: "bill.exe",
      mimeType: "application/pdf",
    });

    expect(world.attachments.reservations[0]!.storageKey).toMatch(/\.pdf$/);
  });

  it("reduces a filename to its last path segment", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
      ...COMMAND,
      fileName: "C:\\Users\\me\\..\\bill.jpg",
    });

    expect(world.attachments.reservations[0]!.originalFilename).toBe(
      "bill.jpg",
    );
  });

  it("strips a traversal attempt rather than passing it into the key", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
      ...COMMAND,
      fileName: "../../../etc/passwd.jpg",
    });

    const reserved = world.attachments.reservations[0]!;
    expect(reserved.originalFilename).toBe("passwd.jpg");
    expect(reserved.storageKey).not.toContain("..");
  });

  it("falls back to a generic name when the filename sanitises to nothing", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, {
      ...COMMAND,
      fileName: "...",
    });

    expect(world.attachments.reservations[0]!.originalFilename).toBe(
      "attachment",
    );
  });
});

describe("the plan cap", () => {
  it("hands the adapter a byte count, not a plan name", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND);

    expect(world.attachments.reservations[0]!.planCapBytes).toBe(
      500 * 1024 * 1024,
    );
  });

  it("prices premium at 5 GB", async () => {
    const world = build();
    world.attachments.plans.set(SOCIETY, "premium");

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND);

    expect(world.attachments.reservations[0]!.planCapBytes).toBe(
      5 * 1024 * 1024 * 1024,
    );
  });

  it("maps a refused reservation to 402 with a stable detail code, and mints no URL", async () => {
    const world = build();
    world.attachments.refusals.push(
      err(
        attachmentError(
          "quota_exceeded",
          "Your society's storage is full.",
          {},
        ),
      ),
    );

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(error.status).toBe(402);
    expect(error.payload.details?.[0]).toMatchObject({
      code: "ATTACHMENT_QUOTA_EXCEEDED",
    });
    // The quota is a gate, not a warning: an issued credential is precisely the
    // bypass the reservation exists to prevent.
    expect(world.storage.presigns).toHaveLength(0);
  });

  it("refuses — rather than defaults — a plan the byte map does not price", async () => {
    const world = build();
    world.attachments.plans.set(SOCIETY, "enterprise");

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    // 500, not 402: telling a customer to upgrade a plan they already hold would be a
    // lie, and silently applying Free's 500 MB would be a worse one.
    expect(error.code).toBe("INTERNAL");
    expect(error.status).toBe(500);
    expect(world.attachments.reservations).toHaveLength(0);
  });

  it("answers 404 when the society row is not readable at all", async () => {
    const world = build();
    world.attachments.plans.delete(SOCIETY);

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("the URL", () => {
  it("signs the exact reserved size for the configured window", async () => {
    const world = build();

    const result = await world.useCase.presign(
      ADMIN,
      SOCIETY,
      EXPENSE,
      COMMAND,
    );

    expect(world.storage.presigns[0]).toMatchObject({
      contentType: "image/jpeg",
      contentLength: 1024,
      ttlSeconds: 900,
    });
    expect(result.requiredHeaders["Content-Length"]).toBe("1024");
    expect(result.expiresAt).toBe("2026-10-07T10:15:00.000Z");
  });

  it("honours a configured TTL instead of a hard-coded 15 minutes", async () => {
    const world = build({ STORAGE_PRESIGN_TTL_SECONDS: 60 });

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND);

    expect(world.storage.presigns[0]!.ttlSeconds).toBe(60);
  });

  it("discards the reservation when the URL cannot be minted, and reports the store's failure", async () => {
    const world = build();
    world.storage.failure = attachmentError(
      "storage_unavailable",
      "The storage service is unavailable.",
    );

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    // 503, not 500: a store that is down is not this service's defect, and both a
    // client's retry logic and a monitor's alerting depend on the difference.
    expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(error.status).toBe(503);
    // The row is committed before signing, so a signing failure has to remove it
    // explicitly — otherwise every storage outage would leak quota.
    expect(world.attachments.deleted).toEqual([
      idFromKey(world.attachments.reservations[0]!.storageKey),
    ]);
  });

  it("still reports the storage failure when discarding the reservation also fails", async () => {
    const world = build();
    world.storage.failure = attachmentError("storage_unavailable", "down");
    world.attachments.deleteThrows = true;

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    // The caller hears the real cause. The surviving row is bounded — it stops
    // counting against the quota after 15 minutes — and is logged, not surfaced.
    expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});

describe("the reservation the adapter receives", () => {
  it("carries the membership id, not the user id", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND);

    expect(world.attachments.reservations[0]!.uploadedBy).toBe(ADMIN_MEMBER);
  });

  it("starts every upload pending, with no completion stamp", async () => {
    const world = build();

    const result = await world.useCase.presign(
      ADMIN,
      SOCIETY,
      EXPENSE,
      COMMAND,
    );

    expect(result.attachment.scanStatus).toBe("pending");
    expect(result.attachment.completedAt).toBeNull();
  });

  it("uses the caller's society and entity, never a body-supplied one", async () => {
    const world = build();

    await world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND);

    expect(world.attachments.reservations[0]).toMatchObject({
      societyId: SOCIETY,
      entityType: "expense",
      entityId: EXPENSE,
    });
  });

  it("cannot be pointed at another society by any combination of ids", async () => {
    const world = build();
    // The row exists — under the *other* tenant. Addressed under this one it must be
    // invisible, which is the property the explicit society predicate and the RLS
    // policy both carry (a distinguishable answer here would let a caller enumerate
    // another society's expense ids).
    world.attachments.expenses.clear();
    seedExpense(world.attachments, OTHER_SOCIETY, "draft", ADMIN_MEMBER);

    const error = await failure(
      world.useCase.presign(ADMIN, SOCIETY, EXPENSE, COMMAND),
    );

    expect(error.code).toBe("NOT_FOUND");
  });
});
