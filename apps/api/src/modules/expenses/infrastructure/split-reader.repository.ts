import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  asApartmentId,
  asExpenseId,
  asMemberId,
  isExpenseError,
  Money,
  paise,
} from "@ses/domain";
import type {
  ExpenseId,
  ExpenseSplitRecord,
  ExpenseSplitsReader,
  SocietyId,
  UserId,
} from "@ses/domain";
import { z } from "zod";

import { timestampSchema } from "../../../common/database/postgres-rows";
import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { expenseErrorFromPostgres, unexpectedShapeError } from "./expense.rows";
import { runQuery } from "./expense.repository";

/**
 * The current-splits read — Roadmap T073, PRD §3.5.3's split table.
 *
 * ## Read-only, and the only statement is the read
 *
 * `expense_splits` is written exclusively by the `expense_publish()` and
 * `expense_recalculate()` definer transactions (T066/T068); nothing above
 * infrastructure may open a second writer, so this adapter has one statement and no
 * write path. The rows it returns are the **live** allocation — deliberately not
 * recomputed from the participant selector (a fresh calculation is a second
 * split-engine path that could disagree with the bill) and deliberately not taken from
 * `expense_revisions.snapshot` (that is history, not current state).
 *
 * ## Money and weights keep the exact crossing
 *
 * `amount_paise::text` and `weight::text`/`percent::text` are read as digit strings and
 * crossed exactly — `BigInt` → `paise()` → `Money.fromPaise` for the amount, and the
 * decimals kept as strings — so no money value passes through a float anywhere
 * (ADR-0005). `snapshot` is an opaque stored record, read as-is.
 *
 * ## Visibility is the database's
 *
 * The read runs inside `UnitOfWork` as the caller, so `can_view_expenses` RLS decides
 * which rows exist: a member of the society reads the split table, a Guest reads
 * nothing, and another tenant's rows are structurally absent rather than filtered here.
 * The `society_id` predicate beside `expense_id` makes a cross-society id
 * unaddressable as well as unreadable. Failures are classified by `expense.rows.ts`, so
 * no SQLSTATE escapes this boundary.
 */
@Injectable()
export class ExpenseSplitsReaderPostgres implements ExpenseSplitsReader {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Every current split of one expense, oldest first — never `null`, possibly empty. */
  async listForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseSplitRecord[]> {
    return this.run(actor, async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select id,
                 expense_id,
                 member_id,
                 apartment_id,
                 amount_paise::text as amount_paise,
                 weight::text as weight,
                 percent::text as percent,
                 assigned_reason,
                 snapshot,
                 created_at
            from public.expense_splits
           where expense_id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           order by created_at asc, id asc
        `,
      );

      return rows.map((row) => splitFromRow(parseRow(row)));
    });
  }

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

/**
 * The row's shape, validated not trusted.
 *
 * `amount_paise` is a digit string (the repository selects `::text`), `weight` and
 * `percent` are nullable numeric strings, and `snapshot` is an opaque object the
 * mapper reads defensively — a stored snapshot that a later build wrote with more keys
 * must not fail this parse, and one that is missing a key must render as `null` rather
 * than `undefined`.
 */
const expenseSplitRowSchema = z.object({
  id: z.uuid(),
  expense_id: z.uuid(),
  member_id: z.uuid().nullable(),
  apartment_id: z.uuid().nullable(),
  amount_paise: z.string().regex(/^\d+$/),
  weight: z.string().nullable(),
  percent: z.string().nullable(),
  assigned_reason: z.string().nullable(),
  snapshot: z.unknown(),
  created_at: timestampSchema,
});

type ExpenseSplitRow = z.infer<typeof expenseSplitRowSchema>;

const splitSnapshotSchema = z.object({
  memberName: z.string().nullable().optional(),
  apartmentNumber: z.string().nullable().optional(),
});

function parseRow(row: unknown): ExpenseSplitRow {
  const parsed = expenseSplitRowSchema.safeParse(row);
  if (!parsed.success) {
    throw unexpectedShapeError("expense split");
  }
  return parsed.data;
}

/** One row → the module's record, money crossed exactly. */
function splitFromRow(row: ExpenseSplitRow): ExpenseSplitRecord {
  const snapshot = splitSnapshotSchema.safeParse(row.snapshot);

  return {
    id: row.id,
    expenseId: asExpenseId(row.expense_id),
    memberId: row.member_id === null ? null : asMemberId(row.member_id),
    apartmentId:
      row.apartment_id === null ? null : asApartmentId(row.apartment_id),
    amount: Money.fromPaise(paise(BigInt(row.amount_paise))),
    weight: row.weight,
    percent: row.percent,
    assignedReason: normalizeAssignedReason(row.assigned_reason),
    snapshot: {
      memberName: snapshot.success ? (snapshot.data.memberName ?? null) : null,
      apartmentNumber: snapshot.success
        ? (snapshot.data.apartmentNumber ?? null)
        : null,
    },
    createdAt: row.created_at,
  };
}

/**
 * `assigned_reason` is `varchar(40)` and carries one of the split reasons; the wire
 * type is the closed `AssignedReason` union. A value the build does not know is passed
 * through as `null` rather than refusing the whole split table — the reason is
 * explanatory metadata, and a row whose *amount* is right must not be dropped because
 * its annotation is from a newer vocabulary.
 */
function normalizeAssignedReason(value: string | null) {
  return value === null
    ? null
    : (value as ExpenseSplitRecord["assignedReason"]);
}
