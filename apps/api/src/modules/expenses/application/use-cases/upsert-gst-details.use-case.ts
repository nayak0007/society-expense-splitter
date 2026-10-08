import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
  canOnResource,
  expenseError,
  memberSnapshotOf,
  paise,
  parseGstin,
  reconcileGstTaxTotal,
  type ExpenseGstDetailsInput,
  type ExpenseGstDetailsRecord,
  type ExpenseGstWarning,
  type ExpenseId,
  type ExpenseMembershipReader,
  type ExpenseRepository,
  type Gstin,
  type SocietyId,
  type UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import {
  EXPENSE_GST_DETAILS_REPOSITORY,
  EXPENSE_REPOSITORY,
} from "../expense.tokens";
import type { ExpenseGstDetailsRepository } from "@ses/domain";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
} from "./expense-draft.support";

/**
 * Write an expense's GST details — Roadmap T072, PRD §3.5.3, decision D3/D4/D5/D6.
 *
 * ## The order that decides error precedence
 *
 * ```text
 * upsert(command)
 *   ├─ membership                                  (authorisation subject)
 *   ├─ the stored expense                          (not_found for foreign ids)
 *   ├─ void?                                       (invalid_transition, D4)
 *   ├─ canOnResource("expense.create", snapshot)   (the 🟡 draft-only site, D3)
 *   ├─ parseGstin                                  (validation)
 *   └─ repository.upsertForExpense(...)            (one atomic upsert)
 * ```
 *
 * ## Why `expense.create` and not a GST capability of its own
 *
 * D3: the matrix gains **no** `gst.*` permission. Recording GST details is part of
 * composing a bill, so it reuses `expense.create` — full for Admin and Treasurer,
 * and the Committee Member's 🟡 *draft only* cell, narrowed by `canOnResource`
 * against the stored row's snapshot exactly as create and preview do. That
 * narrowing is what makes the API agree with the database: the
 * `expense_gst_details` insert/update policies already require `status = 'draft'`
 * for the `can_draft_expenses` branch, and this site refuses a non-draft for a
 * Committee Member before any row is touched.
 *
 * ## Void is refused for everyone (D4)
 *
 * A `void` expense is final — its dues are reversed and its bill is not coming
 * back — so a GST edit would attach tax detail to a document that no longer
 * exists. This is the API's narrowing, stricter than the RLS policy (which lets an
 * Admin/Treasurer write any status); it fails *before* the write, with the
 * established `invalid_transition`, rather than leaving the database to accept a
 * change the product does not want.
 *
 * ## What this deliberately does not do (D5)
 *
 * It does not touch `expenses`: the upsert names only `expense_gst_details`, so
 * `approved_by`/`approved_at` survive untouched. ADR-0011's "any successful edit
 * invalidates the approval" is clarified by this — a *GST detail* is not an edit of
 * the bill's content, and recording it must not silently send an approved expense
 * back for a fresh decision.
 */
@Injectable()
export class UpsertGstDetailsUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_GST_DETAILS_REPOSITORY)
    private readonly gstDetails: ExpenseGstDetailsRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  async upsert(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: UpsertGstDetailsCommand,
  ): Promise<UpsertGstDetailsOutcome> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    if (record.status === "void") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "A void expense's GST details can no longer be changed.",
          { from: record.status },
        ),
      );
    }

    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.create",
      snapshotOf(record),
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", GST_EDIT_FORBIDDEN));
    }

    const input: ExpenseGstDetailsInput = {
      gstin: parseGstinOrNull(command.gstin),
      invoiceNumber: command.invoiceNumber ?? null,
      invoiceDate: command.invoiceDate ?? null,
      taxableValuePaise: paise(command.taxableValuePaise ?? 0),
      cgstPaise: paise(command.cgstPaise ?? 0),
      sgstPaise: paise(command.sgstPaise ?? 0),
      igstPaise: paise(command.igstPaise ?? 0),
      cessPaise: paise(command.cessPaise ?? 0),
      hsnSac: command.hsnSac ?? null,
      placeOfSupply: command.placeOfSupply ?? null,
      isReverseCharge: command.isReverseCharge ?? false,
      itcEligible: command.itcEligible ?? false,
    };

    let stored: ExpenseGstDetailsRecord;
    try {
      stored = await this.gstDetails.upsertForExpense(
        expenseId,
        societyId,
        input,
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    // D7: the reconciliation is non-blocking and computed over exact bigint paise.
    // The amount is the *stored* expense's, so a client cannot influence what the
    // warning compares against.
    const warnings = reconcileGstTaxTotal(stored, record.amount.paise);
    return { gst: stored, warnings };
  }
}

/** What the route hands the use case — the contract has parsed and refined it. */
export interface UpsertGstDetailsCommand {
  readonly gstin?: string | null | undefined;
  readonly invoiceNumber?: string | null | undefined;
  readonly invoiceDate?: string | null | undefined;
  readonly taxableValuePaise?: number | undefined;
  readonly cgstPaise?: number | undefined;
  readonly sgstPaise?: number | undefined;
  readonly igstPaise?: number | undefined;
  readonly cessPaise?: number | undefined;
  readonly hsnSac?: string | null | undefined;
  readonly placeOfSupply?: string | null | undefined;
  readonly isReverseCharge?: boolean | undefined;
  readonly itcEligible?: boolean | undefined;
}

/** The stored GST row plus the warnings the write produced. */
export interface UpsertGstDetailsOutcome {
  readonly gst: ExpenseGstDetailsRecord;
  readonly warnings: readonly ExpenseGstWarning[];
}

/** The refusal a Committee Member reads when the expense is no longer a draft. */
export const GST_EDIT_FORBIDDEN =
  "Only a society Admin, Treasurer or the Committee Member who owns a draft can record its GST details.";

/**
 * The optional GSTIN → a branded `Gstin`, `null`, or a `validation` refusal.
 *
 * The contract has already checked the checksum, so a failure here is a
 * defence-in-depth path (or a caller using the use case outside the HTTP
 * pipeline). It is mapped to the module's `validation` code with the domain's own
 * message, so the two layers cannot disagree about what is wrong.
 */
function parseGstinOrNull(value: string | null | undefined): Gstin | null {
  if (value === undefined || value === null) return null;
  const parsed = parseGstin(value);
  if (!parsed.ok) {
    throw toAppError(
      expenseError("validation", parsed.error.message, parsed.error.details),
    );
  }
  return parsed.value;
}
