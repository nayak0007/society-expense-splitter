import { attachmentError, quotaVerdict } from "@ses/domain";
import type {
  AttachmentError,
  AttachmentExpenseSnapshot,
  AttachmentRecord,
  AttachmentRepository,
  ExpenseId,
  PresignUploadRequest,
  PresignedUpload,
  ReserveAttachmentInput,
  Result,
  SocietyId,
  StorageObjectMetadata,
  StorageProvider,
  StoredObject,
  UserId,
} from "@ses/domain";

/**
 * The attachment module's two ports over in-memory stores — Roadmap T071.
 *
 * ## What is faked, and what emphatically is not
 *
 * Only the storage: the SQL that reads the plan and sums the usage, the object store
 * itself, and the two conditional statements (`markComplete`'s `WHERE completed_at IS
 * NULL` and the delete). Everything between the request and these objects runs for
 * real — the global auth guard verifies a signature, `SocietyGuard` resolves
 * `X-Society-Id`, `PermissionGuard` asks the domain's matrix, the Zod pipes parse the
 * real contracts, the three use cases run, the magic-byte sniffer and the checksum
 * comparison are the production ones, and the mapper parses against the same contract
 * the mobile client does.
 *
 * ## The semantics reproduced, because a use case is allowed to rely on them
 *
 *  - an attachment is addressable only by the pair `(id, society id)`, so a row in
 *    another society is *unreachable* rather than unauthorised — PRD T041's
 *    `404`-not-`403`;
 *  - `reserve` applies the same `quotaVerdict` the real adapter does, over the same
 *    "completed or still fresh" sum, so the 402 boundary is the shared domain rule and
 *    not a number copied into a fake;
 *  - `markComplete` is the port's own conditional update: an already-complete row is
 *    returned unchanged, which is what makes a replay a 200 no-op;
 *  - the *order* of the delete is the caller's (row, then object), and the fake records
 *    it so a suite can assert the row went first.
 *
 * What it deliberately does not reproduce: RLS, the insert policy's key-prefix
 * assertion, the society `FOR UPDATE` lock, and the definer helpers. Those are the
 * integration suite's to prove, and a fake that imitated them would let a broken one
 * pass.
 */

export interface FakeAttachmentRepository extends AttachmentRepository {
  readonly state: {
    readonly expenses: Map<string, AttachmentExpenseSnapshot>;
    readonly rows: Map<string, AttachmentRecord>;
    readonly plans: Map<string, string>;
    readonly calls: string[];
  };
  /** Seeds a parent expense out of band. */
  seedExpense(snapshot: AttachmentExpenseSnapshot): void;
  /** Seeds a stored attachment row out of band. */
  seedRow(record: AttachmentRecord): void;
  /** Sets a society's stored plan string. */
  seedPlan(societyId: SocietyId, plan: string): void;
  /** Makes the next `reserve` throw, as a database refusal would. */
  failNextReserve(error: AttachmentError): void;
}

const expenseKey = (societyId: string, expenseId: string) =>
  `${societyId}:${expenseId}`;

export function createFakeAttachmentRepository(): FakeAttachmentRepository {
  const expenses = new Map<string, AttachmentExpenseSnapshot>();
  const rows = new Map<string, AttachmentRecord>();
  const plans = new Map<string, string>();
  const calls: string[] = [];
  const reserveFailures: AttachmentError[] = [];

  return {
    state: { expenses, rows, plans, calls },

    seedExpense(snapshot) {
      expenses.set(expenseKey(snapshot.societyId, snapshot.id), snapshot);
    },

    seedRow(record) {
      rows.set(record.id, record);
    },

    seedPlan(societyId, plan) {
      plans.set(societyId, plan);
    },

    failNextReserve(error) {
      reserveFailures.push(error);
    },

    findExpenseForAttachment(
      expenseId: ExpenseId,
      societyId: SocietyId,
    ): Promise<AttachmentExpenseSnapshot | null> {
      calls.push("findExpenseForAttachment");
      return Promise.resolve(
        expenses.get(expenseKey(societyId, expenseId)) ?? null,
      );
    },

    readSocietySubscriptionPlan(societyId: SocietyId): Promise<string | null> {
      calls.push("readSocietySubscriptionPlan");
      return Promise.resolve(plans.get(societyId) ?? null);
    },

    reserve(
      input: ReserveAttachmentInput,
    ): Promise<Result<AttachmentRecord, AttachmentError>> {
      calls.push("reserve");

      const failure = reserveFailures.shift();
      if (failure !== undefined)
        return Promise.resolve({ ok: false, error: failure });

      const used = [...rows.values()]
        .filter((row) => row.societyId === input.societyId)
        .reduce((total, row) => total + row.sizeBytes, 0);
      const verdict = quotaVerdict(used, input.sizeBytes, input.planCapBytes);
      if (!verdict.ok) return Promise.resolve(verdict);

      const record: AttachmentRecord = {
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
      rows.set(record.id, record);
      return Promise.resolve({ ok: true, value: record });
    },

    findById(
      attachmentId: string,
      societyId: SocietyId,
    ): Promise<AttachmentRecord | null> {
      calls.push("findById");
      const record = rows.get(attachmentId);
      if (record === undefined || record.societyId !== societyId) {
        return Promise.resolve(null);
      }
      return Promise.resolve(record);
    },

    markComplete(
      attachmentId: string,
      societyId: SocietyId,
    ): Promise<Result<AttachmentRecord, AttachmentError>> {
      calls.push("markComplete");
      const record = rows.get(attachmentId);
      if (record === undefined || record.societyId !== societyId) {
        return Promise.resolve({
          ok: false,
          error: attachmentError(
            "not_found",
            "That attachment is not available.",
          ),
        });
      }
      // The replay's answer, and the reason it is a success: an already-complete row
      // is returned as it stands rather than refused.
      const completed: AttachmentRecord = {
        ...record,
        completedAt: record.completedAt ?? "2026-10-07T10:05:00.000Z",
      };
      rows.set(completed.id, completed);
      return Promise.resolve({ ok: true, value: completed });
    },

    deleteById(attachmentId: string, societyId: SocietyId): Promise<void> {
      calls.push("deleteById");
      const record = rows.get(attachmentId);
      if (record === undefined || record.societyId !== societyId) {
        return Promise.reject(
          attachmentError("not_found", "That attachment is not available."),
        );
      }
      rows.delete(attachmentId);
      return Promise.resolve();
    },

    listStorageKeysForExpense(
      expenseId: ExpenseId,
      societyId: SocietyId,
    ): Promise<readonly string[]> {
      calls.push("listStorageKeysForExpense");
      return Promise.resolve(
        [...rows.values()]
          .filter(
            (row) =>
              row.societyId === societyId &&
              row.entityType === "expense" &&
              row.entityId === expenseId,
          )
          .map((row) => row.storageKey),
      );
    },
  };
}

export interface FakeStorage extends StorageProvider {
  readonly state: {
    readonly objects: Map<string, { bytes: Buffer; contentType: string }>;
    readonly presigns: PresignUploadRequest[];
    readonly deletes: string[];
    readonly calls: string[];
  };
  /** Writes bytes straight to the store, bypassing the presigned URL. */
  put(storageKey: string, bytes: Buffer, contentType: string): void;
  /** Makes the next `presignUpload` fail — a store that cannot mint a URL. */
  failNextPresign(error: AttachmentError): void;
  /** Makes every `delete` fail — the abandoned-object case. */
  failDeletes(error: AttachmentError): void;
}

export function createFakeStorage(): FakeStorage {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const presigns: PresignUploadRequest[] = [];
  const deletes: string[] = [];
  const calls: string[] = [];
  const presignFailures: AttachmentError[] = [];
  let deleteFailure: AttachmentError | null = null;

  return {
    state: { objects, presigns, deletes, calls },

    put(storageKey, bytes, contentType) {
      objects.set(storageKey, { bytes, contentType });
    },

    failNextPresign(error) {
      presignFailures.push(error);
    },

    failDeletes(error) {
      deleteFailure = error;
    },

    presignUpload(request: PresignUploadRequest): Promise<PresignedUpload> {
      calls.push("presignUpload");
      presigns.push({ ...request });

      const failure = presignFailures.shift();
      if (failure !== undefined) return Promise.reject(failure);

      return Promise.resolve({
        url: `https://store.test/${request.storageKey}?X-Amz-Signature=fake&X-Amz-Expires=${request.ttlSeconds}`,
        storageKey: request.storageKey,
        expiresAt: "2026-10-07T10:15:00.000Z",
        requiredHeaders: {
          "Content-Length": String(request.contentLength),
          "Content-Type": request.contentType,
        },
      });
    },

    presignDownload(storageKey: string): Promise<string> {
      calls.push("presignDownload");
      return Promise.resolve(
        `https://store.test/${storageKey}?X-Amz-Signature=fake`,
      );
    },

    head(storageKey: string): Promise<StorageObjectMetadata | null> {
      calls.push("head");
      const object = objects.get(storageKey);
      if (object === undefined) return Promise.resolve(null);
      return Promise.resolve({
        contentLength: object.bytes.byteLength,
        contentType: object.contentType,
        etag: "a-fake-etag",
      });
    },

    readObject(storageKey: string): Promise<StoredObject | null> {
      calls.push("readObject");
      const object = objects.get(storageKey);
      if (object === undefined) return Promise.resolve(null);
      return Promise.resolve({
        bytes: object.bytes,
        contentLength: object.bytes.byteLength,
        contentType: object.contentType,
        etag: "a-fake-etag",
      });
    },

    copy(sourceKey: string, destinationKey: string): Promise<void> {
      calls.push("copy");
      const object = objects.get(sourceKey);
      if (object !== undefined) objects.set(destinationKey, object);
      return Promise.resolve();
    },

    delete(storageKey: string): Promise<void> {
      calls.push("delete");
      if (deleteFailure !== null) return Promise.reject(deleteFailure);
      deletes.push(storageKey);
      objects.delete(storageKey);
      return Promise.resolve();
    },
  };
}

/** The caller of a fake; kept here so a suite does not need a cast at each call. */
export type Actor = UserId;
