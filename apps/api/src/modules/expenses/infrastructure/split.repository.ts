import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { ExpenseError, expenseError, isExpenseError } from "@ses/domain";
import type {
  ExpenseId,
  ExpensePublication,
  ExpensePublicationLookup,
  ExpenseSplitRepository,
  PublishExpenseRecordInput,
  SocietyId,
  UserId,
} from "@ses/domain";
import { z } from "zod";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  EXPENSE_COLUMN_EXPRESSIONS,
  runQuery,
  type Row,
} from "./expense.repository";
import { expenseErrorFromPostgres, unexpectedShapeError } from "./expense.rows";
import {
  idempotencyRecordRowSchema,
  publicationFromRow,
  publicationFromStored,
  publishedExpenseRowSchema,
  storedPublicationOf,
  storedPublicationSchema,
} from "./split.rows";

/**
 * The publishing write path — Roadmap T066's `split.repository.ts`.
 *
 * ## One transaction, three writes, and one function that owns the interesting two
 *
 * ```
 * BEGIN (as the caller)
 *   ├─ read the idempotency record for (caller, key)        ── replay? return it, write nothing
 *   ├─ select … from public.expense_publish(id, society, version, allocations)
 *   │     └─ definer: membership → expense.publish → row lock → lifecycle → version
 *   │                → conservation → splits → status/published_at (one SQL call)
 *   └─ insert the idempotency record (the response a replay must return)
 * COMMIT   (the deferred chk_split_total() trigger judges the final state)
 * ```
 *
 * Everything between `BEGIN` and `COMMIT` is one Postgres transaction: the splits,
 * the transition and the retry record are written together or not at all, which is
 * T066's whole acceptance criterion ("splits, dues, balances and audit all written or
 * none"). The definer function is what makes the *transition* writable at all —
 * `published_at` is not in the `authenticated` UPDATE grant (T060 withheld the
 * lifecycle stamps deliberately) — and the repository is what makes the retry
 * record part of the same commit.
 *
 * ## Why the record is written by the API and not by the function
 *
 * The stored body is the response a replay must return, and the API is what owns the
 * response's shape. Building it here also keeps money exact: the definer function
 * returns `amount_paise` as text, so the stored `jsonb` holds a digit string rather
 * than a JSON number a later parse would put through a double.
 *
 * ## Replay is a read, and a lost race becomes one
 *
 * A key that already produced a publication answers the **stored** response without
 * touching the expense — the retry is safe because nothing is re-executed, not
 * because the lifecycle would refuse a second write. When a *concurrent* duplicate
 * loses the race (both requests read "no record", one commits first), the loser's
 * definer call is refused by the row lock and the version it waited on, and the
 * catch below re-reads the record: a winner's committed record makes the loser a
 * replay, and no record means the refusal stands. That is the mechanism behind
 * "replay the same idempotency key and confirm one publish".
 *
 * ## Failure semantics
 *
 * Every expected refusal arrives as an `ExpenseError` from the classifier
 * (`expense.rows.ts`): `not_found`, `forbidden`, `invalid_transition`,
 * `version_mismatch` (carrying the row's current version), `split_mismatch`,
 * `idempotency_key_reuse`. Nothing about SQLSTATE, constraint names or the driver
 * crosses this boundary, and `run` is the only place the transaction is opened.
 */
@Injectable()
export class ExpenseSplitRepositoryPostgres implements ExpenseSplitRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * The publication this key already committed, or `null` — written nothing either way.
   *
   * Its own small transaction, and deliberately a separate method rather than a flag
   * on `publish`: the use case asks this *before* recomputing, so a retry is answered
   * from the record rather than from the current roster. `publish` asks the same
   * question again inside its own transaction, where the answer has to be read under
   * the same lock as the write.
   */
  async findPublication(
    input: ExpensePublicationLookup,
    actor: UserId,
  ): Promise<ExpensePublication | null> {
    return this.run(actor, async (tx) => {
      const record = await this.readRecord(tx, actor, input.idempotencyKey);
      return record === undefined ? null : replayOf(record, input);
    });
  }

  /** The whole publication, atomically — or a replay of one that already happened. */
  async publish(
    id: ExpenseId,
    societyId: SocietyId,
    input: PublishExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpensePublication> {
    try {
      return await this.run(actor, (tx) =>
        this.publishInTransaction(tx, id, societyId, input, actor),
      );
    } catch (error: unknown) {
      // A concurrent duplicate with the same key may have committed while this
      // transaction was being refused; the record it wrote is the answer this
      // request should have received. A re-read that fails (or finds nothing)
      // never masks the original refusal.
      const replay = await this.replayCommitted(actor, input);
      if (replay !== null) return replay;
      throw enrichVersionMismatch(error, input.expectedVersion);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** The record-first, publish-second, record-last body of the transaction. */
  private async publishInTransaction(
    tx: TransactionContext,
    id: ExpenseId,
    societyId: SocietyId,
    input: PublishExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpensePublication> {
    const existing = await this.readRecord(tx, actor, input.idempotencyKey);
    if (existing !== undefined) {
      return replayOf(existing, input);
    }

    const rows = await runQuery(
      tx,
      sql`
        select ${PUBLISH_COLUMNS}
          from public.expense_publish(
            ${id}::uuid,
            ${societyId}::uuid,
            ${input.expectedVersion}::int,
            ${JSON.stringify(allocationsForPublish(input))}::jsonb
          )
      `,
    );

    const [first] = rows;
    if (first === undefined) {
      throw unexpectedShapeError("published expense");
    }
    const parsed = publishedExpenseRowSchema.safeParse(first);
    if (!parsed.success) {
      throw unexpectedShapeError("published expense");
    }
    const row = parsed.data;

    // Written inside the same transaction as the publication it describes, so a
    // record exists only if the bill does. The unique key means a duplicate that
    // somehow reached this point conflicts — rolled back, re-read as a replay by
    // the caller's catch.
    const stored = storedPublicationOf(row);
    await runQuery(
      tx,
      sql`
        insert into public.idempotency_records (
          user_id, society_id, idempotency_key, request_hash, response_body
        )
        values (
          ${actor}::uuid,
          ${societyId}::uuid,
          ${input.idempotencyKey}::text,
          ${input.requestHash}::text,
          ${JSON.stringify(stored)}::jsonb
        )
      `,
    );

    return publicationFromRow(row, false);
  }

  /** The stored record for one key, or `undefined` when the key is unseen. */
  private async readRecord(
    tx: TransactionContext,
    actor: UserId,
    idempotencyKey: string,
  ): Promise<z.infer<typeof idempotencyRecordRowSchema> | undefined> {
    const rows = await runQuery(
      tx,
      sql`
        select request_hash, response_body
          from public.idempotency_records
         where user_id = ${actor}::uuid
           and idempotency_key = ${idempotencyKey}::text
         limit 1
      `,
    );

    const [first] = rows;
    if (first === undefined) return undefined;
    const parsed = idempotencyRecordRowSchema.safeParse(first);
    if (!parsed.success) {
      throw unexpectedShapeError("idempotency record");
    }
    return parsed.data;
  }

  /**
   * A committed record for this key, read in its own transaction after a refusal.
   *
   * `null` means "not a lost race": either no record exists, or the read itself
   * failed — in both cases the caller's original error is the honest answer. A
   * record whose hash differs is the one case that *replaces* the original error,
   * because a key reused for another request is a client bug worth naming.
   */
  private async replayCommitted(
    actor: UserId,
    input: ExpensePublicationLookup,
  ): Promise<ExpensePublication | null> {
    try {
      return await this.run(actor, async (tx) => {
        const record = await this.readRecord(tx, actor, input.idempotencyKey);
        return record === undefined ? null : replayOf(record, input);
      });
    } catch (error: unknown) {
      if (isExpenseError(error) && error.code === "idempotency_key_reuse") {
        throw error;
      }
      return null;
    }
  }

  /**
   * Runs `work` as `actor`, classifying any failure into the module's vocabulary.
   *
   * The same shape `ExpenseRepositoryPostgres.run` keeps: an `ExpenseError` thrown
   * inside (the replay's key-reuse refusal) passes through untouched, and everything
   * else becomes the module's own error rather than a driver's.
   */
  private async run<T>(
    actor: UserId,
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isExpenseError(error)
        ? error
        : expenseErrorFromPostgres(error, "write");
    }
  }
}

/** One stored record → the publication it recorded, or a typed key-reuse refusal. */
function replayOf(
  record: z.infer<typeof idempotencyRecordRowSchema>,
  input: ExpensePublicationLookup,
): ExpensePublication {
  if (record.request_hash !== input.requestHash) {
    throw expenseError(
      "idempotency_key_reuse",
      "This Idempotency-Key was already used for a different request. Use a new key.",
      { field: "idempotencyKey" },
    );
  }

  const parsed = storedPublicationSchema.safeParse(record.response_body);
  if (!parsed.success) {
    throw unexpectedShapeError("stored publication");
  }
  return publicationFromStored(parsed.data);
}

/**
 * The definer function's row shape: the expense's own columns plus the split
 * summary, composed from T065's expression list so a renamed column cannot reach one
 * select and not the other.
 */
const PUBLISH_COLUMNS = sql.raw(
  [...EXPENSE_COLUMN_EXPRESSIONS, "split_summary"].join(", "),
);

/**
 * The allocations, in the wire shape `expense_publish()` reads.
 *
 * Keys are snake_case (the function reads `entry ->> 'amount_paise'`), money and
 * weights are **digit strings** so no number stands between a bigint and a column,
 * and the snapshot is opaque — the two facts PRD §7.3 asks for, captured at publish
 * time. This is a mapping, not a computation: nothing here adds, divides or re-rounds
 * an amount.
 */
function allocationsForPublish(
  input: PublishExpenseRecordInput,
): readonly (Row & unknown)[] {
  return input.allocations.map((allocation) => ({
    member_id: allocation.memberId,
    apartment_id: allocation.apartmentId,
    amount_paise: allocation.amount.paise.toString(),
    weight: allocation.weight.toString(),
    percent: allocation.percent,
    assigned_reason: allocation.assignedReason,
    snapshot: {
      memberName: allocation.snapshot.memberName,
      apartmentNumber: allocation.snapshot.apartmentNumber,
    },
  }));
}

/**
 * Adds the version the caller stated to a lock refusal, so the SAD §7.11 details
 * carry both numbers (`received` and `current`).
 *
 * The definer function knows the *current* version (it read the row under the lock)
 * and not what the caller expected; the repository knows the input. Enriching here
 * is where the two facts meet, and it is deliberately not folded into the classifier
 * — that function reads a database error, which has no `expectedVersion` in it.
 */
function enrichVersionMismatch(
  error: unknown,
  expectedVersion: number,
): unknown {
  if (!isExpenseError(error) || error.code !== "version_mismatch") {
    return error;
  }
  if (typeof error.details?.["expectedVersion"] === "number") {
    return error;
  }
  return new ExpenseError(error.code, error.message, {
    ...error.details,
    field: "expectedVersion",
    expectedVersion,
  });
}
