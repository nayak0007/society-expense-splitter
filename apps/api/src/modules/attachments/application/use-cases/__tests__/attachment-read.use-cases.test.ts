import { ConfigService } from "@nestjs/config";
import { asExpenseId, asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  AttachmentError,
  AttachmentExpenseSnapshot,
  AttachmentRecord,
  AttachmentRepository,
  ExpenseId,
  PresignedUpload,
  Result,
  SocietyId,
  StorageObjectMetadata,
  StorageProvider,
  StoredObject,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { AppConfig } from "../../../../../config/app-config";
import type { Env } from "../../../../../config/validation.schema";
import { CreateAttachmentDownloadUrlUseCase } from "../create-attachment-download-url.use-case";
import { ListExpenseAttachmentsUseCase } from "../list-expense-attachments.use-case";

/** Two use cases over one in-memory world — the read half of T073. */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const ATTACHMENT = "30000000-0000-4000-8000-000000000001";
const ACTOR: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");

function record(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: ATTACHMENT,
    societyId: SOCIETY,
    entityType: "expense",
    entityId: EXPENSE,
    storageKey: `societies/${SOCIETY}/expenses/${EXPENSE}/${ATTACHMENT}.jpg`,
    originalFilename: "bill.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 64,
    checksum: "a".repeat(64),
    uploadedBy: MEMBER,
    scanStatus: "pending",
    completedAt: "2026-10-07T10:05:00.000Z",
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<AttachmentExpenseSnapshot> = {},
): AttachmentExpenseSnapshot {
  return {
    id: EXPENSE,
    societyId: SOCIETY,
    status: "draft",
    createdBy: MEMBER,
    ...overrides,
  };
}

class FakeAttachments implements AttachmentRepository {
  expense: AttachmentExpenseSnapshot | null = snapshot();
  rows: AttachmentRecord[] = [];
  byId: AttachmentRecord | null = record();
  readonly listed: string[] = [];

  findExpenseForAttachment(): Promise<AttachmentExpenseSnapshot | null> {
    return Promise.resolve(this.expense);
  }
  readSocietySubscriptionPlan(): Promise<string | null> {
    return Promise.resolve("free");
  }
  reserve(): Promise<Result<AttachmentRecord, AttachmentError>> {
    return Promise.reject(new Error("read tests never reserve"));
  }
  findById(
    _attachmentId: string,
    societyId: SocietyId,
  ): Promise<AttachmentRecord | null> {
    const candidate = this.byId;
    if (candidate === null || candidate.societyId !== societyId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(candidate);
  }
  listCompletedForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<readonly AttachmentRecord[]> {
    this.listed.push(expenseId);
    return Promise.resolve(
      this.rows.filter(
        (row) => row.societyId === societyId && row.completedAt !== null,
      ),
    );
  }
  markComplete(): Promise<Result<AttachmentRecord, AttachmentError>> {
    return Promise.reject(new Error("read tests never complete"));
  }
  deleteById(): Promise<void> {
    return Promise.reject(new Error("read tests never delete"));
  }
  listStorageKeysForExpense(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

class FakeStorage implements StorageProvider {
  readonly presigned: { storageKey: string; ttlSeconds: number }[] = [];
  presignUpload(): Promise<PresignedUpload> {
    return Promise.reject(new Error("read tests never presign uploads"));
  }
  presignDownload(storageKey: string, ttlSeconds: number): Promise<string> {
    this.presigned.push({ storageKey, ttlSeconds });
    return Promise.resolve(`https://store.test/${storageKey}?sig=fake`);
  }
  head(): Promise<StorageObjectMetadata | null> {
    return Promise.resolve(null);
  }
  readObject(): Promise<StoredObject | null> {
    return Promise.resolve(null);
  }
  copy(): Promise<void> {
    return Promise.resolve();
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
}

function configWith(): AppConfig {
  return new AppConfig(
    new ConfigService<Env, true>({
      NODE_ENV: "test",
      STORAGE_PROVIDER: "minio",
      STORAGE_BUCKET: "ses-attachments",
      STORAGE_REGION: "us-east-1",
      STORAGE_FORCE_PATH_STYLE: true,
      STORAGE_AUTO_CREATE_BUCKET: false,
      STORAGE_PRESIGN_TTL_SECONDS: 900,
    }),
  );
}

function world() {
  const attachments = new FakeAttachments();
  const storage = new FakeStorage();
  return {
    attachments,
    storage,
    list: new ListExpenseAttachmentsUseCase(attachments),
    download: new CreateAttachmentDownloadUrlUseCase(
      attachments,
      storage,
      configWith(),
    ),
  };
}

/** Resolves the rejection's `AppError`, or fails the test if it did not reject. */
async function rejection(pending: Promise<unknown>): Promise<AppError> {
  try {
    await pending;
  } catch (error: unknown) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("ListExpenseAttachmentsUseCase", () => {
  it("returns the expense's completed bills", async () => {
    const w = world();
    w.attachments.rows = [record()];

    const rows = await w.list.list(ACTOR, SOCIETY, EXPENSE);

    expect(rows).toHaveLength(1);
    expect(w.attachments.listed).toEqual([EXPENSE]);
  });

  it("answers not_found for an expense the caller cannot see, without reading rows", async () => {
    const w = world();
    w.attachments.expense = null;

    const error = await rejection(w.list.list(ACTOR, SOCIETY, EXPENSE));

    expect(error.code).toBe("NOT_FOUND");
    expect(w.attachments.listed).toEqual([]);
  });
});

describe("CreateAttachmentDownloadUrlUseCase", () => {
  it("mints a URL and reports the row's metadata, with the TTL window", async () => {
    const w = world();

    const result = await w.download.create(ACTOR, SOCIETY, ATTACHMENT);

    expect(result.url).toContain(ATTACHMENT);
    expect(result.filename).toBe("bill.jpg");
    expect(result.scanStatus).toBe("pending");
    expect(w.storage.presigned).toEqual([
      { storageKey: record().storageKey, ttlSeconds: 900 },
    ]);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("serves a pending file while the gate is inert, and labels it pending", async () => {
    const w = world();
    w.attachments.byId = record({ scanStatus: "pending" });

    const result = await w.download.create(ACTOR, SOCIETY, ATTACHMENT);

    expect(result.scanStatus).toBe("pending");
  });

  it("answers not_found for an attachment that never completed", async () => {
    const w = world();
    w.attachments.byId = record({ completedAt: null });

    const error = await rejection(
      w.download.create(ACTOR, SOCIETY, ATTACHMENT),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(w.storage.presigned).toHaveLength(0);
  });

  it("answers not_found for an unknown id and for another society's row", async () => {
    const w = world();
    w.attachments.byId = null;
    expect(
      (await rejection(w.download.create(ACTOR, SOCIETY, ATTACHMENT))).code,
    ).toBe("NOT_FOUND");

    w.attachments.byId = record({ societyId: OTHER_SOCIETY });
    expect(
      (await rejection(w.download.create(ACTOR, SOCIETY, ATTACHMENT))).code,
    ).toBe("NOT_FOUND");
  });
});
