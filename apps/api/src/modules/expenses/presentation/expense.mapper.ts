import {
  expenseListResponseSchema,
  expenseResponseSchema,
  expenseRevisionsResponseSchema,
  expenseSchema,
  publishExpenseResponseSchema,
  recalculateExpenseResponseSchema,
} from "@ses/contracts";
import type {
  ExpenseDto,
  ExpenseListResponseDto,
  ExpenseResponseDto,
  ExpenseRevisionsResponseDto,
  PublishExpenseResponseDto,
  RecalculateExpenseResponseDto,
} from "@ses/contracts";
import { paiseToWire } from "@ses/domain";
import type {
  ExpensePublication,
  ExpenseRecalculation,
  ExpenseRecord,
  ExpenseRevisionRecord,
} from "@ses/domain";

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

/** One expense, wrapped for `POST /expenses` and a draft `PATCH /expenses/:expenseId`. */
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

/**
 * The publication → the wire DTO — Roadmap T066.
 *
 * The expense travels through `expenseToDto` (the same mapping every other route
 * uses, so `status`/`publishedAt`/`version` are the row the transition wrote rather
 * than the in-memory aggregate's view of it), and the summary's three amounts cross
 * through `paiseToWire` — the repository's single range-checked crossing point — so
 * a summary above `Number.MAX_SAFE_INTEGER` throws loudly instead of rounding into
 * a bill. The summary itself was measured over the persisted rows by
 * `expense_publish()`, which is what makes this a report and not a prediction.
 *
 * `replayed` is deliberately **not** a field: it is carried on the response header
 * (`Idempotency-Replayed`), because the body of a replay must be byte-identical to
 * the body of the original success — that is the whole point of storing it.
 */
export function expensePublicationToDto(
  publication: ExpensePublication,
): PublishExpenseResponseDto {
  return publishExpenseResponseSchema.parse({
    expense: expenseToDto(publication.expense),
    splitSummary: {
      participantCount: publication.summary.participantCount,
      totalPaise: paiseToWire(publication.summary.total.paise),
      minPaise: paiseToWire(publication.summary.min.paise),
      maxPaise: paiseToWire(publication.summary.max.paise),
    },
  });
}

/**
 * A committed revision → the wire DTO — Roadmap T068.
 *
 * The expense travels through the same `expenseToDto` every other route uses, so the
 * row is the one the database wrote (`version` bumped by its trigger, `updated_at`
 * stamped) rather than the in-memory patch's view of it. The diff's `totalDelta`
 * crosses through `paiseToWire` — the repository's single range-checked crossing
 * point — and is the one **signed** amount on this wire, because a revision can lower
 * obligations as well as raise them.
 */
export function recalculateExpenseToDto(
  recalculation: ExpenseRecalculation,
): RecalculateExpenseResponseDto {
  return recalculateExpenseResponseSchema.parse({
    expense: expenseToDto(recalculation.expense),
    recalculation: {
      duesUpdated: recalculation.summary.duesUpdated,
      duesSuperseded: recalculation.summary.duesSuperseded,
      duesCreated: recalculation.summary.duesCreated,
      totalDeltaPaise: paiseToWire(recalculation.summary.totalDelta.paise),
      affectedMembers: recalculation.summary.affectedMembers,
      blockedByPaidSplits: recalculation.summary.blockedByPaidSplits,
    },
  });
}

/**
 * The revision history → the wire DTO — Roadmap T068.
 *
 * No mapping of the snapshot's members beyond copying them: they are the stored
 * history, and re-modelling them here would be the second, narrower model of a
 * revision the port deliberately avoids. The parse still runs, so a row whose
 * envelope is not `{expense, splits}` fails at this boundary rather than reaching a
 * client as a shape it cannot render.
 */
export function expenseRevisionsToDto(
  revisions: readonly ExpenseRevisionRecord[],
): ExpenseRevisionsResponseDto {
  return expenseRevisionsResponseSchema.parse({
    revisions: revisions.map((revision) => ({
      id: revision.id,
      expenseId: revision.expenseId,
      version: revision.version,
      snapshot: {
        expense: revision.snapshot.expense,
        splits: [...revision.snapshot.splits],
      },
      changedBy: revision.changedBy,
      changeNote: revision.changeNote,
      createdAt: revision.createdAt,
    })),
  });
}
