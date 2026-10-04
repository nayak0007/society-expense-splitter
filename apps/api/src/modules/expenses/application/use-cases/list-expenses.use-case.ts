import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseCategoryId,
  asExpenseError,
  asExpenseId,
  asMemberId,
  expenseError,
  paise,
} from "@ses/domain";
import type {
  ExpenseCursor,
  ExpenseListQuery,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  ExpenseStatus,
  SocietyId,
  UserId,
} from "@ses/domain";
import { z } from "zod";

import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY } from "../expense.tokens";

/**
 * List a society's expenses — Roadmap T065, SAD §7.4/§7.5.
 *
 * ## One query, one page, one cursor
 *
 * The repository performs a single filtered statement; this use case only translates
 * — the contract's strings into the domain's types, the caller's cursor into the
 * sort tuple, and the next tuple back into an opaque string. No count query: SAD
 * §7.4 makes `total` optional and it is only cheap from a cache this module does not
 * have.
 *
 * ## The cursor is base64 of SAD §7.4's own sort tuple
 *
 * `{ expenseDate, id }`, exactly as the document sketches it. Decoding is strict and
 * a malformed cursor is a `validation` error naming `cursor` — not a silent
 * "start over", which would turn a client bug into duplicated rows on a screen. The
 * tuple is opaque to the client by construction, not by secrecy: it is validated
 * again on the way back in because a client can always send anything.
 *
 * ## Filters are the SAD's, minus the three the schema cannot answer
 *
 * `categoryId`, `status`, `dateFrom`/`dateTo`, `amountPaiseMin`/`amountPaiseMax`,
 * `createdBy` and `q` are implemented. `buildingId`, `hasAttachments` and `cycleId`
 * are refused by the contract's strict schema rather than silently ignored — the
 * columns and tables behind them do not exist yet (T060 withheld `cycle_id`;
 * attachments are T071; the PRD's building scope lives inside `participant_selector`),
 * and a filter that quietly matches everything is worse than one that says it is not
 * there. The gap is recorded in T065's report.
 */
@Injectable()
export class ListExpensesUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
  ) {}

  async list(
    actor: UserId,
    societyId: SocietyId,
    command: ListExpensesCommand,
  ): Promise<ExpenseListResult> {
    const query: ExpenseListQuery = {
      ...(command.categoryId === undefined
        ? {}
        : { categoryId: asExpenseCategoryId(command.categoryId) }),
      ...(command.status === undefined ? {} : { status: command.status }),
      ...(command.dateFrom === undefined ? {} : { dateFrom: command.dateFrom }),
      ...(command.dateTo === undefined ? {} : { dateTo: command.dateTo }),
      ...(command.amountPaiseMin === undefined
        ? {}
        : { amountPaiseMin: paise(command.amountPaiseMin) }),
      ...(command.amountPaiseMax === undefined
        ? {}
        : { amountPaiseMax: paise(command.amountPaiseMax) }),
      ...(command.createdBy === undefined
        ? {}
        : { createdBy: asMemberId(command.createdBy) }),
      ...(command.q === undefined ? {} : { search: command.q }),
      ...(command.cursor === undefined
        ? {}
        : { cursor: decodeExpenseCursor(command.cursor) }),
      limit: Math.min(
        command.limit ?? DEFAULT_EXPENSE_PAGE_SIZE,
        MAX_EXPENSE_PAGE_SIZE,
      ),
    };

    let page: ExpensePage;
    try {
      page = await this.expenses.list(societyId, query, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    return {
      expenses: page.expenses,
      nextCursor:
        page.nextCursor === null ? null : encodeExpenseCursor(page.nextCursor),
      hasMore: page.nextCursor !== null,
    };
  }
}

/** SAD §7.4: default 20, maximum 100 (the contract clamps; this is the floor). */
export const DEFAULT_EXPENSE_PAGE_SIZE = 20;
export const MAX_EXPENSE_PAGE_SIZE = 100;

/** What the route hands the use case — already parsed by the contract schema. */
export interface ListExpensesCommand {
  readonly categoryId?: string | undefined;
  readonly status?: ExpenseStatus | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly amountPaiseMin?: number | undefined;
  readonly amountPaiseMax?: number | undefined;
  readonly createdBy?: string | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The page plus its wire cursor. */
export interface ExpenseListResult {
  readonly expenses: readonly ExpenseRecord[];
  /** Base64 of `{ expenseDate, id }`, or `null` on the last page. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** The decoded tuple, validated as strictly as the wire that carried it. */
const cursorPayloadSchema = z.object({
  expenseDate: z.iso.date(),
  id: z.uuid(),
});

/**
 * The opaque cursor → the sort tuple, or a `validation` error naming `cursor`.
 *
 * `Buffer.from(..., "base64")` is forgiving of non-base64 input (it decodes what it
 * can and ignores the rest), which is exactly why the JSON parse and the schema
 * check follow: the pair is what makes a garbage cursor a refusal rather than a page
 * starting somewhere unintended.
 */
export function decodeExpenseCursor(cursor: string): ExpenseCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw toAppError(
      expenseError("validation", "The cursor is not valid.", {
        field: "cursor",
      }),
    );
  }

  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw toAppError(
      expenseError("validation", "The cursor is not valid.", {
        field: "cursor",
      }),
    );
  }

  return {
    expenseDate: parsed.data.expenseDate,
    id: asExpenseId(parsed.data.id),
  };
}

/** The sort tuple → the opaque cursor. The client never constructs one. */
export function encodeExpenseCursor(cursor: ExpenseCursor): string {
  return Buffer.from(
    JSON.stringify({ expenseDate: cursor.expenseDate, id: cursor.id }),
    "utf8",
  ).toString("base64");
}
