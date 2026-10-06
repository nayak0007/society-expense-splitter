import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { expenseError, isExpenseError } from "@ses/domain";
import type {
  ExpenseId,
  ExpensePublication,
  ExpensePublicationLookup,
  ExpenseRecalculation,
  ExpenseSplitRepository,
  ExpenseVoid,
  PublishExpenseAllocation,
  PublishExpenseRecordInput,
  RecalculateExpenseRecordInput,
  SocietyId,
  UserId,
  VoidExpenseRecordInput,
} from "@ses/domain";
import { z } from "zod";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  EXPENSE_COLUMN_EXPRESSIONS,
  readExpenseWorkflowStamps,
  runQuery,
  type Row,
} from "./expense.repository";
import {
  enrichVersionMismatch,
  expenseErrorFromPostgres,
  expenseFromRow,
  unexpectedShapeError,
} from "./expense.rows";
import {
  idempotencyRecordRowSchema,
  publicationFromRow,
  publicationFromStored,
  publishedExpenseRowSchema,
  recalculationSummaryFromRow,
  recalculatedExpenseRowSchema,
  storedPublicationOf,
  storedPublicationSchema,
  voidedExpenseRowSchema,
  voidSummaryFromRow,
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
 *   │                → conservation → splits → dues (one per split)
 *   │                → member_balances upsert → status/published_at (one SQL call)
 *   └─ insert the idempotency record (the response a replay must return)
 * COMMIT   (the deferred chk_split_total() and trg_due_billable_write triggers
 *           judge the final state)
 * ```
 *
 * Everything between `BEGIN` and `COMMIT` is one Postgres transaction: the splits,
 * the receivables, the balances, the transition and the retry record are written
 * together or not at all, which is T066's whole acceptance criterion ("splits, dues,
 * balances and audit all written or none" — audit rows remain T050's absent half,
 * recorded in the T066/T067 reports). The dues and balances landed in T067 inside
 * the *same* function, not as a second call this repository makes: a separate write
 * would be a second commit or a second path, and the balance delta's arithmetic
 * would have to leave SQL (where the conflicting row's lock serialises it) for an
 * application read-modify-write. The definer function is what makes the *transition* writable at all —
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
   * T068's published-edit transaction — one call to `expense_recalculate()`.
   *
   * No retry record: a published edit is locked by `expectedVersion`, and a lost
   * response is recovered by the client re-reading the expense (the response's new
   * version makes that unambiguous). The whole revision — revision row, split and
   * due lifecycle, balance deltas — is the definer function's single transaction;
   * this method maps the plan and the editable fields into the function's jsonb
   * inputs and classifies the row back out. Money and weights are digit strings,
   * as on the publish path; the one exception is `amountPaise`, which the function
   * reads as a JSON number because it is the expense's own column-scale value and
   * the contract already bounds it at `Number.MAX_SAFE_INTEGER`.
   */
  async recalculate(
    id: ExpenseId,
    societyId: SocietyId,
    input: RecalculateExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecalculation> {
    try {
      return await this.run(actor, async (tx) => {
        const rows = await runQuery(
          tx,
          sql`
            select ${RECALCULATE_COLUMNS}
              from public.expense_recalculate(
                ${id}::uuid,
                ${societyId}::uuid,
                ${input.expectedVersion}::int,
                ${JSON.stringify(fieldsForRecalculation(input))}::jsonb,
                ${JSON.stringify(allocationsForPublish(input))}::jsonb,
                ${input.changeNote ?? null}::text
              )
          `,
        );

        const [first] = rows;
        if (first === undefined) {
          throw unexpectedShapeError("recalculated expense");
        }
        const parsed = recalculatedExpenseRowSchema.safeParse(first);
        if (!parsed.success) {
          throw unexpectedShapeError("recalculated expense");
        }
        const row = parsed.data;

        return {
          expense: expenseFromRow(
            row,
            await readExpenseWorkflowStamps(tx, id, societyId),
          ),
          summary: recalculationSummaryFromRow(row.recalculation),
        };
      });
    } catch (error: unknown) {
      throw enrichVersionMismatch(error, input.expectedVersion);
    }
  }

  /**
   * T069's void transaction — one call to `expense_void()`, ADR-0010.
   *
   * No retry record and no second write: the whole reversal (the due
   * supersession, the balance deltas, the recomputed `oldest_due_date` and the
   * expense's void stamps) is the definer function's single transaction, and a
   * stale `expectedVersion` is refused by the row lock rather than replayed. The
   * two inputs are the optimistic lock and the operator's reason; nothing
   * financial travels from here, because a client cannot be allowed to state what
   * a reversal is worth.
   */
  async voidExpense(
    id: ExpenseId,
    societyId: SocietyId,
    input: VoidExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseVoid> {
    try {
      return await this.run(actor, async (tx) => {
        const rows = await runQuery(
          tx,
          sql`
            select ${VOID_COLUMNS}
              from public.expense_void(
                ${id}::uuid,
                ${societyId}::uuid,
                ${input.expectedVersion}::int,
                ${input.reason}::text
              )
          `,
        );

        const [first] = rows;
        if (first === undefined) {
          throw unexpectedShapeError("voided expense");
        }
        const parsed = voidedExpenseRowSchema.safeParse(first);
        if (!parsed.success) {
          throw unexpectedShapeError("voided expense");
        }
        const row = parsed.data;

        return {
          expense: expenseFromRow(
            row,
            await readExpenseWorkflowStamps(tx, id, societyId),
          ),
          summary: voidSummaryFromRow(row.void_summary),
        };
      });
    } catch (error: unknown) {
      throw enrichVersionMismatch(error, input.expectedVersion);
    }
  }

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

    // T070: the stamps are read back in the same transaction, where the definer
    // function's write is already visible, so both the live response and the stored
    // replay body describe the approval state instead of dropping it (
    // `expense_publish()`'s signature predates T070 and is deliberately unchanged).
    const workflow = await readExpenseWorkflowStamps(tx, id, societyId);

    // Written inside the same transaction as the publication it describes, so a
    // record exists only if the bill does. The unique key means a duplicate that
    // somehow reached this point conflicts — rolled back, re-read as a replay by
    // the caller's catch.
    const stored = storedPublicationOf(row, workflow);
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

    return publicationFromRow(row, false, workflow);
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

/** The recalculation function's row: the expense's columns plus the diff. */
const RECALCULATE_COLUMNS = sql.raw(
  [...EXPENSE_COLUMN_EXPRESSIONS, "recalculation"].join(", "),
);

/** The void function's row: the expense's columns plus the reversal summary. */
const VOID_COLUMNS = sql.raw(
  [...EXPENSE_COLUMN_EXPRESSIONS, "void_summary"].join(", "),
);

/**
 * The published-editable fields, in the function's own key vocabulary.
 *
 * Only the keys the caller sent travel — the definer function distinguishes an
 * absent key (unchanged) from a present `null` (clear) — and the camelCase names
 * are the function's (`p_fields ? 'amountPaise'`), not a second spelling of the
 * columns: this object never touches a table directly. `amountPaise` becomes a
 * JSON number because the function's validation reads it as one; the bound the
 * contract already enforced is re-asserted here, because a definer input should
 * never be the place a value silently leaves the safe integer range.
 */
function fieldsForRecalculation(
  input: RecalculateExpenseRecordInput,
): Readonly<Record<string, unknown>> {
  const fields = input.fields;
  const payload: Record<string, unknown> = {};
  if (fields.title !== undefined) payload["title"] = fields.title;
  if (fields.description !== undefined)
    payload["description"] = fields.description;
  if (fields.vendorName !== undefined)
    payload["vendorName"] = fields.vendorName;
  if (fields.amountPaise !== undefined) {
    if (fields.amountPaise > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw expenseError(
        "invariant",
        "The amount is above the range this wire can carry exactly.",
        { field: "amountPaise" },
      );
    }
    payload["amountPaise"] = Number(fields.amountPaise);
  }
  if (fields.splitStrategy !== undefined) {
    payload["splitStrategy"] = fields.splitStrategy;
  }
  if (fields.apartmentBasis !== undefined) {
    payload["apartmentBasis"] = fields.apartmentBasis;
  }
  if (fields.splitConfig !== undefined)
    payload["splitConfig"] = fields.splitConfig;
  if (fields.participantSelector !== undefined) {
    payload["participantSelector"] = fields.participantSelector;
  }
  return payload;
}

/**
 * The allocations, in the wire shape `expense_publish()` reads.
 *
 * Keys are snake_case (the function reads `entry ->> 'amount_paise'`), money and
 * weights are **digit strings** so no number stands between a bigint and a column,
 * and the snapshot is opaque — the two facts PRD §7.3 asks for, captured at publish
 * time. This is a mapping, not a computation: nothing here adds, divides or re-rounds
 * an amount.
 */
function allocationsForPublish(input: {
  readonly allocations: readonly PublishExpenseAllocation[];
}): readonly (Row & unknown)[] {
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
