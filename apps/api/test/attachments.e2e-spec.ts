import { createHash } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DEFAULT_SOCIETY_SETTINGS,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  attachmentError,
} from "@ses/domain";
import type {
  AttachmentRecord,
  MemberRole,
  MembershipStatus,
  Society,
  SocietyId,
  SocietyMembership,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import {
  createFakeAttachmentRepository,
  createFakeStorage,
  type FakeAttachmentRepository,
  type FakeStorage,
} from "./utils/fake-attachment-store";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The attachment routes over real HTTP — Roadmap T071.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature over a locally held key pair, `X-Society-Id`
 * resolved to a membership, the matrix asked) and the whole use-case layer: the
 * ordering of the refusals, the plan-quota decision, the server-minted id and key, the
 * checksum comparison, the hand-rolled magic-byte sniffer, the `processing` answer that
 * is never `clean`, and the row-then-object delete. Only two things are faked — the
 * attachment store and the object store — which is the boundary the module's own unit
 * and integration suites also draw around different halves.
 *
 * ## What only the integration suite can prove
 *
 * Real SQL: the `FOR UPDATE` lock ordering, the insert policy's key-prefix assertion,
 * the column grants that make `scan_status` unwritable, and the definer helpers. This
 * file pins the HTTP surface — the statuses, the catalogue codes, the field names, the
 * envelope and the strict payloads — which is what a client actually sees.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");

const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const FOREIGN_EXPENSE = asExpenseId("20000000-0000-4000-8000-0000000000b2");
const ABSENT_ID = "99999999-9999-4999-8999-999999999999";

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const COMMITTEE_MEMBER = asMemberId("10000000-0000-4000-8000-000000000007");
const RESIDENT_MEMBER = asMemberId("10000000-0000-4000-8000-000000000003");
const GUEST_MEMBER = asMemberId("10000000-0000-4000-8000-000000000004");

const MAX_BYTES = 10 * 1024 * 1024;

/** Bytes whose magic number and digest are genuinely those of a JPEG. */
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

function membershipOf(
  actor: UserId,
  role: MemberRole,
  id: string,
  status: MembershipStatus = "active",
): SocietyMembership {
  return {
    id: asMemberId(id),
    societyId: SOCIETY_A,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

const ADMIN_MEMBERSHIP = membershipOf(ADMIN, "admin", ADMIN_MEMBER);
const COMMITTEE_MEMBERSHIP = membershipOf(
  COMMITTEE,
  "committee_member",
  COMMITTEE_MEMBER,
);
const RESIDENT_MEMBERSHIP = membershipOf(RESIDENT, "resident", RESIDENT_MEMBER);
const GUEST_MEMBERSHIP = membershipOf(GUEST, "guest", GUEST_MEMBER);

const societies = new Map<string, Society>([[SOCIETY_A, society()]]);

function society(): Society {
  return {
    id: SOCIETY_A,
    name: "Green Meadows",
    city: "Pune",
    type: "apartment",
    deletedAt: null,
    settings: { ...DEFAULT_SOCIETY_SETTINGS },
  } as unknown as Society;
}

const memberships = new Map<string, SocietyMembership>();
const key = (societyId: string, actor: string) => `${societyId}:${actor}`;

/** The guard's resolution: a society plus the caller's membership, or nothing. */
const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    const membership = memberships.get(key(societyId, actor));
    const found = societies.get(societyId);
    if (membership === undefined || found === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ society: found, membership });
  },
};

/** The use cases' membership read — the same world, a separate seam. */
const membershipReader: StructureMembershipReader = {
  findMembership(societyId, actor) {
    return Promise.resolve(memberships.get(key(societyId, actor)) ?? null);
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let attachments: FakeAttachmentRepository;
let storage: FakeStorage;

beforeAll(async () => {
  auth = await createTestAuth();
  attachments = createFakeAttachmentRepository();
  storage = createFakeStorage();

  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    attachmentRepository: attachments,
    storage,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  memberships.set(key(SOCIETY_A, ADMIN), ADMIN_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, COMMITTEE), COMMITTEE_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, RESIDENT), RESIDENT_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, GUEST), GUEST_MEMBERSHIP);

  attachments.state.expenses.clear();
  attachments.state.rows.clear();
  attachments.state.plans.clear();
  attachments.state.calls.length = 0;
  storage.state.objects.clear();
  storage.state.presigns.length = 0;
  storage.state.deletes.length = 0;
  storage.state.calls.length = 0;

  // A draft the Admin may attach to, on a Free plan.
  attachments.seedExpense({
    id: EXPENSE,
    societyId: SOCIETY_A,
    status: "draft",
    createdBy: ADMIN_MEMBER,
  });
  attachments.seedPlan(SOCIETY_A, "free");

  // The other tenant's bill — addressable only with SOCIETY_B's header, which no
  // member of SOCIETY_A holds.
  attachments.seedExpense({
    id: FOREIGN_EXPENSE,
    societyId: SOCIETY_B,
    status: "draft",
    createdBy: asMemberId("10000000-0000-4000-8000-0000000000b1"),
  });
});

const server = () => request(app.getHttpServer());

async function call(
  method: "get" | "post" | "delete",
  path: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly body?: unknown;
  } = {},
): Promise<request.Response> {
  let pending = server()[method](path);

  if (options.userId !== undefined) {
    pending = pending.set(
      "Authorization",
      `Bearer ${await auth.token(options.userId)}`,
    );
  }
  if (options.societyId !== null && options.societyId !== undefined) {
    pending = pending.set("X-Society-Id", options.societyId);
  }
  if (options.body !== undefined) {
    pending = pending.send(options.body as object);
  }
  return pending;
}

const uploadBody = (overrides: Record<string, unknown> = {}) => ({
  fileName: "bill.jpg",
  mimeType: "image/jpeg",
  sizeBytes: jpeg().byteLength,
  checksum: sha256(jpeg()),
  ...overrides,
});

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function presign(
  body: unknown = uploadBody(),
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly expenseId?: string;
  } = {},
) {
  return call(
    "post",
    `/v1/expenses/${options.expenseId ?? EXPENSE}/attachments`,
    {
      userId: options.userId ?? ADMIN,
      societyId:
        options.societyId === undefined ? SOCIETY_A : options.societyId,
      body,
    },
  );
}

function complete(
  attachmentId: string,
  body: unknown = { checksum: sha256(jpeg()) },
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("post", `/v1/attachments/${attachmentId}/complete`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
    body,
  });
}

function remove(
  attachmentId: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("delete", `/v1/attachments/${attachmentId}`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
  });
}

function get(
  path: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("get", path, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
  });
}

/** Seeds one stored attachment row out of band, for the T073 read routes. */
function seedAttachment(
  overrides: Partial<AttachmentRecord> & { readonly id: string },
): AttachmentRecord {
  const { id, ...rest } = overrides;
  const record: AttachmentRecord = {
    id,
    societyId: SOCIETY_A,
    entityType: "expense",
    entityId: EXPENSE,
    storageKey: `societies/${SOCIETY_A}/expenses/${EXPENSE}/${overrides.id}.jpg`,
    originalFilename: "bill.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 64,
    checksum: "a".repeat(64),
    uploadedBy: ADMIN_MEMBER,
    scanStatus: "pending",
    completedAt: "2026-10-07T10:05:00.000Z",
    createdAt: "2026-10-07T10:00:00.000Z",
    ...rest,
  };
  attachments.seedRow(record);
  return record;
}

/**
 * One real presign over HTTP, returning the id and the key it reserved.
 *
 * A reserved-and-uploaded row, so a later completion has something genuine to verify.
 */
async function reserveAndUpload(
  bytes: Buffer = jpeg(),
  options: { readonly userId?: UserId; readonly mimeType?: string } = {},
): Promise<{ id: string; storageKey: string }> {
  const mimeType = options.mimeType ?? "image/jpeg";
  const response = await presign(
    uploadBody({
      mimeType,
      sizeBytes: bytes.byteLength,
      checksum: sha256(bytes),
    }),
    { userId: options.userId ?? ADMIN },
  );
  expect(response.status).toBe(201);
  const { attachmentId, storageKey } = response.body.data as {
    attachmentId: string;
    storageKey: string;
  };
  storage.put(storageKey, bytes, mimeType);
  return { id: attachmentId, storageKey };
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call("post", `/v1/expenses/${EXPENSE}/attachments`, {
      societyId: SOCIETY_A,
      body: uploadBody(),
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires X-Society-Id, with the field named", async () => {
    const response = await call("post", `/v1/expenses/${EXPENSE}/attachments`, {
      userId: ADMIN,
      body: uploadBody(),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
  });
});

describe("POST /v1/expenses/:expenseId/attachments", () => {
  it("reserves the upload and mints a URL pinned to the declared size", async () => {
    const response = await presign();

    expect(response.status).toBe(201);
    const data = response.body.data as Record<string, unknown>;
    expect(data.attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.uploadUrl).toContain("https://store.test/");
    expect(data.expiresAt).toBe("2026-10-07T10:15:00.000Z");
    // The signature's own expectations, which the client has to send verbatim.
    expect(data.requiredHeaders).toEqual({
      "Content-Length": String(jpeg().byteLength),
      "Content-Type": "image/jpeg",
    });

    // The key is the server's, built from the row's own facts — the client's
    // `fileName` never reaches it.
    expect(data.storageKey).toBe(
      `societies/${SOCIETY_A}/expenses/${EXPENSE}/${data.attachmentId}.jpg`,
    );
    // And the adapter was handed exactly that size, which is what the signature pins.
    expect(storage.state.presigns[0]?.contentLength).toBe(jpeg().byteLength);
    expect(storage.state.presigns[0]?.ttlSeconds).toBe(900);
  });

  it("takes the extension from the MIME type, not from the filename", async () => {
    const response = await presign(
      uploadBody({
        fileName: "receipt.pdf.jpg",
        mimeType: "application/pdf",
        checksum: sha256(pdf()),
        sizeBytes: pdf().byteLength,
      }),
    );

    expect(response.status).toBe(201);
    expect(response.body.data.storageKey).toMatch(/\.pdf$/);
    expect(response.body.data.storageKey).not.toContain("receipt");
  });

  it("rejects an unknown key in the body — the contract is strict and 400, not 422", async () => {
    const response = await presign(uploadBody({ scanStatus: "clean" }));

    // `scanStatus` is not a field a client has standing to send: it is server-written
    // and no grant admits it, so accepting it silently would be the forgeable-fact
    // case the migration exists to close. Syntactic refusal, so 400 (SAD §7.8 stage 1).
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details?.[0]?.code).toBe("UNRECOGNIZED_KEYS");
  });

  it("refuses a MIME type outside the four, naming the field", async () => {
    const response = await presign(
      uploadBody({ mimeType: "image/gif", fileName: "bill.gif" }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("mimeType");
    expect(storage.state.presigns).toHaveLength(0);
  });

  it("refuses a file one byte over the 10 MB cap", async () => {
    const response = await presign(uploadBody({ sizeBytes: MAX_BYTES + 1 }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("sizeBytes");
    expect(attachments.state.rows.size).toBe(0);
  });

  it("accepts exactly 10 MB", async () => {
    const response = await presign(uploadBody({ sizeBytes: MAX_BYTES }));

    expect(response.status).toBe(201);
    expect(storage.state.presigns[0]?.contentLength).toBe(MAX_BYTES);
  });

  it("refuses a checksum that is not a sha256 hex digest, naming the field", async () => {
    const response = await presign(uploadBody({ checksum: "not-a-digest" }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("checksum");
  });

  it("accepts an uppercase checksum and normalises it", async () => {
    const response = await presign(
      uploadBody({ checksum: sha256(jpeg()).toUpperCase() }),
    );

    expect(response.status).toBe(201);
    expect(attachments.state.rows.size).toBe(1);
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await presign(uploadBody(), { expenseId: "not-a-uuid" });

    // A malformed uuid reaching Postgres would be a `22P02` the classifier can only
    // report as `unknown`, turning a client bug into a 500. The pipe refuses it first,
    // and names the parameter so a client knows which one.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("expenseId");
    expect(attachments.state.calls).toHaveLength(0);
  });

  it("refuses a Resident at the guard's cell with 403", async () => {
    const response = await presign(uploadBody(), { userId: RESIDENT });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(attachments.state.rows.size).toBe(0);
  });

  it("lets a Committee Member reserve on a draft they did not author", async () => {
    // `expense.create` is draft-only with no ownership clause (PRD §2.1's 🟡), so a
    // colleague's draft is the cell's grant rather than an exception to it.
    const response = await presign(uploadBody(), { userId: COMMITTEE });

    expect(response.status).toBe(201);
  });

  it("refuses a Committee Member a submitted expense", async () => {
    attachments.seedExpense({
      id: EXPENSE,
      societyId: SOCIETY_A,
      status: "pending_approval",
      createdBy: ADMIN_MEMBER,
    });

    const response = await presign(uploadBody(), { userId: COMMITTEE });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 for an expense id that is not there", async () => {
    const response = await presign(uploadBody(), { expenseId: ABSENT_ID });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 — never 403 — for an expense in another society", async () => {
    const response = await presign(uploadBody(), {
      expenseId: FOREIGN_EXPENSE,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a void expense with 409, for an Admin too", async () => {
    attachments.seedExpense({
      id: EXPENSE,
      societyId: SOCIETY_A,
      status: "void",
      createdBy: ADMIN_MEMBER,
    });

    const response = await presign();

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
    expect(attachments.state.rows.size).toBe(0);
  });

  it("refuses with 402 when the plan's storage is full", async () => {
    // Free is 500 MB and the per-object cap is 10 MB, so filling the plan is fifty
    // completed rows — which is also what a society at its cap really looks like.
    for (let index = 0; index < 50; index += 1) {
      attachments.seedRow(completedRow(index, MAX_BYTES));
    }

    const response = await presign(uploadBody({ sizeBytes: 1 }));

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(response.body.error.details?.[0]?.code).toBe(
      "ATTACHMENT_QUOTA_EXCEEDED",
    );
  });

  it("refuses an unpriced plan rather than defaulting it to Free's cap", async () => {
    attachments.seedPlan(SOCIETY_A, "enterprise");

    const response = await presign();

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL");
    expect(response.body.error.message).toContain("plan is not configured");
    expect(attachments.state.rows.size).toBe(0);
  });

  it("answers 503 when the store cannot mint a URL, and discards the reservation", async () => {
    storage.failNextPresign(
      attachmentError("storage_unavailable", "the store is unreachable"),
    );

    const response = await presign();

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    // The row was written before the URL was attempted (that ordering *is* the
    // quota), so the compensation has to remove it explicitly.
    expect(attachments.state.rows.size).toBe(0);
    expect(attachments.state.calls).toContain("deleteById");
  });
});

describe("POST /v1/attachments/:attachmentId/complete", () => {
  it("requires a session before anything else", async () => {
    const response = await call(
      "post",
      "/v1/attachments/30000000-0000-4000-8000-000000000001/complete",
      { societyId: SOCIETY_A, body: { checksum: sha256(jpeg()) } },
    );

    expect(response.status).toBe(401);
  });

  it("refuses a Resident — expense.create is not theirs", async () => {
    const response = await complete(
      "30000000-0000-4000-8000-000000000001",
      undefined,
      { userId: RESIDENT },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 200 with `processing` — never `clean`", async () => {
    const { id } = await reserveAndUpload();

    const response = await complete(id);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ status: "processing" });
    expect(JSON.stringify(response.body)).not.toContain("clean");

    // The row is complete and still pending a scan: no scanner exists in T071, so
    // `clean` is not a word any path writes.
    const stored = [...attachments.state.rows.values()][0] as AttachmentRecord;
    expect(stored.completedAt).not.toBeNull();
    expect(stored.scanStatus).toBe("pending");
  });

  it("verifies the digest of the stored bytes, not the ETag", async () => {
    const bytes = jpeg();
    const { id, storageKey } = await reserveAndUpload(bytes);
    // The same length, one different byte: the length gate passes, the digest does not.
    const tampered = Buffer.from(bytes);
    tampered[40] = 0x7a;
    storage.put(storageKey, tampered, "image/jpeg");

    const response = await complete(id);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details?.[0]?.code).toBe("CONTENT_MISMATCH");
  });

  it("refuses a .jpg whose bytes are a PDF — the extension is not authoritative", async () => {
    const body = pdf();
    const { id } = await reserveAndUpload(body, { mimeType: "image/jpeg" });

    const response = await complete(id, { checksum: sha256(body) });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details?.[0]?.code).toBe("CONTENT_MISMATCH");
  });

  it("refuses a checksum that is not the reserved one, naming the field", async () => {
    const { id } = await reserveAndUpload();

    const response = await complete(id, { checksum: "b".repeat(64) });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("checksum");
    expect(storage.state.calls).not.toContain("head");
  });

  it("answers 409 when nothing was uploaded", async () => {
    const response = await presign();
    const { attachmentId } = response.body.data as { attachmentId: string };

    const finished = await complete(attachmentId);

    expect(finished.status).toBe(409);
    expect(finished.body.error.code).toBe("CONFLICT");
  });

  it("replays a completed upload as the same 200, writing nothing new", async () => {
    const { id } = await reserveAndUpload();
    const first = await complete(id);
    expect(first.status).toBe(200);

    const replay = await complete(id);

    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual({ status: "processing" });
  });

  it("answers 404 for an unknown attachment id", async () => {
    const response = await complete(ABSENT_ID);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 — never 403 — for an attachment in another society", async () => {
    const { id } = await reserveAndUpload();

    const response = await complete(
      id,
      { checksum: sha256(jpeg()) },
      {
        societyId: SOCIETY_B,
      },
    );

    expect(response.status).toBe(404);
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await complete("not-a-uuid");

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("attachmentId");
    expect(attachments.state.calls).toHaveLength(0);
  });
});

describe("DELETE /v1/attachments/:attachmentId", () => {
  it("requires a session before anything else", async () => {
    const response = await call(
      "delete",
      "/v1/attachments/30000000-0000-4000-8000-000000000001",
      { societyId: SOCIETY_A },
    );

    expect(response.status).toBe(401);
  });

  it("answers 204 with no body, and removes the row before the object", async () => {
    const { id, storageKey } = await reserveAndUpload();

    const response = await remove(id);

    expect(response.status).toBe(204);
    // No envelope and no representation: any body here would have to bypass the very
    // absence that makes the delete meaningful.
    expect(response.body).toEqual({});
    expect(attachments.state.rows.size).toBe(0);
    expect(storage.state.deletes).toEqual([storageKey]);
  });

  it("answers 204 even when the object removal fails — the row is already gone", async () => {
    const { id } = await reserveAndUpload();
    storage.failDeletes(
      attachmentError("storage_unavailable", "the store is unreachable"),
    );

    const response = await remove(id);

    // Reporting a failure would be a lie about state that has committed: the
    // attachment is unreachable through every application path. The key is logged for
    // the abandoned-object sweep instead.
    expect(response.status).toBe(204);
    expect(attachments.state.rows.size).toBe(0);
    expect(storage.state.deletes).toHaveLength(0);
  });

  it("refuses an unrelated member with 403", async () => {
    const { id } = await reserveAndUpload();

    const response = await remove(id, { userId: RESIDENT });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(attachments.state.rows.size).toBe(1);
    expect(storage.state.deletes).toHaveLength(0);
  });

  it("lets the uploader delete their own upload even without an expense cell", async () => {
    const { id } = await reserveAndUpload(jpeg(), { userId: COMMITTEE });

    const response = await remove(id, { userId: COMMITTEE });

    expect(response.status).toBe(204);
    expect(attachments.state.rows.size).toBe(0);
  });

  it("answers 404 for an unknown attachment id", async () => {
    const response = await remove(ABSENT_ID);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 — never 403 — for an attachment in another society", async () => {
    const { id } = await reserveAndUpload();

    const response = await remove(id, { societyId: SOCIETY_B });

    expect(response.status).toBe(404);
    expect(attachments.state.rows.size).toBe(1);
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await remove("not-a-uuid");

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("attachmentId");
    expect(attachments.state.calls).toHaveLength(0);
  });
});

/** A completed row holding `sizeBytes`, for the quota boundary. */
function completedRow(index: number, sizeBytes: number): AttachmentRecord {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `40000000-0000-4000-8000-${suffix}`,
    societyId: SOCIETY_A,
    entityType: "expense",
    entityId: asExpenseId(EXPENSE),
    storageKey: `societies/${SOCIETY_A}/expenses/${EXPENSE}/filler-${suffix}.jpg`,
    originalFilename: "filler.jpg",
    mimeType: "image/jpeg",
    sizeBytes,
    checksum: "a".repeat(64),
    uploadedBy: ADMIN_MEMBER,
    scanStatus: "pending",
    completedAt: "2026-10-07T09:00:00.000Z",
    createdAt: "2026-10-07T08:00:00.000Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T073's read routes — the list and the download URL
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/expenses/:expenseId/attachments", () => {
  it("refuses a Guest — expense.view is not theirs", async () => {
    const response = await get(`/v1/expenses/${EXPENSE}/attachments`, {
      userId: GUEST,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await get("/v1/expenses/not-a-uuid/attachments");

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("expenseId");
  });

  it("requires a session before anything else", async () => {
    const response = await call("get", `/v1/expenses/${EXPENSE}/attachments`, {
      societyId: SOCIETY_A,
    });
    expect(response.status).toBe(401);
  });

  it("lists the expense's completed bills, oldest first, and not an outstanding reservation", async () => {
    seedAttachment({
      id: "30000000-0000-4000-8000-000000000002",
      originalFilename: "second.pdf",
      completedAt: "2026-10-07T10:10:00.000Z",
      createdAt: "2026-10-07T10:09:00.000Z",
    });
    seedAttachment({
      id: "30000000-0000-4000-8000-000000000001",
      originalFilename: "first.jpg",
      completedAt: "2026-10-07T10:05:00.000Z",
      createdAt: "2026-10-07T10:00:00.000Z",
    });
    // An outstanding reservation: no `completedAt`, so it is not a bill.
    seedAttachment({
      id: "30000000-0000-4000-8000-000000000003",
      completedAt: null,
      createdAt: "2026-10-07T10:20:00.000Z",
    });

    const response = await get(`/v1/expenses/${EXPENSE}/attachments`);

    expect(response.status).toBe(200);
    const ids = (response.body.data.attachments as { id: string }[]).map(
      (row) => row.id,
    );
    expect(ids).toEqual([
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002",
    ]);
    const first = response.body.data.attachments[0] as {
      originalFilename: string;
      scanStatus: string;
      completedAt: string;
    };
    expect(first.originalFilename).toBe("first.jpg");
    // The one field a client must not misread: an unscanned file is `pending`, not `clean`.
    expect(first.scanStatus).toBe("pending");
    expect(first.completedAt).toBe("2026-10-07T10:05:00.000Z");
  });

  it("answers 404 for an expense id that is not there", async () => {
    const response = await get(`/v1/expenses/${ABSENT_ID}/attachments`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 — never 403 — for an expense in another society", async () => {
    const response = await get(`/v1/expenses/${FOREIGN_EXPENSE}/attachments`, {
      societyId: SOCIETY_A,
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /v1/attachments/:attachmentId/download", () => {
  it("refuses a Guest — expense.view is not theirs", async () => {
    const response = await get(
      "/v1/attachments/30000000-0000-4000-8000-000000000001/download",
      { userId: GUEST },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("requires a session before anything else", async () => {
    const response = await call(
      "get",
      `/v1/attachments/30000000-0000-4000-8000-000000000001/download`,
      { societyId: SOCIETY_A },
    );
    expect(response.status).toBe(401);
  });

  it("mints a short-lived URL and returns the row's own metadata", async () => {
    seedAttachment({ id: "30000000-0000-4000-8000-000000000001" });

    const response = await get(
      `/v1/attachments/30000000-0000-4000-8000-000000000001/download`,
    );

    expect(response.status).toBe(200);
    const data = response.body.data as {
      url: string;
      expiresAt: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      scanStatus: string;
    };
    expect(data.url).toContain("30000000-0000-4000-8000-000000000001.jpg");
    expect(data.filename).toBe("bill.jpg");
    expect(data.mimeType).toBe("image/jpeg");
    // Served (the gate is inert with no scanner) but honestly labelled unscanned.
    expect(data.scanStatus).toBe("pending");
    expect(Number.isNaN(Date.parse(data.expiresAt))).toBe(false);
  });

  it("answers 404 for an attachment that never completed", async () => {
    seedAttachment({
      id: "30000000-0000-4000-8000-000000000003",
      completedAt: null,
    });
    const response = await get(
      `/v1/attachments/30000000-0000-4000-8000-000000000003/download`,
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for an unknown attachment id", async () => {
    const response = await get(`/v1/attachments/${ABSENT_ID}/download`);
    expect(response.status).toBe(404);
  });

  it("answers 404 — never 403 — for an attachment in another society", async () => {
    seedAttachment({
      id: "30000000-0000-4000-8000-0000000000b2",
      societyId: SOCIETY_B,
      entityId: FOREIGN_EXPENSE,
    });
    const response = await get(
      `/v1/attachments/30000000-0000-4000-8000-0000000000b2/download`,
    );
    expect(response.status).toBe(404);
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await get(`/v1/attachments/not-a-uuid/download`);
    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("attachmentId");
  });
});
