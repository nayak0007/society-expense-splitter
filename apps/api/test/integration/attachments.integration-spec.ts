import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { asExpenseId } from "@ses/domain";
import type {
  AttachmentRepository,
  ExpenseId,
  ExpenseRepository,
  SocietyId,
  StorageProvider,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { STORAGE_PROVIDER } from "../../src/infrastructure/storage/storage.tokens";
import { ATTACHMENT_REPOSITORY } from "../../src/modules/attachments/application/attachment.tokens";
import { CompleteUploadUseCase } from "../../src/modules/attachments/application/use-cases/complete-upload.use-case";
import { DeleteAttachmentUseCase } from "../../src/modules/attachments/application/use-cases/delete-attachment.use-case";
import { PresignUploadUseCase } from "../../src/modules/attachments/application/use-cases/presign-upload.use-case";
import { EXPENSE_REPOSITORY } from "../../src/modules/expenses/application/expense.tokens";
import { CreateExpenseUseCase } from "../../src/modules/expenses/application/use-cases/create-expense.use-case";
import { DeleteDraftUseCase } from "../../src/modules/expenses/application/use-cases/delete-draft.use-case";
import { PublishExpenseUseCase } from "../../src/modules/expenses/application/use-cases/publish-expense.use-case";
import { VoidExpenseUseCase } from "../../src/modules/expenses/application/use-cases/void-expense.use-case";
import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";

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
 * Attachments against real PostgreSQL, real RLS and real object storage — T071.
 *
 * ## What only this suite can prove
 *
 * The use-case unit tests run over a fake store, so they prove the orchestration and
 * the refusals a fake can express. Nine claims need the real database and the real
 * store, and each is one of the Roadmap's acceptance sentences:
 *
 * ```text
 *   the quota lock       two concurrent presigns cannot both reserve the last byte
 *   the quota window     a completed row counts; an expired reservation does not
 *   plan quota checked   the cap is read from the society's stored plan, refused at +1
 *   RLS grants           a client cannot write scan_status, completed_at, checksum,
 *                        size_bytes, storage_key or another tenant's row at all
 *   cross-society        404, never 403
 *   the lifecycle        void refuses; draft / pending_approval / published accept
 *   draft cleanup        no attachment row survives a draft hard-delete, and the
 *                        objects are gone from the bucket
 *   T070's invariant     approved_by/approved_at byte-identical across add/complete/delete
 *   the money invariant  splits, dues, balances, advances and revisions untouched
 * ```
 *
 * Fixtures are written on the **owner** connection; every call under test runs
 * through `UnitOfWork` as the acting member, and `resetData` truncates between tests.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let presign: PresignUploadUseCase;
let complete: CompleteUploadUseCase;
let deleteAttachment: DeleteAttachmentUseCase;
let createExpense: CreateExpenseUseCase;
let deleteDraft: DeleteDraftUseCase;
let publishExpense: PublishExpenseUseCase;
let voidExpense: VoidExpenseUseCase;
let repository: AttachmentRepository;
let expenses: ExpenseRepository;
let storage: StorageProvider;
let rawS3: S3Client;
let state: IntegrationState;

beforeAll(async () => {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as IntegrationState;
  harness = await startIntegrationHarness();
  owner = harness.owner;
  repository = harness.app.get<AttachmentRepository>(ATTACHMENT_REPOSITORY);
  expenses = harness.app.get<ExpenseRepository>(EXPENSE_REPOSITORY);
  storage = harness.app.get<StorageProvider>(STORAGE_PROVIDER);
  presign = harness.app.get(PresignUploadUseCase);
  complete = harness.app.get(CompleteUploadUseCase);
  deleteAttachment = harness.app.get(DeleteAttachmentUseCase);
  createExpense = harness.app.get(CreateExpenseUseCase);
  deleteDraft = harness.app.get(DeleteDraftUseCase);
  publishExpense = harness.app.get(PublishExpenseUseCase);
  voidExpense = harness.app.get(VoidExpenseUseCase);

  // A raw client, so the suite can write objects the signed URL would refuse — the
  // only way to reach the completion path's size check.
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

afterAll(() => {
  rawS3.destroy();
});

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await resetData(owner);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface World extends SocietyFixture {
  readonly categoryId: string;
  readonly otherSocietyId: SocietyId;
  readonly otherAdminUserId: UserId;
}

/**
 * A society with one category, one author, two billable flats with owners, and a
 * second society next door.
 *
 * The flats look unrelated to attachments and are not: three of T071's invariants
 * (the void refusal, the approval stamps, the financial freeze) run through the real
 * publish path, and publishing resolves its participants from the society's billable
 * flats. A society of members who live nowhere cannot publish anything, so without
 * these rows the fixture would fail before the assertion it exists to make.
 */
async function world(): Promise<World> {
  const society = await seedSociety(harness, "Alpha Court", "admin@t071.test");
  const [category] = await owner<{ id: string }[]>`
    select id from public.expense_categories
     where society_id = ${society.societyId}::uuid
     order by display_order asc
     limit 1
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
  const other = await seedSociety(harness, "Beta Court", "admin@t071b.test");
  return {
    ...society,
    categoryId: category!.id,
    otherSocietyId: other.societyId,
    otherAdminUserId: other.adminUserId,
  };
}

/** One draft through the real create path, so the row is the product's own. */
async function draftExpense(
  world: World,
  actor: UserId = world.adminUserId,
): Promise<ExpenseId> {
  const record = await createExpense.create(actor, world.societyId, {
    title: "Lift AMC",
    amountPaise: 250_000,
    expenseDate: "2026-10-01",
    categoryId: world.categoryId,
  });
  return record.id;
}

/** Bytes whose signature and digest are genuinely those of a JPEG. */
function jpegBytes(payload = 0x41, size = 64): Buffer {
  const body = Buffer.alloc(size, payload);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[3] = 0xe0;
  return body;
}

function pdfBytes(size = 64): Buffer {
  const body = Buffer.alloc(size, 0x20);
  body.write("%PDF-1.7", 0, "ascii");
  return body;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Spend `bytes` of the society's attachment quota on completed rows.
 *
 * The society cap (500 MB on Free) is fifty times the per-object cap (10 MB,
 * `chk_attachments_size_max`), so a quota boundary cannot be reached with one row —
 * the table refuses it. Filling in 10 MB rows is also the honest shape of the data:
 * a real society at its cap *is* a long list of bills, not one enormous one.
 */
async function fillPlan(
  w: World,
  expenseId: ExpenseId,
  bytes: number,
): Promise<void> {
  const perRow = 10 * 1024 * 1024;
  for (let remaining = bytes; remaining > 0; remaining -= perRow) {
    const size = Math.min(perRow, remaining);
    await owner`
      insert into public.attachments (
        society_id, entity_type, entity_id, storage_key, original_filename,
        mime_type, size_bytes, checksum, uploaded_by, completed_at
      ) values (
        ${w.societyId}::uuid, 'expense', ${expenseId}::uuid,
        ${`societies/${w.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`},
        'filler.jpg', 'image/jpeg', ${size}, ${"a".repeat(64)},
        ${w.adminMemberId}::uuid, now()
      )
    `;
  }
}

/** A genuine upload: presign, PUT the exact bytes, complete. */
async function upload(
  world: World,
  expenseId: ExpenseId,
  options: {
    readonly mimeType?: string;
    readonly bytes?: Buffer;
    readonly actor?: UserId;
    readonly fileName?: string;
  } = {},
): Promise<string> {
  const mimeType = options.mimeType ?? "image/jpeg";
  const bytes = options.bytes ?? jpegBytes();
  const actor = options.actor ?? world.adminUserId;

  const reserved = await presign.presign(actor, world.societyId, expenseId, {
    fileName: options.fileName ?? "bill.jpg",
    mimeType,
    sizeBytes: bytes.byteLength,
    checksum: sha256(bytes),
  });

  await putObject(reserved.uploadUrl, bytes, mimeType);
  await complete.complete(actor, world.societyId, reserved.attachment.id, {
    checksum: sha256(bytes),
  });
  return reserved.attachment.id;
}

/** A raw PUT, so the suite can send bytes the API never saw. */
async function putObject(
  url: string,
  bytes: Buffer,
  contentType: string,
): Promise<number> {
  const response = await fetch(url, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": contentType },
  });
  return response.status;
}

async function counts(): Promise<Record<string, number>> {
  const tables = [
    "expenses",
    "expense_splits",
    "expense_revisions",
    "dues",
    "member_balances",
    "attachments",
  ] as const;
  const result: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from ${owner(table)}
    `;
    result[table] = Number(row?.count ?? "0");
  }
  return result;
}

async function rows<T = Record<string, unknown>>(
  tx: TransactionContext,
  query: SQL,
): Promise<readonly T[]> {
  return (await tx.execute(query)) as unknown as readonly T[];
}

/** Runs `query` as `userId` — a real `authenticated` transaction, RLS and all. */
async function as<T = Record<string, unknown>>(
  userId: UserId,
  query: SQL,
): Promise<readonly T[]> {
  return harness.unitOfWork.transaction({ kind: "user", userId }, (tx) =>
    rows<T>(tx, query),
  );
}

/** The `AppError` a refused call threw, for asserting its code. */
// `| undefined` on each optional field rather than `?`: this workspace compiles with
// `exactOptionalPropertyTypes`, under which `{ code: string | undefined }` is not
// assignable to an optional `code?: string`.
interface Refusal {
  code: string | undefined;
  status: number | undefined;
  message: string | undefined;
  /** The stable codes a client branches on, from `AppError.payload`. */
  detailCodes: readonly string[] | undefined;
}

async function refusal(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error: unknown) {
    const app = error as {
      code?: string;
      status?: number;
      message?: string;
      payload?: { details?: readonly { code?: string }[] };
    };
    return {
      code: app.code,
      status: app.status,
      message: app.message,
      detailCodes: app.payload?.details?.map((detail) => detail.code ?? ""),
    };
  }
  throw new Error("Expected the call to be refused.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The schema and its policies
// ─────────────────────────────────────────────────────────────────────────────

describe("migrations #33 to #35 and their security posture", () => {
  it("applied with the ledger at HEAD, in order, ending at T071's own files", async () => {
    const rows = await owner<{ name: string }[]>`
      select name from ses_meta.migrations order by name
    `;
    const names = rows.map((row) => row.name);
    // T071 ships three, and each is a correction the real-PostgreSQL suite forced:
    //   #33  the table, its policies, its helpers and its grants;
    //   #34  `GRANT INSERT (id)` — the key contains the id, so the row has to carry the
    //        uuid the API already minted, or every key names a row that does not exist;
    //   #35  the uploader's foreign key back to a single-column reference — the
    //        composite form depends on `uq_members_id_society` and blocks
    //        `20261001120000_expense_schema.sql`'s documented Down block, and the
    //        same-society guarantee is stronger in the insert policy that replaced it.
    // Forward-only, so "the ledger ends at these files" and "0 pending" are one
    // sentence, and the ledger's own checksum guard is what makes editing #33 in place
    // impossible rather than merely discouraged — which is exactly why all three exist.
    expect(names).toHaveLength(35);
    expect(names.slice(-3)).toEqual([
      "20261011120000_attachments.sql",
      "20261012120000_attachments_insert_id_grant.sql",
      "20261013120000_attachments_uploader_fk.sql",
    ]);
  });

  it("has RLS enabled AND forced", async () => {
    const [row] = await owner<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relrowsecurity, relforcerowsecurity
        from pg_class
       where oid = 'public.attachments'::regclass
    `;
    expect(row!.relrowsecurity).toBe(true);
    // FORCE is the half that matters: without it the table owner bypasses its own
    // policies, which is the commonest way an RLS setup fails open.
    expect(row!.relforcerowsecurity).toBe(true);
  });

  it("grants UPDATE on completed_at only — the forged-value list is not writable at all", async () => {
    const granted = await owner<{ column_name: string }[]>`
      select column_name
        from information_schema.column_privileges
       where table_schema = 'public'
         and table_name = 'attachments'
         and grantee = 'authenticated'
         and privilege_type = 'UPDATE'
    `;
    const columns = granted.map((entry) => entry.column_name).sort();
    // The strongest statement in the migration: `scan_status`, `checksum`,
    // `size_bytes`, `storage_key` and the tenancy columns cannot be written by any
    // authenticated caller, because no grant admits the column.
    expect(columns).toEqual(["completed_at", "updated_at"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Direct-write refusals (RLS + grants)
// ─────────────────────────────────────────────────────────────────────────────

describe("a client cannot forge an attachment through direct writes", () => {
  it("refuses a cross-society INSERT", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const key = `societies/${w.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`;

    const attempt = as(
      w.otherAdminUserId,
      sql`
        insert into public.attachments (
          society_id, entity_type, entity_id, storage_key, original_filename,
          mime_type, size_bytes, checksum, uploaded_by
        ) values (
          ${w.societyId}::uuid, 'expense', ${expenseId}::uuid, ${key},
          'x.jpg', 'image/jpeg', 10, ${"a".repeat(64)}, ${w.adminMemberId}::uuid
        )
      `,
    );

    await expect(attempt).rejects.toThrow();
    expect((await counts())["attachments"]).toBe(0);
  });

  it("refuses attributing the upload to another member of the same society", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const key = `societies/${w.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`;

    // One of the fixture flats' own owners — a real, active member of this very
    // society, so nothing about the row is cross-tenant and the key prefix is the
    // caller's own. The only wrong thing is who it says wrote it.
    const [other] = await owner<{ id: string }[]>`
      select id from public.members
       where society_id = ${w.societyId}::uuid
         and id <> ${w.adminMemberId}::uuid
       limit 1
    `;
    expect(other).toBeDefined();

    // `20261013120000_attachments_uploader_fk.sql` replaced the composite
    // `(uploaded_by, society_id)` key with the insert policy's own predicate — the
    // uploader must be the *caller's* active membership of the row's society — so this
    // is refused by the policy rather than by a foreign key, and the refusal has to be
    // asserted through the policy's path to be worth anything.
    await expect(
      as(
        w.adminUserId,
        sql`
          insert into public.attachments (
            society_id, entity_type, entity_id, storage_key, original_filename,
            mime_type, size_bytes, checksum, uploaded_by
          ) values (
            ${w.societyId}::uuid, 'expense', ${expenseId}::uuid, ${key},
            'x.jpg', 'image/jpeg', 10, ${"a".repeat(64)},
            ${other!.id}::uuid
          )
        `,
      ),
    ).rejects.toThrow();
    expect((await counts())["attachments"]).toBe(0);
  });

  it("accepts the caller's own membership as the uploader — the predicate is a boundary, not a wall", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const key = `societies/${w.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`;

    await as(
      w.adminUserId,
      sql`
        insert into public.attachments (
          society_id, entity_type, entity_id, storage_key, original_filename,
          mime_type, size_bytes, checksum, uploaded_by
        ) values (
          ${w.societyId}::uuid, 'expense', ${expenseId}::uuid, ${key},
          'x.jpg', 'image/jpeg', 10, ${"a".repeat(64)},
          ${w.adminMemberId}::uuid
        )
      `,
    );
    expect((await counts())["attachments"]).toBe(1);
  });

  it("refuses a caller setting scan_status in the INSERT (policy, not only grant)", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const key = `societies/${w.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`;

    // `scan_status` is not in the INSERT grant, so this fails on privilege before
    // the policy is even consulted — both halves are the point.
    await expect(
      as(
        w.adminUserId,
        sql`
          insert into public.attachments (
            society_id, entity_type, entity_id, storage_key, original_filename,
            mime_type, size_bytes, checksum, uploaded_by, scan_status
          ) values (
            ${w.societyId}::uuid, 'expense', ${expenseId}::uuid, ${key},
            'x.jpg', 'image/jpeg', 10, ${"a".repeat(64)},
            ${w.adminMemberId}::uuid, 'clean'
          )
        `,
      ),
    ).rejects.toThrow();
  });

  it("refuses a caller stamping completed_at on insert", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const key = `societies/${w.societyId}/expenses/${expenseId}/${randomUUID()}.jpg`;

    await expect(
      as(
        w.adminUserId,
        sql`
          insert into public.attachments (
            society_id, entity_type, entity_id, storage_key, original_filename,
            mime_type, size_bytes, checksum, uploaded_by, completed_at
          ) values (
            ${w.societyId}::uuid, 'expense', ${expenseId}::uuid, ${key},
            'x.jpg', 'image/jpeg', 10, ${"a".repeat(64)},
            ${w.adminMemberId}::uuid, now()
          )
        `,
      ),
    ).rejects.toThrow();
  });

  it("refuses rewriting a verified checksum or size after the fact", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);

    await expect(
      as(
        w.adminUserId,
        sql`update public.attachments set checksum = ${"b".repeat(64)}
             where id = ${attachmentId}::uuid`,
      ),
    ).rejects.toThrow();

    await expect(
      as(
        w.adminUserId,
        sql`update public.attachments set size_bytes = 1
             where id = ${attachmentId}::uuid`,
      ),
    ).rejects.toThrow();

    const [row] = await owner<{ checksum: string; size_bytes: number }[]>`
      select checksum, size_bytes from public.attachments
       where id = ${attachmentId}::uuid
    `;
    expect(row!.checksum).toBe(sha256(jpegBytes()));
    expect(row!.size_bytes).toBe(64);
  });

  it("refuses a storage key that is not this row's own society prefix", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const foreignKey = `societies/${w.otherSocietyId}/expenses/${expenseId}/${randomUUID()}.jpg`;

    // The insert policy ties the key to the row's own society and entity, so a row
    // cannot point at another tenant's prefix even in principle.
    await expect(
      as(
        w.adminUserId,
        sql`
          insert into public.attachments (
            society_id, entity_type, entity_id, storage_key, original_filename,
            mime_type, size_bytes, checksum, uploaded_by
          ) values (
            ${w.societyId}::uuid, 'expense', ${expenseId}::uuid, ${foreignKey},
            'x.jpg', 'image/jpeg', 10, ${"a".repeat(64)}, ${w.adminMemberId}::uuid
          )
        `,
      ),
    ).rejects.toThrow();
  });

  it("refuses deleting another member's attachment directly", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);

    // The delete policy's three arms are `can_publish_expenses`, "the uploader is the
    // caller" and `can_draft_expenses` on an unpublished expense the caller authored.
    // A Resident is none of them, so the row survives.
    const residentUserId = (await createLocalUser(
      owner,
      "resident@t071.test",
      "Resident",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: residentUserId,
      role: "resident",
    });

    const attempt = as(
      residentUserId,
      sql`delete from public.attachments where id = ${attachmentId}::uuid returning id`,
    );
    const deleted = await attempt;
    expect(deleted).toHaveLength(0);
    expect((await counts())["attachments"]).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Quota
// ─────────────────────────────────────────────────────────────────────────────

describe("the plan quota reserves exactly and refuses one byte over", () => {
  it("counts completed rows and does not count expired reservations", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    await upload(w, expenseId);

    const used = async (): Promise<number> => {
      const [row] = await owner<{ used: string }[]>`
        select coalesce(sum(size_bytes), 0)::text as used
          from public.attachments
         where society_id = ${w.societyId}::uuid
           and (completed_at is not null
                or created_at > now() - interval '15 minutes')
      `;
      return Number(row!.used);
    };

    expect(await used()).toBe(64);

    // A reservation that has aged out stops counting — the whole reason the window
    // exists, or a client that never uploaded would lock the society's quota forever.
    const stale = await presign.presign(w.adminUserId, w.societyId, expenseId, {
      fileName: "stale.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      checksum: sha256(jpegBytes(0x42, 16)),
    });
    expect(await used()).toBe(64 + 1000);

    await owner`
      update public.attachments
         set created_at = now() - interval '16 minutes'
       where id = ${stale.attachment.id}::uuid
    `;
    expect(await used()).toBe(64);
  });

  it("refuses an unpriced plan rather than defaulting it", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    // The audit's pre-existing divergence: the column's enum has `society_pro` and
    // `enterprise`, which the PRD never prices. T071 refuses rather than guessing.
    await owner`
      update public.societies set plan = 'enterprise'
       where id = ${w.societyId}::uuid
    `;

    const error = await refusal(
      presign.presign(w.adminUserId, w.societyId, expenseId, {
        fileName: "bill.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      }),
    );
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("plan is not configured");
    expect((await counts())["attachments"]).toBe(0);
  });

  it("allows a reservation that lands exactly on the cap and refuses the next byte", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    // Free is 500 MB. Fill it to the byte, then ask for one more.
    const free = 500 * 1024 * 1024;
    await fillPlan(w, expenseId, free);

    const exact = await refusal(
      presign.presign(w.adminUserId, w.societyId, expenseId, {
        fileName: "one.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1,
        checksum: sha256(jpegBytes()),
      }),
    );
    // `used + requested > cap` — one byte over is a refusal, and the refusal is the
    // catalogue's existing 402, not an invented one.
    expect(exact.code).toBe("PLAN_LIMIT_EXCEEDED");
    expect(exact.status).toBe(402);

    // Exactly at the cap with nothing stored yet is allowed.
    await owner`delete from public.attachments`;
    await fillPlan(w, expenseId, free - 64);
    const boundary = await presign.presign(
      w.adminUserId,
      w.societyId,
      expenseId,
      {
        fileName: "exact.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      },
    );
    expect(boundary.attachment.sizeBytes).toBe(64);
  });

  it("cannot be over-reserved by concurrent presigns", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    // 500 MB minus room for exactly four 1 MB bills: six concurrent attempts must
    // produce exactly four reservations, because the society row is locked for the
    // duration of each read-then-insert (ADR-0012 D2). Without the lock every one of
    // them would observe the same headroom and all six would succeed.
    const free = 500 * 1024 * 1024;
    const each = 1024 * 1024;
    await fillPlan(w, expenseId, free - 4 * each);

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_value, index) =>
        presign.presign(w.adminUserId, w.societyId, expenseId, {
          fileName: `race-${index}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes: each,
          checksum: sha256(jpegBytes(0x50 + index, 32)),
        }),
      ),
    );

    const reserved = attempts.filter((entry) => entry.status === "fulfilled");
    const refused = attempts.filter((entry) => entry.status === "rejected");
    expect(reserved).toHaveLength(4);
    expect(refused).toHaveLength(2);

    // And the database agrees: the total reservation is exactly the cap.
    const [row] = await owner<{ used: string }[]>`
      select coalesce(sum(size_bytes), 0)::text as used
        from public.attachments where society_id = ${w.societyId}::uuid
    `;
    expect(Number(row!.used)).toBe(free);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The lifecycle gate and cross-society invisibility
// ─────────────────────────────────────────────────────────────────────────────

describe("the expense lifecycle decides who may attach", () => {
  it("404s for an expense that does not exist", async () => {
    const w = await world();
    const error = await refusal(
      presign.presign(w.adminUserId, w.societyId, asExpenseId(randomUUID()), {
        fileName: "x.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("404s for an attachment id in another society — never 403", async () => {
    const w = await world();
    const error = await refusal(
      complete.complete(w.otherAdminUserId, w.otherSocietyId, randomUUID(), {
        checksum: sha256(jpegBytes()),
      }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("allows a draft, a pending_approval and a published expense", async () => {
    const w = await world();

    // Draft.
    const draft = await draftExpense(w);
    await expect(upload(w, draft)).resolves.toBeTruthy();

    // pending_approval: raise the amount above the society's threshold and create.
    const queue = await createExpense.create(w.adminUserId, w.societyId, {
      title: "High value",
      amountPaise: 2_000_000,
      expenseDate: "2026-10-02",
      categoryId: w.categoryId,
    });
    expect(queue.status).toBe("pending_approval");
    await expect(upload(w, queue.id)).resolves.toBeTruthy();

    // published: a below-threshold draft goes through the real publish path.
    const bill = await draftExpense(w);
    await publishExpense.publish(w.adminUserId, w.societyId, bill, {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    await expect(upload(w, bill)).resolves.toBeTruthy();
  }, 60_000);

  it("refuses a void expense outright", async () => {
    const w = await world();
    const bill = await draftExpense(w);
    await publishExpense.publish(w.adminUserId, w.societyId, bill, {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    await voidExpense.void(w.adminUserId, w.societyId, bill, {
      expectedVersion: 2,
      reason: "Posted to the wrong expense account",
    });

    const error = await refusal(
      presign.presign(w.adminUserId, w.societyId, bill, {
        fileName: "late.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      }),
    );
    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.status).toBe(409);
    expect((await counts())["attachments"]).toBe(0);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Completion
// ─────────────────────────────────────────────────────────────────────────────

describe("completion verifies the stored object", () => {
  it("refuses a checksum that disagrees with the stored bytes", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    // Reserve for one set of bytes, upload *different* bytes of the same length.
    // The length pin cannot catch this — the checksum is the only gate that can.
    const reserved = jpegBytes(0x41, 64);
    const uploaded = jpegBytes(0x42, 64);
    expect(reserved.byteLength).toBe(uploaded.byteLength);

    const token = await presign.presign(w.adminUserId, w.societyId, expenseId, {
      fileName: "bill.jpg",
      mimeType: "image/jpeg",
      sizeBytes: reserved.byteLength,
      checksum: sha256(reserved),
    });
    await putObject(token.uploadUrl, uploaded, "image/jpeg");

    const error = await refusal(
      complete.complete(w.adminUserId, w.societyId, token.attachment.id, {
        checksum: sha256(reserved),
      }),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(error.message).toContain("checksum");

    const [row] = await owner<{ completed_at: string | null }[]>`
      select completed_at from public.attachments
       where id = ${token.attachment.id}::uuid
    `;
    expect(row!.completed_at).toBeNull();
  });

  it("refuses a .jpg whose stored bytes are a PDF — the Roadmap's own test", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const bytes = pdfBytes(64);

    const token = await presign.presign(w.adminUserId, w.societyId, expenseId, {
      fileName: "bill.jpg",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      checksum: sha256(bytes),
    });
    await putObject(token.uploadUrl, bytes, "image/jpeg");

    // The size and the digest both match what was declared, so only the magic number
    // can refuse this — and it must, because the extension is not authoritative.
    const error = await refusal(
      complete.complete(w.adminUserId, w.societyId, token.attachment.id, {
        checksum: sha256(bytes),
      }),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    // The stable code, not the sentence: the message names the type that was actually
    // found, while `CONTENT_MISMATCH` is what a client branches on — the same detail
    // code a checksum disagreement carries, because both mean "not the file you said".
    expect(error.detailCodes).toContain("CONTENT_MISMATCH");

    const [row] = await owner<
      { completed_at: string | null; scan_status: string }[]
    >`
      select completed_at, scan_status from public.attachments
       where id = ${token.attachment.id}::uuid
    `;
    // Nothing is marked complete and nothing is marked clean — ADR-0012 D3: no
    // scanner exists, so `clean` is never written by any path.
    expect(row!.completed_at).toBeNull();
    expect(row!.scan_status).toBe("pending");
  });

  it("refuses the reverse mismatch: a declared PDF whose bytes are a JPEG", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const bytes = jpegBytes();

    const token = await presign.presign(w.adminUserId, w.societyId, expenseId, {
      fileName: "bill.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      checksum: sha256(bytes),
    });
    await putObject(token.uploadUrl, bytes, "application/pdf");

    const error = await refusal(
      complete.complete(w.adminUserId, w.societyId, token.attachment.id, {
        checksum: sha256(bytes),
      }),
    );
    expect(error.status).toBe(422);
  });

  it("409s when no upload happened, and 409s when the object is the wrong size", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    // The object was never written — the reservation exists and nothing else does.
    const missing = await presign.presign(
      w.adminUserId,
      w.societyId,
      expenseId,
      {
        fileName: "bill.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      },
    );
    const missingError = await refusal(
      complete.complete(w.adminUserId, w.societyId, missing.attachment.id, {
        checksum: sha256(jpegBytes()),
      }),
    );
    expect(missingError.status).toBe(409);

    // The object exists but is a different size than the reservation. Reached by
    // writing it with the raw client, because the exact-size signature makes a
    // mismatched upload unreachable through the API — which is itself the point of
    // the pin, and why this check is the *second* line of defence rather than the
    // first.
    const expected = jpegBytes(0x41, 128);
    const wrongSize = await presign.presign(
      w.adminUserId,
      w.societyId,
      expenseId,
      {
        fileName: "bill.jpg",
        mimeType: "image/jpeg",
        sizeBytes: expected.byteLength,
        checksum: sha256(expected),
      },
    );
    await rawS3.send(
      new PutObjectCommand({
        Bucket: state.storageBucket,
        Key: wrongSize.storageKey,
        Body: jpegBytes(0x41, 96),
        ContentType: "image/jpeg",
      }),
    );

    const error = await refusal(
      complete.complete(w.adminUserId, w.societyId, wrongSize.attachment.id, {
        checksum: sha256(expected),
      }),
    );
    expect(error.status).toBe(409);
    expect(error.message).toContain("size");
  }, 60_000);

  it("replays a completed upload as a 200 no-op", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const bytes = jpegBytes();
    const token = await presign.presign(w.adminUserId, w.societyId, expenseId, {
      fileName: "bill.jpg",
      mimeType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      checksum: sha256(bytes),
    });
    await putObject(token.uploadUrl, bytes, "image/jpeg");

    const first = await complete.complete(
      w.adminUserId,
      w.societyId,
      token.attachment.id,
      { checksum: sha256(bytes) },
    );
    expect(first.status).toBe("processing");

    // `::text`, because the driver hands a timestamptz back as a `Date` and two
    // equal `Date` values are two different objects.
    const [afterFirst] = await owner<{ completed_at: string }[]>`
      select completed_at::text as completed_at from public.attachments
       where id = ${token.attachment.id}::uuid
    `;

    const replay = await complete.complete(
      w.adminUserId,
      w.societyId,
      token.attachment.id,
      { checksum: sha256(bytes) },
    );
    expect(replay.status).toBe("processing");

    // Truly a no-op: the stamp did not move, so a replay cannot be used to rewrite
    // when an upload was verified.
    const [afterReplay] = await owner<{ completed_at: string }[]>`
      select completed_at::text as completed_at from public.attachments
       where id = ${token.attachment.id}::uuid
    `;
    expect(afterReplay!.completed_at).toBe(afterFirst!.completed_at);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Deletion
// ─────────────────────────────────────────────────────────────────────────────

describe("deletion", () => {
  it("lets the uploader delete their own attachment, and removes the object", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);

    const [row] = await owner<{ storage_key: string }[]>`
      select storage_key from public.attachments where id = ${attachmentId}::uuid
    `;
    const { storage_key: key } = row!;

    await deleteAttachment.remove(w.adminUserId, w.societyId, attachmentId);

    expect((await counts())["attachments"]).toBe(0);
    // Row first, object second (ADR-0012 D6.3) — and here the object really is gone.
    expect(await storage.head(key)).toBeNull();
  }, 30_000);

  it("lets an authorized manager delete a Committee Member's upload", async () => {
    const w = await world();
    const committeeUserId = (await createLocalUser(
      owner,
      "committee@t071.test",
      "Committee",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: committeeUserId,
      role: "committee_member",
    });

    // A Committee Member's own draft, and their own upload on it.
    const expenseId = await draftExpense(w, committeeUserId);
    const attachmentId = await upload(w, expenseId, { actor: committeeUserId });

    // The Admin is not the uploader, but holds `expense.void`'s full cell — D6.4's
    // second branch.
    await deleteAttachment.remove(w.adminUserId, w.societyId, attachmentId);
    expect((await counts())["attachments"]).toBe(0);
  }, 30_000);

  it("refuses an unrelated member", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);

    const residentUserId = (await createLocalUser(
      owner,
      "resident@t071.test",
      "Resident",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: residentUserId,
      role: "resident",
    });

    const error = await refusal(
      deleteAttachment.remove(residentUserId, w.societyId, attachmentId),
    );
    // A Resident cannot see a draft through `expense.void`'s cell, and the parent
    // read is what refuses them — 404, per PRD T041.
    expect([403, 404]).toContain(error.status);
    expect((await counts())["attachments"]).toBe(1);
  }, 30_000);

  it("refuses a cross-society delete with 404", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);

    const error = await refusal(
      deleteAttachment.remove(
        w.otherAdminUserId,
        w.otherSocietyId,
        attachmentId,
      ),
    );
    expect(error.status).toBe(404);
    expect((await counts())["attachments"]).toBe(1);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 · Draft hard deletion and the invariants
// ─────────────────────────────────────────────────────────────────────────────

describe("hard-deleting a draft", () => {
  it("removes the attachment rows and the objects with them", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);

    const [row] = await owner<{ storage_key: string }[]>`
      select storage_key from public.attachments where id = ${attachmentId}::uuid
    `;
    const { storage_key: key } = row!;

    await deleteDraft.delete(w.adminUserId, w.societyId, expenseId);

    // No attachment row may survive pointing at a deleted draft (ADR-0012 D6.5).
    expect((await counts())["attachments"]).toBe(0);
    expect((await counts())["expenses"]).toBe(0);
    // And the object half: the cleanup is best-effort by design, but on the happy
    // path it must actually have happened.
    expect(await storage.head(key)).toBeNull();
  }, 30_000);

  it("leaves the objects of other drafts alone", async () => {
    const w = await world();
    const doomed = await draftExpense(w);
    const kept = await draftExpense(w);
    await upload(w, doomed);
    const keepId = await upload(w, kept);

    const [keptRow] = await owner<{ storage_key: string }[]>`
      select storage_key from public.attachments where id = ${keepId}::uuid
    `;

    await deleteDraft.delete(w.adminUserId, w.societyId, doomed);

    expect((await counts())["attachments"]).toBe(1);
    expect(await storage.head(keptRow!.storage_key)).not.toBeNull();
  }, 30_000);
});

describe("T071 changes no financial state and no approval", () => {
  it("leaves approved_by/approved_at byte-identical across add, complete and delete", async () => {
    const w = await world();

    // A high-value expense that has been approved through the real RPCs.
    const queued = await createExpense.create(w.adminUserId, w.societyId, {
      title: "Terrace waterproofing",
      amountPaise: 2_500_000,
      expenseDate: "2026-10-03",
      categoryId: w.categoryId,
    });
    expect(queued.status).toBe("pending_approval");

    // Approve through the definer function, then read the stamps as the owner.
    await expenses.approve(
      queued.id,
      w.societyId,
      { expectedVersion: queued.version },
      w.adminUserId,
    );

    const stamps = async (): Promise<string> => {
      const [row] = await owner<
        {
          approved_by: string | null;
          approved_at: string | null;
        }[]
      >`
        select approved_by, approved_at from public.expenses
         where id = ${queued.id}::uuid
      `;
      return `${row!.approved_by}|${row!.approved_at}`;
    };

    const before = await stamps();
    expect(before).not.toBe("null|null");

    const attachmentId = await upload(w, queued.id);
    expect(await stamps()).toBe(before);

    await deleteAttachment.remove(w.adminUserId, w.societyId, attachmentId);
    // ADR-0012 D6.2: adding, completing and deleting an attachment leaves the
    // approval untouched — attachments are not approved content, so re-approval is
    // not required for an unchanged amount.
    expect(await stamps()).toBe(before);
  }, 60_000);

  it("touches no split, due, balance, advance or revision row", async () => {
    const w = await world();

    // A published bill, so every financial table has real rows to protect.
    const expenseId = await draftExpense(w);
    await publishExpense.publish(w.adminUserId, w.societyId, expenseId, {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });

    const before = await counts();
    const balancesBefore = await owner`
      select member_id::text, total_due_paise::text, total_paid_paise::text,
             advance_paise::text, outstanding_paise::text
        from public.member_balances
       order by member_id
    `;
    const duesBefore = await owner`
      select id::text, amount_paise::text, paid_paise::text, status::text, due_date::text
        from public.dues order by id
    `;
    const splitsBefore = await owner`
      select id::text, amount_paise::text from public.expense_splits order by id
    `;
    const amountsBefore = await owner`
      select id::text, amount_paise::text, status::text, version from public.expenses order by id
    `;

    // Add, complete, then delete.
    const attachmentId = await upload(w, expenseId);
    await deleteAttachment.remove(w.adminUserId, w.societyId, attachmentId);

    const after = await counts();
    for (const table of [
      "expenses",
      "expense_splits",
      "expense_revisions",
      "dues",
      "member_balances",
    ] as const) {
      expect(after[table]).toBe(before[table]);
    }

    // And byte-identical values, not merely equal counts.
    expect(
      await owner`
        select member_id::text, total_due_paise::text, total_paid_paise::text,
               advance_paise::text, outstanding_paise::text
          from public.member_balances order by member_id`,
    ).toEqual(balancesBefore);
    expect(
      await owner`
        select id::text, amount_paise::text, paid_paise::text, status::text, due_date::text
          from public.dues order by id`,
    ).toEqual(duesBefore);
    expect(
      await owner`select id::text, amount_paise::text from public.expense_splits order by id`,
    ).toEqual(splitsBefore);
    expect(
      await owner`
        select id::text, amount_paise::text, status::text, version
          from public.expenses order by id`,
    ).toEqual(amountsBefore);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 · Authorization cells
// ─────────────────────────────────────────────────────────────────────────────

describe("authorization reuses the expense cells", () => {
  it("refuses a Resident at the guard's cell with 403", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const residentUserId = (await createLocalUser(
      owner,
      "resident2@t071.test",
      "Resident",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: residentUserId,
      role: "resident",
      apartmentId: null,
    });

    const error = await refusal(
      presign.presign(residentUserId, w.societyId, expenseId, {
        fileName: "bill.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      }),
    );
    // `expense.create` is Admin/Treasurer/Committee: a Resident is an active member
    // whose role is insufficient, which is a 403 rather than the 404 a stranger gets.
    expect(error.status).toBe(403);
  }, 30_000);

  it("gives a Committee Member the draft cell and nothing past it", async () => {
    const w = await world();
    const committeeUserId = (await createLocalUser(
      owner,
      "committee2@t071.test",
      "Committee",
    )) as UserId;
    await insertMember(owner, w.societyId, {
      userId: committeeUserId,
      role: "committee_member",
    });

    const attempt = (expenseId: ExpenseId) =>
      presign.presign(committeeUserId, w.societyId, expenseId, {
        fileName: "bill.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 64,
        checksum: sha256(jpegBytes()),
      });

    // `expense.create`'s scoped rule is `!resource.published` — draft-only, with no
    // ownership clause at all. So another member's *draft* is the 🟡 cell's actual
    // grant rather than an exception to it, and expecting a 403 here would be
    // asserting a rule the authorization matrix does not contain.
    const allowed = await attempt(await draftExpense(w));
    expect(allowed.attachment.id).toBeTruthy();

    // One step past draft is already outside the cell: a submitted expense refuses
    // the Committee Member even when they are the one who authored it.
    const queued = await createExpense.create(w.adminUserId, w.societyId, {
      title: "High value",
      amountPaise: 2_000_000,
      expenseDate: "2026-10-04",
      categoryId: w.categoryId,
    });
    expect(queued.status).toBe("pending_approval");
    expect((await refusal(attempt(queued.id))).status).toBe(403);

    // Published accepts attachments as a lifecycle matter, and `!published` still
    // refuses the permission — which is why the lifecycle gate cannot be the gate.
    const bill = await draftExpense(w);
    await publishExpense.publish(w.adminUserId, w.societyId, bill, {
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect((await refusal(attempt(bill))).status).toBe(403);

    // One reservation, from the one allowed call — no row was written by a refusal.
    expect((await counts())["attachments"]).toBe(1);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 · Unused imports are load-bearing documentation
// ─────────────────────────────────────────────────────────────────────────────

describe("the attachment repository's projections", () => {
  it("reads the parent expense and the stored plan without a second adapter", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);

    const snapshot = await repository.findExpenseForAttachment(
      expenseId,
      w.societyId,
      w.adminUserId,
    );
    expect(snapshot).toMatchObject({ status: "draft" });

    // The raw stored value, unmapped — which is what lets the quota map fail closed
    // on a plan the PRD never priced.
    expect(
      await repository.readSocietySubscriptionPlan(w.societyId, w.adminUserId),
    ).toBe("free");

    // A cross-society read is invisible rather than forbidden.
    expect(
      await repository.findExpenseForAttachment(
        expenseId,
        w.societyId,
        w.otherAdminUserId,
      ),
    ).toBeNull();
  }, 30_000);

  it("builds a key inside the row's own society and entity", async () => {
    const w = await world();
    const expenseId = await draftExpense(w);
    const attachmentId = await upload(w, expenseId);
    const [row] = await owner<{ storage_key: string; entity_type: string }[]>`
      select storage_key, entity_type from public.attachments
       where id = ${attachmentId}::uuid
    `;
    expect(row!.storage_key).toBe(
      `societies/${w.societyId}/expenses/${expenseId}/${attachmentId}.jpg`,
    );
    expect(row!.entity_type).toBe("expense");
  }, 30_000);
});
