/**
 * `expense_gst_details` — the optional 1:1 GST record for an expense
 * (PRD §7.3, §3.5.3 "GST Details").
 *
 * Keyed by `expense_id`: the expense *is* the identity, so there is no separate id,
 * no `created_at`/`updated_at` and no `version` — nothing about a GST detail has a
 * life of its own. `society_id` is added for the reason SAD §8.1 gives ("every tenant
 * table carries it"): it is what the RLS policy reads and what the composite key uses
 * to keep the row in its expense's society.
 *
 * The regime check (`NOT (igst_paise > 0 AND (cgst_paise > 0 OR sgst_paise > 0))` —
 * an invoice is intra-state or inter-state, never both) and the grants live in
 * `supabase/migrations/20261001120000_expense_schema.sql`.
 */

import { bigint, boolean, date, uuid, varchar } from "drizzle-orm/pg-core";

export const expenseGstDetails = {
  expenseId: uuid("expense_id").primaryKey(),
  societyId: uuid("society_id").notNull(),
  /** 15 characters, checksum-validated in the domain before it reaches here. */
  gstin: varchar("gstin", { length: 15 }),
  invoiceNumber: varchar("invoice_number", { length: 64 }),
  invoiceDate: date("invoice_date"),

  /** Paise, and every component is unsigned: a credit note is a different document. */
  taxableValuePaise: bigint("taxable_value_paise", { mode: "bigint" })
    .notNull()
    .default(0n),
  cgstPaise: bigint("cgst_paise", { mode: "bigint" }).notNull().default(0n),
  sgstPaise: bigint("sgst_paise", { mode: "bigint" }).notNull().default(0n),
  igstPaise: bigint("igst_paise", { mode: "bigint" }).notNull().default(0n),
  cessPaise: bigint("cess_paise", { mode: "bigint" }).notNull().default(0n),

  hsnSac: varchar("hsn_sac", { length: 16 }),
  placeOfSupply: varchar("place_of_supply", { length: 40 }),
  isReverseCharge: boolean("is_reverse_charge").notNull().default(false),
  itcEligible: boolean("itc_eligible").notNull().default(false),
} as const;
