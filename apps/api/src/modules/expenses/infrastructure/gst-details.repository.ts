import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { isExpenseError } from "@ses/domain";
import type {
  ExpenseGstDetailsInput,
  ExpenseGstDetailsRecord,
  ExpenseGstDetailsRepository,
  ExpenseId,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { expenseErrorFromPostgres, unexpectedShapeError } from "./expense.rows";
import { runQuery, type Row } from "./expense.repository";
import {
  EXPENSE_GST_COLUMN_EXPRESSIONS,
  expenseGstRowSchema,
  gstDetailsFromRow,
} from "./gst-details.rows";

/**
 * `ExpenseGstDetailsRepository` over Postgres, under RLS — Roadmap T072.
 *
 * ## The upsert is one atomic statement (D6)
 *
 * `INSERT … ON CONFLICT (expense_id) DO UPDATE` is the whole write: there is no
 * read-then-write window, so two callers saving the GST form at once cannot
 * interleave into a half-updated row. It also writes only `expense_gst_details`,
 * which is what makes D5 automatic — the approval stamps live on `expenses`, and a
 * statement that does not name that table cannot clear them.
 *
 * ## The `DO UPDATE` set-list is the grant list, exactly
 *
 * `society_id` is *not* updated: the composite key to `expenses` keeps the row in
 * its expense's society, and the column is outside the `UPDATE` grant the migration
 * issues, so setting it here would be a `42501` at write time. The twelve columns
 * that are set are the twelve the grant allows and no others.
 *
 * ## Authorisation is the database's, and the classification is this module's
 *
 * The RLS policies on `expense_gst_details` decide who may write (Admin/Treasurer,
 * or a draft-owner Committee Member). This adapter does not re-implement them; the
 * use case's `canOnResource` site is the *narrowing* the route inventory requires,
 * and a violation the policies do refuse becomes the module's typed error through
 * `expenseErrorFromPostgres`, never a raw SQLSTATE.
 */
@Injectable()
export class ExpenseGstDetailsRepositoryPostgres implements ExpenseGstDetailsRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** The GST row of one expense, or `null` — never a thrown "absent". */
  async findByExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseGstDetailsRecord | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select ${EXPENSE_GST_COLUMNS}
            from public.expense_gst_details
           where expense_id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );
      const [row] = rows;
      return row === undefined ? null : parseGstRow(row);
    });
  }

  /** Insert-or-replace the whole row, and read back what is stored. */
  async upsertForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    input: ExpenseGstDetailsInput,
    actor: UserId,
  ): Promise<ExpenseGstDetailsRecord> {
    return this.run(actor, "write", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          insert into public.expense_gst_details (
            expense_id, society_id, gstin, invoice_number, invoice_date,
            taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
            hsn_sac, place_of_supply, is_reverse_charge, itc_eligible
          )
          values (
            ${expenseId}::uuid,
            ${societyId}::uuid,
            ${input.gstin}::varchar,
            ${input.invoiceNumber}::varchar,
            ${input.invoiceDate}::date,
            ${input.taxableValuePaise.toString()}::bigint,
            ${input.cgstPaise.toString()}::bigint,
            ${input.sgstPaise.toString()}::bigint,
            ${input.igstPaise.toString()}::bigint,
            ${input.cessPaise.toString()}::bigint,
            ${input.hsnSac}::varchar,
            ${input.placeOfSupply}::varchar,
            ${input.isReverseCharge}::boolean,
            ${input.itcEligible}::boolean
          )
          on conflict (expense_id) do update
            set gstin = excluded.gstin,
                invoice_number = excluded.invoice_number,
                invoice_date = excluded.invoice_date,
                taxable_value_paise = excluded.taxable_value_paise,
                cgst_paise = excluded.cgst_paise,
                sgst_paise = excluded.sgst_paise,
                igst_paise = excluded.igst_paise,
                cess_paise = excluded.cess_paise,
                hsn_sac = excluded.hsn_sac,
                place_of_supply = excluded.place_of_supply,
                is_reverse_charge = excluded.is_reverse_charge,
                itc_eligible = excluded.itc_eligible
          returning ${EXPENSE_GST_COLUMNS}
        `,
      );
      const [row] = rows;
      if (row === undefined) {
        throw unexpectedShapeError("expense GST details");
      }
      return parseGstRow(row);
    });
  }

  /**
   * Runs `work` as `actor`, failures classified into the module's vocabulary.
   *
   * The same shape every adapter in this module keeps: an `ExpenseError` thrown
   * inside passes through untouched, everything else becomes the module's own
   * error (`not_found` for a row RLS hides, per PRD T041).
   */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isExpenseError(error)
        ? error
        : expenseErrorFromPostgres(error, context);
    }
  }
}

const EXPENSE_GST_COLUMNS = sql.raw(EXPENSE_GST_COLUMN_EXPRESSIONS.join(", "));

function parseGstRow(row: Row): ExpenseGstDetailsRecord {
  const parsed = expenseGstRowSchema.safeParse(row);
  if (!parsed.success) {
    throw unexpectedShapeError("expense GST details");
  }
  return gstDetailsFromRow(parsed.data);
}
