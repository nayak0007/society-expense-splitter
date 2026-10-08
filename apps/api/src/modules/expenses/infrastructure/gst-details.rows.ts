import {
  asExpenseId,
  asGstin,
  asSocietyId,
  isValidGstin,
  paise,
} from "@ses/domain";
import type { ExpenseGstDetailsRecord } from "@ses/domain";
import { z } from "zod";

/**
 * The database ⇄ domain boundary for `expense_gst_details` — Roadmap T072.
 *
 * The same position `revision.rows.ts` holds for the history read: one file decides
 * every nullability, `bigint` crossing and validation so the repository cannot
 * drift from the shape the route serializes.
 *
 * ## Paise crosses as text, deliberately
 *
 * `taxable_value_paise` and the four tax components are `bigint` columns, and the
 * one thing this module cannot tolerate is money passing through a float. So the
 * repository selects them `::text`, this schema keeps each a digit string, and the
 * mapper converts with `BigInt` → `paise()` — exactly the convention
 * `expense.rows.ts` records for `amount_paise` (ADR-0005's single crossing point).
 *
 * ## `gstin` is re-validated on the way out
 *
 * The value is validated on the way in, but a column can be written by a
 * migration, a backfill or a direct statement. Re-checking the checksum here means
 * a row that no longer satisfies the rule fails loudly at the boundary rather than
 * reaching a client as a GSTIN the product's own validator rejects.
 */

export const expenseGstRowSchema = z.object({
  expense_id: z.string(),
  society_id: z.string(),
  gstin: z
    .string()
    .refine((value) => isValidGstin(value), {
      message: "A stored GSTIN is not checksum-valid.",
    })
    .nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  taxable_value_paise: z.string().regex(/^\d+$/),
  cgst_paise: z.string().regex(/^\d+$/),
  sgst_paise: z.string().regex(/^\d+$/),
  igst_paise: z.string().regex(/^\d+$/),
  cess_paise: z.string().regex(/^\d+$/),
  hsn_sac: z.string().nullable(),
  place_of_supply: z.string().nullable(),
  is_reverse_charge: z.boolean(),
  itc_eligible: z.boolean(),
});
export type ExpenseGstRow = z.infer<typeof expenseGstRowSchema>;

/**
 * The columns every read and write returns, in one place.
 *
 * The five amounts are cast to text and the date is kept a date (never a `Date`
 * object), matching the expense row's own convention.
 */
export const EXPENSE_GST_COLUMN_EXPRESSIONS: readonly string[] = [
  "expense_id",
  "society_id",
  "gstin",
  "invoice_number",
  "invoice_date::text as invoice_date",
  "taxable_value_paise::text as taxable_value_paise",
  "cgst_paise::text as cgst_paise",
  "sgst_paise::text as sgst_paise",
  "igst_paise::text as igst_paise",
  "cess_paise::text as cess_paise",
  "hsn_sac",
  "place_of_supply",
  "is_reverse_charge",
  "itc_eligible",
];

/** One `expense_gst_details` row → the flat record the use cases return. */
export function gstDetailsFromRow(row: ExpenseGstRow): ExpenseGstDetailsRecord {
  return {
    expenseId: asExpenseId(row.expense_id),
    societyId: asSocietyId(row.society_id),
    gstin: row.gstin === null ? null : asGstin(row.gstin),
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    taxableValuePaise: paise(BigInt(row.taxable_value_paise)),
    cgstPaise: paise(BigInt(row.cgst_paise)),
    sgstPaise: paise(BigInt(row.sgst_paise)),
    igstPaise: paise(BigInt(row.igst_paise)),
    cessPaise: paise(BigInt(row.cess_paise)),
    hsnSac: row.hsn_sac,
    placeOfSupply: row.place_of_supply,
    isReverseCharge: row.is_reverse_charge,
    itcEligible: row.itc_eligible,
  };
}
