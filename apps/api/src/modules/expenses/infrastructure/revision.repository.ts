import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { isExpenseError } from "@ses/domain";
import type {
  ExpenseId,
  ExpenseRevisionRecord,
  ExpenseRevisionRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { expenseErrorFromPostgres, unexpectedShapeError } from "./expense.rows";
import { runQuery } from "./expense.repository";
import { expenseRevisionRowSchema, revisionFromRow } from "./revision.rows";

/**
 * The revision-history read — Roadmap T068, PRD §3.5.3.
 *
 * ## One read, and deliberately read-only
 *
 * The table is append-only at the grant level (no `UPDATE`/`DELETE` is granted to any
 * client role — SAD §8.1), and the only row-writer is the `expense_recalculate()`
 * definer transaction that owns the revision's creation. So the port has exactly one
 * operation, and this adapter has exactly one statement: history, oldest first.
 *
 * ## The ordering is the read's, not the client's
 *
 * `order by version asc` makes the history read **forward** from the published state
 * the first revision replaced — v1 (before), v2, … — which is what the tap-through
 * screen renders and what makes "the revision whose `version` is V describes the state
 * that existed as V" legible without the client sorting anything.
 *
 * ## Visibility is the database's
 *
 * The read runs inside `UnitOfWork` as the caller, so the `expense_revisions_select_member`
 * policy (`can_view_expenses`) decides which rows exist: a member of the society reads
 * the history, a Guest reads nothing, and another tenant's rows are structurally absent
 * rather than filtered here. Every failure is classified by `expense.rows.ts`, so no
 * SQLSTATE or driver text escapes this boundary — the same seam the publish and
 * recalculation writers keep.
 */
@Injectable()
export class ExpenseRevisionRepositoryPostgres implements ExpenseRevisionRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Every revision of one expense, oldest first — never `null`, possibly empty. */
  async listForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseRevisionRecord[]> {
    return this.run(actor, async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select id,
                 expense_id,
                 version,
                 snapshot,
                 changed_by,
                 change_note,
                 created_at
            from public.expense_revisions
           where expense_id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           order by version asc
        `,
      );

      return rows.map((row) => {
        const parsed = expenseRevisionRowSchema.safeParse(row);
        if (!parsed.success) {
          throw unexpectedShapeError("expense revision");
        }
        return revisionFromRow(parsed.data);
      });
    });
  }

  /**
   * One transaction as the caller, failures classified into the module's vocabulary.
   *
   * The same shape `ExpenseRepositoryPostgres.run` keeps: an `ExpenseError` thrown
   * inside passes through untouched, and everything else becomes the module's own
   * error (`not_found` for a row RLS hides, per PRD T041) rather than a driver's.
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
        : expenseErrorFromPostgres(error, "read");
    }
  }
}
