import {
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  attachmentError,
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
  StorageProvider,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { DeleteAttachmentUseCase } from "../delete-attachment.use-case";

/**
 * The delete use case over contract doubles — Roadmap T071, ADR-0012 D6.3/D6.4.
 *
 * Three claims are pure orchestration and belong here: who may delete (the uploader,
 * or whoever holds `expense.void`'s cell on the parent), that the row goes before the
 * object, and that a failed object removal is reported as a *success with a warning*
 * rather than a failure — the row is genuinely gone, and reporting otherwise would be
 * a lie about committed state.
 *
 * What needs PostgreSQL is the row's own delete policy and the drain of a draft's
 * attachments; both are asserted in `test/integration/attachments.integration-spec.ts`.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");

const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const ATTACHMENT = "30000000-0000-4000-8000-000000000001";
const KEY = `societies/${SOCIETY}/expenses/${EXPENSE}/${ATTACHMENT}.jpg`;

const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const COMMITTEE_MEMBER = asMemberId("10000000-0000-4000-8000-000000000007");
const RESIDENT_MEMBER = asMemberId("10000000-0000-4000-8000-000000000003");

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
  deleteFailure: AttachmentError | null = null;
  readonly deleted: string[] = [];
  readonly order: string[] = [];

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
    return Promise.reject(new Error("delete never reserves"));
  }

  findById(
    attachmentId: string,
    societyId: SocietyId,
  ): Promise<AttachmentRecord | null> {
    const candidate = this.row;
    if (candidate === null) return Promise.resolve(null);
    const visible =
      candidate.id === attachmentId && candidate.societyId === societyId;
    return Promise.resolve(visible ? candidate : null);
  }

  markComplete(): Promise<Result<AttachmentRecord, AttachmentError>> {
    return Promise.reject(new Error("delete never completes"));
  }

  // T073's read: deletion never lists an expense's bills.
  listCompletedForExpense(): Promise<readonly AttachmentRecord[]> {
    return Promise.resolve([]);
  }

  deleteById(attachmentId: string): Promise<void> {
    this.order.push("row");
    if (this.deleteFailure !== null) return Promise.reject(this.deleteFailure);
    this.deleted.push(attachmentId);
    return Promise.resolve();
  }

  listStorageKeysForExpense(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

interface StoreDoubles {
  deletion?: () => Promise<void>;
}

/** The store, recording that it was asked — and in what order. */
class FakeStorage implements StorageProvider {
  readonly order: string[];
  readonly deleted: string[] = [];
  deletionOverride: StoreDoubles["deletion"] = undefined;

  constructor(order: string[]) {
    this.order = order;
  }

  presignUpload(): Promise<never> {
    return Promise.reject(new Error("delete never presigns"));
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

  delete(key: string): Promise<void> {
    this.order.push("object");
    if (this.deletionOverride !== undefined) return this.deletionOverride();
    this.deleted.push(key);
    return Promise.resolve();
  }
}

interface World {
  readonly useCase: DeleteAttachmentUseCase;
  readonly attachments: FakeAttachments;
  readonly storage: FakeStorage;
  readonly memberships: FakeMemberships;
}

/**
 * One society with a draft, an Admin, a Committee Member, a Resident, and one
 * attachment uploaded by the Admin.
 */
function build(uploadedBy: MemberId = ADMIN_MEMBER): World {
  const attachments = new FakeAttachments();
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
    mimeType: "image/jpeg",
    sizeBytes: 64,
    checksum: "a".repeat(64),
    uploadedBy,
    scanStatus: "pending",
    completedAt: "2026-10-07T10:05:00.000Z",
    createdAt: "2026-10-07T10:00:00.000Z",
  };

  const storage = new FakeStorage(attachments.order);

  return {
    useCase: new DeleteAttachmentUseCase(attachments, storage, memberships),
    attachments,
    storage,
    memberships,
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as AppError;
  }
  throw new Error("expected the use case to refuse");
}

function remove(world: World, actor: UserId, societyId: SocietyId = SOCIETY) {
  return world.useCase.remove(actor, societyId, ATTACHMENT);
}

describe("who may delete", () => {
  it("answers 404 for a caller with no membership, even the uploader", async () => {
    const world = build();
    world.memberships.memberships.clear();
    world.memberships.seed(RESIDENT_MEMBERSHIP);

    const error = await failure(remove(world, ADMIN));

    // The uploader branch does not bypass the membership check: a removed member
    // cannot reach back and delete their own historical upload.
    expect(error.code).toBe("NOT_FOUND");
    expect(world.attachments.deleted).toHaveLength(0);
  });

  it("answers 404 for an attachment id this society does not hold", async () => {
    const world = build();
    world.attachments.row = null;

    expect((await failure(remove(world, ADMIN))).code).toBe("NOT_FOUND");
    expect(world.attachments.deleted).toHaveLength(0);
  });

  it("answers 404 when the parent expense is gone", async () => {
    const world = build();
    world.attachments.expense = null;

    // A row whose expense was hard-deleted must not be deletable through a route
    // that has no record left to authorise against.
    expect((await failure(remove(world, ADMIN))).code).toBe("NOT_FOUND");
    expect(world.attachments.deleted).toHaveLength(0);
  });

  it("lets the uploader delete their own attachment", async () => {
    const world = build(RESIDENT_MEMBER);
    // The Resident holds no expense cell at all, so this can only pass on the
    // uploader branch — which is the point of having two.
    await remove(world, RESIDENT);

    expect(world.attachments.deleted).toEqual([ATTACHMENT]);
    expect(world.storage.deleted).toEqual([KEY]);
  });

  it("lets a manager delete somebody else's attachment", async () => {
    const world = build(RESIDENT_MEMBER);

    await remove(world, ADMIN);

    expect(world.attachments.deleted).toEqual([ATTACHMENT]);
    expect(world.storage.deleted).toEqual([KEY]);
  });

  it("refuses an unrelated member", async () => {
    const world = build();

    const error = await failure(remove(world, RESIDENT));

    expect(error.code).toBe("FORBIDDEN");
    expect(error.status).toBe(403);
    expect(world.attachments.deleted).toHaveLength(0);
    expect(world.storage.deleted).toHaveLength(0);
  });

  it("narrows a Committee Member to their own unpublished expense", async () => {
    const world = build(RESIDENT_MEMBER);

    // Somebody else authored the draft, so `expense.void`'s ownership clause refuses.
    const refused = await failure(remove(world, COMMITTEE));
    expect(refused.code).toBe("FORBIDDEN");

    // Their own draft, and the same upload: allowed.
    world.attachments.expense = {
      ...world.attachments.expense!,
      createdBy: COMMITTEE_MEMBER,
    };
    await remove(world, COMMITTEE);
    expect(world.attachments.deleted).toEqual([ATTACHMENT]);
  });

  it("refuses a Committee Member once the expense is published", async () => {
    const world = build(RESIDENT_MEMBER);
    world.attachments.expense = {
      ...world.attachments.expense!,
      status: "published",
      createdBy: COMMITTEE_MEMBER,
    };

    // `expense.void`'s scoped rule is `!published AND own draft`, so a published
    // expense is outside the cell however it was authored.
    expect((await failure(remove(world, COMMITTEE))).code).toBe("FORBIDDEN");
    expect(world.attachments.deleted).toHaveLength(0);
  });
});

describe("row first, object second", () => {
  it("deletes the row before it touches the store", async () => {
    const world = build();

    await remove(world, ADMIN);

    // A stranded object is sweepable; a stranded row points at bytes that are gone.
    expect(world.attachments.order).toEqual(["row", "object"]);
  });

  it("leaves the object alone when the row is refused", async () => {
    const world = build();
    world.attachments.deleteFailure = attachmentError(
      "forbidden",
      "the row's own policy refused",
    );

    const error = await failure(remove(world, ADMIN));

    expect(error.code).toBe("FORBIDDEN");
    // The row was attempted and refused; the object step never ran, so nothing was
    // stranded and nothing was double-deleted.
    expect(world.attachments.order).toEqual(["row"]);
    expect(world.storage.deleted).toHaveLength(0);
  });

  it("reports success when the object removal fails, because the row is gone", async () => {
    const world = build();
    world.storage.deletionOverride = () =>
      Promise.reject(
        attachmentError("storage_unavailable", "the store is down"),
      );

    await expect(remove(world, ADMIN)).resolves.toBeUndefined();

    // Both halves of the claim: the row was removed, and the failure was not turned
    // into a refusal for a change that already committed. The warning line carries
    // the key, which is what the abandoned-object sweep has to work from.
    expect(world.attachments.deleted).toEqual([ATTACHMENT]);
    expect(world.attachments.order).toEqual(["row", "object"]);
  });
});
