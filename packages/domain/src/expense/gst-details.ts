import type { Paise } from "../shared/money";
import type { ExpenseId, SocietyId, UserId } from "../shared/ids";
import type { Gstin } from "../shared/gstin.vo";

/**
 * GST details on an expense — PRD §3.5.3, Roadmap T072.
 *
 * The stored record is 1:1 with an expense and keyed by it (`expense_gst_details`,
 * migration #29): the expense *is* the identity, so there is no id of its own and
 * no version. This module describes the row, the input a `PUT` supplies, the port
 * the API writes through, and the one **non-blocking** reconciliation warning the
 * PRD asks for.
 *
 * ## Money is `Paise`, not `Money`
 *
 * Every component is an unsigned `bigint` paise amount, and the table's own
 * `chk_expense_gst_details_non_negative` guarantees the sign. There is no
 * arithmetic beyond the reconciliation sum — which is exact bigint addition — so
 * the currency-carrying `Money` object would add a construction step and no
 * safety. `taxable_value_paise` and the four tax components are `Paise`.
 */

/** The maximum lengths the columns enforce, restated so the wire cannot exceed them. */
export const GST_INVOICE_NUMBER_MAX_LENGTH = 64;
export const GST_HSN_SAC_MAX_LENGTH = 16;
export const GST_PLACE_OF_SUPPLY_MAX_LENGTH = 40;

/**
 * The stored GST row, in the module's own vocabulary.
 *
 * Nullable fields are nullable for the column's own reason: an invoice number, a
 * date, an HSN code and a place of supply are not always available at the moment
 * the office records a bill, and the product requires them to be recorded rather
 * than to block on them.
 */
export interface ExpenseGstDetailsRecord {
  readonly expenseId: ExpenseId;
  readonly societyId: SocietyId;
  readonly gstin: Gstin | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly taxableValuePaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
  readonly hsnSac: string | null;
  readonly placeOfSupply: string | null;
  readonly isReverseCharge: boolean;
  readonly itcEligible: boolean;
}

/** The whole row a `PUT` writes — `null` clears an optional field. */
export interface ExpenseGstDetailsInput {
  readonly gstin: Gstin | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly taxableValuePaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
  readonly hsnSac: string | null;
  readonly placeOfSupply: string | null;
  readonly isReverseCharge: boolean;
  readonly itcEligible: boolean;
}

/**
 * The one warning code this module emits.
 *
 * Stable and machine-readable, per D7: a client branches on the code, never on
 * the sentence. It travels in the response's `warnings` array, which is
 * structurally separate from an error envelope — a warning means the write
 * **succeeded**.
 */
export const GST_WARNING_CODES = ["TAX_TOTAL_MISMATCH"] as const;
export type GstWarningCode = (typeof GST_WARNING_CODES)[number];

/**
 * A non-blocking reconciliation warning.
 *
 * `differencePaise` is `amount − (taxableValue + cgst + sgst + igst + cess)`: a
 * positive value means the invoice's tax components do not account for as much as
 * the expense, a negative value means they account for more. The amounts travel
 * alongside the code so a screen can show the arithmetic it is warning about
 * without recomputing it.
 */
export interface ExpenseGstWarning {
  readonly code: GstWarningCode;
  readonly taxableValuePaise: Paise;
  readonly taxesPaise: Paise;
  readonly amountPaise: Paise;
  readonly differencePaise: Paise;
}

/** The four tax components summed — the `taxes` half of the PRD's rule. */
export function gstTaxTotal(input: {
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
}): Paise {
  return (input.cgstPaise +
    input.sgstPaise +
    input.igstPaise +
    input.cessPaise) as Paise;
}

/**
 * PRD §3.5.3's rule: `taxable_value + taxes` must equal `amount` — **warn, don't
 * block**, because real invoices carry rounding.
 *
 * Returns an empty list when the two agree, and exactly one
 * `TAX_TOTAL_MISMATCH` warning when they do not. It never refuses: the caller
 * stores the GST row regardless and surfaces the warning beside the success. All
 * three figures are exact bigint paise — the comparison is an integer equality,
 * and no float is anywhere on the path.
 *
 * The check is skipped only when the GST row carries no tax information at all
 * (a zero taxable value **and** zero taxes): that is the "no GST components
 * recorded" state the table's own defaults produce, and warning on it would fire
 * on every expense that merely has a GSTIN on file. A record with any component
 * set is reconciled in full.
 */
export function reconcileGstTaxTotal(
  details: Pick<
    ExpenseGstDetailsRecord,
    "taxableValuePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "cessPaise"
  >,
  amountPaise: Paise,
): readonly ExpenseGstWarning[] {
  const taxesPaise = gstTaxTotal(details);
  const statedPaise = (details.taxableValuePaise + taxesPaise) as Paise;

  if (details.taxableValuePaise === 0n && taxesPaise === 0n) {
    return [];
  }
  if (statedPaise === amountPaise) {
    return [];
  }

  return [
    {
      code: "TAX_TOTAL_MISMATCH",
      taxableValuePaise: details.taxableValuePaise,
      taxesPaise,
      amountPaise,
      differencePaise: (amountPaise - statedPaise) as Paise,
    },
  ];
}

/**
 * The GST row's reads and writes — one per-tenant port.
 *
 * Two operations, and deliberately no delete: the row's life is its expense's
 * (`ON DELETE CASCADE`), and clearing the GST details is a `PUT` that writes the
 * zero/`null` state rather than a "remove the row" (a distinction the product does
 * not make).
 */
export interface ExpenseGstDetailsRepository {
  /** The GST row of one expense, or `null` when none has been recorded. */
  findByExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseGstDetailsRecord | null>;

  /** Insert-or-replace the whole row, and return what is stored. */
  upsertForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    input: ExpenseGstDetailsInput,
    actor: UserId,
  ): Promise<ExpenseGstDetailsRecord>;
}
