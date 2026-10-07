import { Injectable } from "@nestjs/common";
import {
  asExpenseId,
  asMemberId,
  asSocietyId,
  quotaVerdict,
} from "@ses/domain";
import type {
  AttachmentError,
  AttachmentExpenseSnapshot,
  AttachmentRecord,
  AttachmentRepository,
  ExpenseId,
  ReserveAttachmentInput,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  ATTACHMENT_COLUMN_EXPRESSIONS,
  attachmentErrorFromPostgres,
  attachmentFromRow,
  attachmentRowSchema,
  unexpectedShapeError,
} from "./attachment.rows";

/**
 * `AttachmentRepository` over Postgres, under RLS — Roadmap T071.
 *
 * ## One transaction per operation, with the caller as its identity
 *
 * Every method opens a transaction through `UnitOfWork` with `actor`, which sets
 * `app.user_id` and switches to the `authenticated` role for its duration — so
 * `auth.uid()` inside every committed policy resolves to the caller, and a read or
 * write that forgot the actor would fail closed. This is the same arrangement
 * `ExpenseRepositoryPostgres` uses, and it is what makes the policies in
 * `20261011120000_attachments.sql` the only path to the table.
 *
 * ## `society_id` is in every `WHERE`, including the ones keyed by `id`
 *
 * An attachment id alone does not say which tenant the caller is acting in, so
 * every statement pairs the two — belt and braces beside RLS, and what makes a
 * cross-society id *unaddressable* as well as unreadable.
 *
 * ## The quota reservation is one transaction, and the lock order is the ADR's
 *
 * `reserve` is the only method with real subtlety. It runs, in one transaction:
 *
 * ```text
 *   select public.attachment_presign_lock($society)   -- societies row, FOR UPDATE
 *   select coalesce(sum(size_bytes), 0) …             -- completed + live reservations
 *   -- the caller's plan cap, compared here
 *   insert into public.attachments … returning …
 * ```
 *
 * The lock is what makes the read-then-insert atomic (ADR-0012 D2). Without it two
 * concurrent presigns both observe the same headroom and both reserve it — the
 * over-reservation the brief names — because neither can see the other's
 * uncommitted row. With it, the second transaction's sum already includes the
 * first's row. The edge is `societies → attachments` and nothing else, so it cannot
 * cycle with the money ordering (`expense → dues → member_balances`): no other
 * statement in the schema takes `societies` `FOR UPDATE`, and nothing else locks an
 * `attachments` row.
 *
 * The comparison itself is `quotaVerdict` in `@ses/domain`, not an inline `>`: the
 * exact-equality boundary (`used + requested === cap` is **allowed**) is a product
 * rule with a test on it, and an off-by-one here would refuse a legitimate upload
 * at precisely the moment a society filled its last plan.
 *
 * ## No lock is taken by `markComplete`
 *
 * Completion's statement is a single conditional `UPDATE` with `RETURNING`,
 * `WHERE completed_at IS NULL`. Two concurrent completions therefore serialize on
 * the row itself — one updates, the other matches zero rows and re-reads, which is
 * the replay path — and no explicit lock is needed. Adding one would create a
 * second lock edge out of this table for no benefit.
 */
@Injectable()
export class AttachmentRepositoryPostgres implements AttachmentRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** The parent expense, or `null` when it is not visible to this caller. */
  async findExpenseForAttachment(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<AttachmentExpenseSnapshot | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select id, society_id, status::text as status, created_by
            from public.expenses
           where id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );

      const [row] = rows;
      if (row === undefined) return null;

      const parsed = expenseSnapshotRowSchema.safeParse(row);
      if (!parsed.success) {
        throw unexpectedShapeError("expense projection");
      }

      return {
        id: asExpenseId(parsed.data.id),
        societyId: asSocietyId(parsed.data.society_id),
        status: parsed.data.status,
        createdBy:
          parsed.data.created_by === null
            ? null
            : asMemberId(parsed.data.created_by),
      };
    });
  }

  /**
   * The society's stored plan, verbatim. See the port for why it is not mapped.
   *
   * The column is `societies.plan` — the *type* is `public.subscription_plan`
   * (`20260920130000_society_core.sql`). Casting to `text` is deliberate: an enum
   * value that a later migration adds must reach the API as an unpriceable string
   * rather than failing the decode here, which is what makes the quota map's
   * fail-closed branch reachable at all.
   */
  async readSocietySubscriptionPlan(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<string | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select s.plan::text as plan
            from public.societies s
           where s.id = ${societyId}::uuid
           limit 1
        `,
      );
      const [row] = rows;
      if (row === undefined) return null;
      const plan = row["plan"];
      return typeof plan === "string" ? plan : null;
    });
  }

  /** Lock the society, sum the usage, insert — or refuse with the caller's cap. */
  async reserve(
    input: ReserveAttachmentInput,
    actor: UserId,
  ): Promise<Result<AttachmentRecord, AttachmentError>> {
    return this.run(actor, "write", async (tx) => {
      // 1 · The society row, `FOR UPDATE`. Through a definer function because
      //     `authenticated` holds only column-level UPDATE on `societies` and so
      //     cannot take the lock itself — and widening that grant to allow it would
      //     also hand a caller the derived columns `society_update()` withholds.
      await runQuery(
        tx,
        sql`select public.attachment_presign_lock(${input.societyId}::uuid)`,
      );

      // 2 · What this society is already using. A completed row always counts; an
      //     incomplete row counts while its presigned URL could still be used, which
      //     is the presign TTL plus nothing (ADR-0012 D2). `now()` is the database's
      //     clock, so the window cannot be widened by a skewed API host.
      const usageRows = await runQuery(
        tx,
        sql`
          select coalesce(sum(size_bytes), 0)::text as used_bytes
            from public.attachments
           where society_id = ${input.societyId}::uuid
             and (
               completed_at is not null
               or created_at > now() - interval '15 minutes'
             )
        `,
      );

      const usedBytes = parseByteCount(usageRows[0]?.["used_bytes"]);

      // 3 · The decision. `quotaVerdict` allows exactly-equal and refuses greater,
      //     and returns the refusal rather than throwing — running out of space is a
      //     402, not an exception.
      const verdict = quotaVerdict(
        usedBytes,
        input.sizeBytes,
        input.planCapBytes,
      );
      if (!verdict.ok) return verdict;

      // 4 · The row. The id, the key, the checksum, the size and the scan status are
      //     all decided by the use case and re-asserted by the insert policy, so this
      //     statement writes facts the database independently agrees with.
      //
      //     The id is written explicitly rather than left to `gen_random_uuid()`: the
      //     caller already put it in the storage key, and a second uuid here would
      //     leave every key naming a row that does not exist.
      const inserted = await runQuery(
        tx,
        sql`
          insert into public.attachments (
            id, society_id, entity_type, entity_id, storage_key, original_filename,
            mime_type, size_bytes, checksum, uploaded_by
          )
          values (
            ${input.id}::uuid,
            ${input.societyId}::uuid,
            ${input.entityType}::varchar,
            ${input.entityId}::uuid,
            ${input.storageKey}::varchar,
            ${input.originalFilename}::varchar,
            ${input.mimeType}::varchar,
            ${input.sizeBytes}::int,
            ${input.checksum}::varchar,
            ${input.uploadedBy}::uuid
          )
          returning ${ATTACHMENT_COLUMNS}
        `,
      );

      return {
        ok: true,
        value: parseSingleRow(inserted, "reserved attachment"),
      };
    });
  }

  /** One attachment of one society, `null` when the caller may not see it. */
  async findById(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<AttachmentRecord | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select ${ATTACHMENT_COLUMNS}
            from public.attachments
           where id = ${attachmentId}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );
      const [row] = rows;
      return row === undefined ? null : attachmentFromRow(parseRow(row));
    });
  }

  /**
   * Stamp `completed_at` on a still-pending row, or explain why it did not.
   *
   * `WHERE completed_at IS NULL` is the whole concurrency story: a second
   * completion matches no row, and the re-read then finds the stamp already set and
   * answers **the same success** the first caller got (ADR-0012: "Completion replay
   * is a 200 no-op"). The distinction between "already done" and "not allowed" is
   * made from the row, never guessed from the affected count.
   *
   * A row that exists, is not complete, and still matched nothing can only be one
   * thing: the UPDATE policy refused it, which happens when the parent expense is
   * `void` or the caller's role narrowed away. That is classified as `forbidden`,
   * and the use case turns it into the lifecycle refusal its own gate would have
   * produced — the database's refusal is the backstop, not the message.
   */
  async markComplete(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Result<AttachmentRecord, AttachmentError>> {
    return this.run(actor, "write", async (tx) => {
      const updated = await runQuery(
        tx,
        sql`
          update public.attachments
             set completed_at = now()
           where id = ${attachmentId}::uuid
             and society_id = ${societyId}::uuid
             and completed_at is null
          returning ${ATTACHMENT_COLUMNS}
        `,
      );

      const [row] = updated;
      if (row !== undefined) {
        return { ok: true, value: attachmentFromRow(parseRow(row)) };
      }

      // Nothing matched. Read the row back and answer from what it actually says.
      const current = await runQuery(
        tx,
        sql`
          select ${ATTACHMENT_COLUMNS}
            from public.attachments
           where id = ${attachmentId}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );

      const [existing] = current;
      if (existing === undefined) {
        return {
          ok: false,
          error: attachmentErrorFromPostgres(
            { code: "P0002", message: "EXPENSE_NOT_FOUND" },
            "read",
          ),
        };
      }

      const parsed = attachmentFromRow(parseRow(existing));
      // Already complete: the replay path, and a success.
      if (parsed.completedAt !== null) return { ok: true, value: parsed };

      return {
        ok: false,
        error: attachmentErrorFromPostgres(
          { code: "42501", message: "row-level security" },
          "write",
        ),
      };
    });
  }

  /**
   * Remove one row.
   *
   * `DELETE … RETURNING id` so the answer is the statement's own, not a
   * read-back — and a refusal is classified from what remains, which is the same
   * shape the other adapters use. The caller has already made the authorization
   * decision (`canOnResource` plus D6.4's uploader branch); this method's refusals
   * are the database's independent half of it.
   */
  async deleteById(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      const deleted = await runQuery(
        tx,
        sql`
          delete from public.attachments
           where id = ${attachmentId}::uuid
             and society_id = ${societyId}::uuid
          returning id
        `,
      );

      if (deleted.length > 0) return;

      const current = await runQuery(
        tx,
        sql`
          select id from public.attachments
           where id = ${attachmentId}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );

      throw attachmentErrorFromPostgres(
        current.length === 0
          ? { code: "P0002", message: "EXPENSE_NOT_FOUND" }
          : { code: "42501", message: "row-level security" },
        current.length === 0 ? "read" : "write",
      );
    });
  }

  /**
   * A draft's attachment keys, read **before** the draft is deleted.
   *
   * The `WHERE` is the polymorphic pair plus the tenant, so it reads exactly the
   * rows `expense_draft_delete()` is about to remove. `ORDER BY created_at` makes
   * the answer stable, which matters only for a log line — the objects are deleted
   * independently and a partial failure is swept.
   */
  async listStorageKeysForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly string[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select storage_key
            from public.attachments
           where entity_type = 'expense'
             and entity_id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           order by created_at asc
        `,
      );

      const parsed = storageKeyRowListSchema.safeParse(rows);
      if (!parsed.success) {
        throw unexpectedShapeError("attachment storage keys");
      }
      return parsed.data.map((row) => row.storage_key);
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Runs `work` as `actor` and classifies any failure into this module's vocabulary. */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw attachmentErrorFromPostgres(error, context);
    }
  }
}

/** The projection over `expenses` this module reads — four columns, never more. */
const expenseSnapshotRowSchema = z.object({
  id: z.uuid(),
  society_id: z.uuid(),
  status: z.string(),
  created_by: z.uuid().nullable(),
});

const storageKeyRowListSchema = z.array(z.object({ storage_key: z.string() }));

const ATTACHMENT_COLUMNS = sql.raw(ATTACHMENT_COLUMN_EXPRESSIONS.join(", "));

type Row = Record<string, unknown>;

async function runQuery(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parseRow(row: unknown) {
  const parsed = attachmentRowSchema.safeParse(row);
  if (!parsed.success) {
    throw unexpectedShapeError("attachment");
  }
  return parsed.data;
}

function parseSingleRow(rows: readonly Row[], what: string): AttachmentRecord {
  const [first] = rows;
  if (first === undefined) {
    throw unexpectedShapeError(what);
  }
  return attachmentFromRow(parseRow(first));
}

/**
 * `bigint`/`numeric` arrives as a string from `postgres.js`; `sum` over an
 * `integer` column is `bigint`, so this is the normal case rather than the
 * exception. `NaN` is reported as the cap-breaching maximum rather than as `0`:
 * an unreadable usage figure must fail closed, and treating it as "nothing stored"
 * would let a society with 500 MB already uploaded reserve another 500 MB.
 */
function parseByteCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }
  return Number.MAX_SAFE_INTEGER;
}
