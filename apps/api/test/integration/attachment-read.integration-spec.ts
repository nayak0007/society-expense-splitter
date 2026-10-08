import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

import { sql } from "drizzle-orm";
import { asExpenseId } from "@ses/domain";
import type {
  AttachmentRepository,
  ExpenseId,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { ATTACHMENT_REPOSITORY } from "../../src/modules/attachments/application/attachment.tokens";
import { CompleteUploadUseCase } from "../../src/modules/attachments/application/use-cases/complete-upload.use-case";
import { CreateAttachmentDownloadUrlUseCase } from "../../src/modules/attachments/application/use-cases/create-attachment-download-url.use-case";
import { ListExpenseAttachmentsUseCase } from "../../src/modules/attachments/application/use-cases/list-expense-attachments.use-case";
import { PresignUploadUseCase } from "../../src/modules/attachments/application/use-cases/presign-upload.use-case";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import { VoidExpenseUseCase } from "../../src/modules/expenses/application/use-cases/void-expense.use-case";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertApartment,
  insertBuilding,
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";
import { STATE_FILE, type IntegrationState } from "./state";

/**
 * The T073 **read** routes for attachments against real PostgreSQL, real RLS and real
 * object storage:
 *
 * ```text
 *   GET /expenses/:expenseId/attachments    the completed bills of one expense
 *   GET /attachments/:attachmentId/download  a short-lived, authorized GET URL
 * ```
 *
 * ## What only this suite can prove
 *
 * The unit and e2e suites run over a fake store, so they pin the orchestration and the
 * refusals a fake can express. Four claims need the real database and the real bucket:
 *
 * ```text
 *   completed only       an outstanding reservation is absent from the list and from
 *                        the download route alike
 *   the URL round-trips  a presigned GET minted by the real provider serves the exact
 *                        bytes of a private object — no public bucket, no credentials
 *   tenancy              a foreign or unknown expense/attachment is a 404, and RLS
 *                        hides another tenant's rows from the repository itself
 *   the read is inert    no financial row moves, no scan status is written, and the
 *                        inert serving gate (ADR-0012 D3) serves an unscanned file
 * ```text
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let presign: PresignUploadUseCase;
let complete: CompleteUploadUseCase;
let listAttachments: ListExpenseAttachmentsUseCase;
let download: CreateAttachmentDownloadUrlUseCase;
let createExpense: CreateExpenseUseCase;
let publishExpense: PublishExpenseUseCase;
let voidExpense: VoidExpenseUseCase;
let repository: AttachmentRepository;
let state: IntegrationState;

beforeAll(async () => {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as IntegrationState;
  harness = await startIntegrationHarness();
  owner = harness.owner;
  presign = harness.app.get(PresignUploadUseCase);
  complete = harness.app.get(CompleteUploadUseCase);
  listAttachments = harness.app.get(ListExpenseAttachmentsUseCase);
  download = harness.app.get(CreateAttachmentDownloadUrlUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  publishExpense = harness.app.get(PublishExpenseUseCase);
  voidExpense = harness.app.get(VoidExpenseUseCase);
  repository = harness.app.get<AttachmentRepository>(ATTACHMENT_REPOSITORY);
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

interface World extends SocietyFixture {
  readonly categoryId: string;
  readonly otherSocietyId: SocietyId;
  readonly otherAdminUserId: UserId;
}

async function world(): Promise<World> {
  const society = await seedSociety(harness, "Bill Court", "admin@t073a.test");
  const [category] = await owner<{ id: string }[]>`
    select id from public.expense_categories
     where society_id = ${society.societyId}::uuid
     order by display_order asc limit 1
  `;
  const north = await insertBuilding(owner, society.societyId, "North Block");
  for (let index = 1; index <= 2; index += 1) {
    const apartmentId = await insertApartment(
      owner,
      society.societyId,
      north,
      `A${index}`,
      index,
    );
    await insertMember(owner, society.societyId, {
      apartmentId,
      isPrimary: true,
      displayName: `Owner A${index}`,
    });
  }
  const other = await seedSociety(harness, "Bill Other", "admin@t073c.test");
  return {
    ...society,
    categoryId: category!.id,
    otherSocietyId: other.societyId,
    otherAdminUserId: other.adminUserId,
  };
}

async function draftExpense(
  w: World,
  amountPaise = 250_000,
): Promise<ExpenseId> {
  const record = await createExpense.create(w.adminUserId, w.societyId, {
    title: "Lift AMC",
    amountPaise,
    expenseDate: "2026-10-01",
    categoryId: w.categoryId,
  });
  return record.id;
}

function jpegBytes(payload = 0x41, size = 64): Buffer {
  const body = Buffer.alloc(size, payload);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[3] = 0xe0;
  return body;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A genuine upload: presign, PUT the exact bytes, complete. */
async function upload(
  w: World,
  expenseId: ExpenseId,
  options: { readonly bytes?: Buffer; readonly actor?: UserId } = {},
): Promise<{ attachmentId: string; key: string; bytes: Buffer }> {
  const bytes = options.bytes ?? jpegBytes();
  const actor = options.actor ?? w.adminUserId;
  const reserved = await presign.presign(actor, w.societyId, expenseId, {
    fileName: "bill.jpg",
    mimeType: "image/jpeg",
    sizeBytes: bytes.byteLength,
    checksum: sha256(bytes),
  });
  const response = await fetch(reserved.uploadUrl, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "image/jpeg" },
  });
  expect(response.status).toBe(200);
  await complete.complete(actor, w.societyId, reserved.attachment.id, {
    checksum: sha256(bytes),
  });
  return {
    attachmentId: reserved.attachment.id,
    key: reserved.storageKey,
    bytes,
  };
}

/** A reservation that is never completed, so the row has a null `completed_at`. */
async function reserveOnly(w: World, expenseId: ExpenseId): Promise<string> {
  const bytes = jpegBytes(0x42, 32);
  const reserved = await presign.presign(
    w.adminUserId,
    w.societyId,
    expenseId,
    {
      fileName: "never.jpg",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      checksum: sha256(bytes),
    },
  );
  return reserved.attachment.id;
}

interface RawResponse {
  readonly status: number;
  readonly body: Buffer;
}

/** A hand-built GET, so the exact presigned URL is exercised with its signature. */
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
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: unknown; status: unknown }> {
  try {
    await promise;
  } catch (error: unknown) {
    const app = error as { code?: unknown; status?: unknown };
    return { code: app.code, status: app.status };
  }
  throw new Error("Expected the call to be refused.");
}

const FINANCIAL_TABLES = [
  "expenses",
  "expense_splits",
  "expense_revisions",
  "dues",
  "member_balances",
] as const;

async function financialCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from ${owner(table)}
    `;
    counts[table] = Number(row?.count ?? "0");
  }
  return counts;
}

// ── the list route ───────────────────────────────────────────────────────────

describe("GET /expenses/:expenseId/attachments lists the completed bills", () => {
  it("returns completed uploads oldest-first and never a bare reservation", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const first = await upload(w, expenseId, { bytes: jpegBytes(0x41, 64) });
    const incomplete = await reserveOnly(w, expenseId);
    const second = await upload(w, expenseId, { bytes: jpegBytes(0x43, 48) });

    const listed = await listAttachments.list(
      w.adminUserId,
      w.societyId,
      expenseId,
    );

    expect(listed.map((record) => record.id)).toEqual([
      first.attachmentId,
      second.attachmentId,
    ]);
    // The reservation is absent from the list entirely — the point of the
    // `completed_at IS NOT NULL` filter.
    expect(listed.some((record) => record.id === incomplete)).toBe(false);
  });

  it("is visible to a Resident (expense.view is green for every role but Guest)", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    await upload(w, expenseId);

    const residentUserId = (await createLocalUser(
      owner,
      "resident@t073a.test",
      "Resident",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: residentUserId,
      role: "resident",
    });

    // A published bill is visible to a Resident; a draft is not, and that is the
    // expense read's rule rather than this route's. So publish first.
    await publishExpense.publish(w.adminUserId, w.societyId, expenseId, {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    const listed = await listAttachments.list(
      residentUserId,
      w.societyId,
      expenseId,
    );
    expect(listed).toHaveLength(1);
  }, 60_000);

  it("404s for an unknown expense", async () => {
    const w = await world();
    const failure = await refusal(
      listAttachments.list(
        w.adminUserId,
        w.societyId,
        asExpenseId(randomUUID()),
      ),
    );
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.status).toBe(404);
  });

  it("404s for another society's expense", async () => {
    const w = await world();
    const otherExpense = await draftExpense({
      ...w,
      societyId: w.otherSocietyId,
      adminUserId: w.otherAdminUserId,
      categoryId: (
        await owner<{ id: string }[]>`
          select id from public.expense_categories
           where society_id = ${w.otherSocietyId}::uuid
           order by display_order asc limit 1
        `
      )[0]!.id,
    });
    const failure = await refusal(
      listAttachments.list(w.adminUserId, w.societyId, otherExpense),
    );
    expect(failure.status).toBe(404);
  }, 30_000);
});

// ── the download route ───────────────────────────────────────────────────────

describe("GET /attachments/:attachmentId/download mints a working private URL", () => {
  it("round-trips the exact bytes through a real presigned GET", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const bytes = jpegBytes(0x41, 128);
    const { attachmentId } = await upload(w, expenseId, { bytes });

    const result = await download.create(
      w.adminUserId,
      w.societyId,
      attachmentId,
    );

    // The response carries the row's own metadata and a short-lived URL.
    expect(result.filename).toBe("bill.jpg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.sizeBytes).toBe(128);
    expect(result.scanStatus).toBe("pending");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // The URL is a real credential: the object is private (no public bucket), yet the
    // signed GET serves the exact bytes the upload wrote.
    const response = await getRaw(result.url);
    expect(response.status).toBe(200);
    expect(response.body.equals(bytes)).toBe(true);
  }, 30_000);

  it("refuses an unsigned GET of the same object", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const { key } = await upload(w, expenseId);

    const unsigned = await getRaw(
      `${state.storageEndpoint}/${state.storageBucket}/${key}`,
    );
    expect(unsigned.status).toBe(403);
  }, 30_000);

  it("404s for an outstanding reservation with no object to serve", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const incomplete = await reserveOnly(w, expenseId);

    const failure = await refusal(
      download.create(w.adminUserId, w.societyId, incomplete),
    );
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.status).toBe(404);
  });

  it("404s for an unknown attachment id", async () => {
    const w = await world();
    const failure = await refusal(
      download.create(w.adminUserId, w.societyId, randomUUID()),
    );
    expect(failure.status).toBe(404);
  });

  it("404s for a cross-society attachment — never 403", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const { attachmentId } = await upload(w, expenseId);

    const failure = await refusal(
      download.create(w.otherAdminUserId, w.otherSocietyId, attachmentId),
    );
    expect(failure.code).toBe("NOT_FOUND");
    expect(failure.status).toBe(404);
  });

  it("serves a void expense's historical attachment (read is allowed; add is not)", async () => {
    const w = await world();
    const expenseId = await publishExpenseAndGet(w);
    // Attach before the void, because ADR-0012 D6.1 refuses adding to a void expense.
    const { attachmentId, key, bytes } = await upload(w, expenseId);
    void key;
    await voidExpense.void(w.adminUserId, w.societyId, expenseId, {
      expectedVersion: 2,
      reason: "Reversed after the bill arrived",
    });

    // The list still shows it and the download URL still serves the evidence.
    const listed = await listAttachments.list(
      w.adminUserId,
      w.societyId,
      expenseId,
    );
    expect(listed.map((record) => record.id)).toEqual([attachmentId]);

    const result = await download.create(
      w.adminUserId,
      w.societyId,
      attachmentId,
    );
    const response = await getRaw(result.url);
    expect(response.status).toBe(200);
    expect(response.body.equals(bytes)).toBe(true);
  }, 60_000);

  it("serves an unscanned file while no scanner is configured (ADR-0012 D3, inert gate)", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const { attachmentId } = await upload(w, expenseId);

    const [row] = await owner<{ scan_status: string }[]>`
      select scan_status::text as scan_status from public.attachments
       where id = ${attachmentId}::uuid
    `;
    // No path writes `clean` — a scanner does not exist — so the gate must be inert
    // or every bill would be permanently unservable.
    expect(row!.scan_status).toBe("pending");
    await expect(
      download.create(w.adminUserId, w.societyId, attachmentId),
    ).resolves.toBeTruthy();
  });
});

/** A published expense, so a Resident-visible bill exists. */
async function publishExpenseAndGet(w: World): Promise<ExpenseId> {
  const expenseId = await draftExpense(w);
  await publishExpense.publish(w.adminUserId, w.societyId, expenseId, {
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
  });
  return expenseId;
}

// ── RLS on the repository reads ──────────────────────────────────────────────

describe("the repository's reads are the database's, not the route's", () => {
  it("lists nothing for another tenant's expense when called with the wrong society", async () => {
    const w = await world();
    const expenseId = await publishExpenseAndGet(w);
    await upload(w, expenseId);

    const rows = await repository.listCompletedForExpense(
      expenseId,
      w.otherSocietyId,
      w.otherAdminUserId,
    );
    expect(rows).toEqual([]);
  }, 30_000);

  it("finds nothing for a cross-society attachment id", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const { attachmentId } = await upload(w, expenseId);

    const record = await repository.findById(
      attachmentId,
      w.otherSocietyId,
      w.otherAdminUserId,
    );
    expect(record).toBeNull();
  }, 30_000);

  it("still denies UPDATE of scan_status (no write path for a read feature)", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const { attachmentId } = await upload(w, expenseId);

    let state = "allowed";
    try {
      await harness.unitOfWork.transaction(
        { kind: "user", userId: w.adminUserId },
        (tx) =>
          tx.execute(sql`
            update public.attachments set scan_status = 'clean'
             where id = ${attachmentId}::uuid
          `),
      );
    } catch (error: unknown) {
      const candidate = error as { code?: unknown; cause?: { code?: unknown } };
      state =
        typeof candidate.code === "string"
          ? candidate.code
          : typeof candidate.cause?.code === "string"
            ? candidate.cause.code
            : "refused";
    }
    // `scan_status` is not in the UPDATE grant, so no caller can mark a file clean.
    expect(["42501", "refused"]).toContain(state);
  }, 30_000);
});

// ── the read mutates nothing ─────────────────────────────────────────────────

describe("the read routes touch no financial row", () => {
  it("leaves every count and the split table byte-identical", async () => {
    const w = await world();
    const expenseId = await publishExpenseAndGet(w);
    const { attachmentId } = await upload(w, expenseId);

    const before = await financialCounts();
    const splitsBefore = await owner`
      select id::text, amount_paise::text from public.expense_splits order by id
    `;

    await listAttachments.list(w.adminUserId, w.societyId, expenseId);
    await download.create(w.adminUserId, w.societyId, attachmentId);
    await listAttachments.list(w.adminUserId, w.societyId, expenseId);

    expect(await financialCounts()).toEqual(before);
    expect(
      await owner`select id::text, amount_paise::text from public.expense_splits order by id`,
    ).toEqual(splitsBefore);
  }, 30_000);
});
