import {
  expenseListResponseSchema,
  expenseResponseSchema,
  expenseSchema,
} from "@ses/contracts";
import type {
  ExpenseDto,
  ExpenseListResponseDto,
  ExpenseResponseDto,
} from "@ses/contracts";
import { paiseToWire } from "@ses/domain";
import type { ExpenseRecord } from "@ses/domain";

import type { ExpenseListResult } from "../application/use-cases/list-expenses.use-case";

/**
 * The expense record → the wire DTO — Roadmap T065.
 *
 * ## Parses rather than constructs, like every mapper in this module
 *
 * `expenseSchema` is the client's parse target, so the response has to satisfy it
 * exactly. Mapping by hand and trusting it means a rename ships as a silently wrong
 * payload that the mobile client fails to parse, in production, on the expense list —
 * the failure `category.mapper.ts` records in full. Parsing turns that into a 500 at
 * the moment the field moves.
 *
 * ## The one crossing is explicit
 *
 * `amount` is `bigint` paise in the domain and an integer on the JSON wire;
 * `paiseToWire` is the repository's single range-checked crossing point (T012), so a
 * value above `Number.MAX_SAFE_INTEGER` throws loudly instead of rounding into a
 * bill. Nothing else in this file does arithmetic.
 *
 * `splitConfig` and `participantSelector` are stored `jsonb` and travel through the
 * contracts' own schemas, which is what turns "the column holds something this build
 * does not understand" into a boundary failure rather than a client's parse error.
 */
export function expenseToDto(record: ExpenseRecord): ExpenseDto {
  return expenseSchema.parse({
    id: record.id,
    societyId: record.societyId,
    categoryId: record.categoryId,
    title: record.title,
    description: record.description,
    amountPaise: paiseToWire(record.amount.paise),
    expenseDate: record.expenseDate,
    vendorName: record.vendorName,
    paymentSource: record.paymentSource,
    paidByMemberId: record.paidByMemberId,
    splitStrategy: record.splitStrategy,
    apartmentBasis: record.apartmentBasis,
    splitConfig: record.splitConfig ?? {},
    participantSelector: record.participantSelector ?? {},
    status: record.status,
    version: record.version,
    createdBy: record.createdBy,
    publishedAt: record.publishedAt,
    voidedAt: record.voidedAt,
    voidedBy: record.voidedBy,
    voidReason: record.voidReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/** One expense, wrapped for `POST /expenses` and `PATCH /expenses/:expenseId`. */
export function expenseResponseToDto(
  record: ExpenseRecord,
): ExpenseResponseDto {
  return expenseResponseSchema.parse({ expense: expenseToDto(record) });
}

/** `GET /expenses` — the page and its cursor. */
export function expenseListToDto(
  result: ExpenseListResult,
): ExpenseListResponseDto {
  return expenseListResponseSchema.parse({
    expenses: result.expenses.map((record) => expenseToDto(record)),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  });
}
