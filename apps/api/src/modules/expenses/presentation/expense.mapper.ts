import {
  expenseCommentResponseSchema,
  expenseCommentSchema,
  expenseCommentsResponseSchema,
  expenseGstResponseSchema,
  expenseGstSchema,
  expenseListResponseSchema,
  expenseResponseSchema,
  expenseRevisionsResponseSchema,
  expenseSchema,
  expenseSplitsResponseSchema,
  publishExpenseResponseSchema,
  recalculateExpenseResponseSchema,
  voidExpenseResponseSchema,
} from "@ses/contracts";
import type {
  ExpenseCommentDto,
  ExpenseCommentResponseDto,
  ExpenseCommentsResponseDto,
  ExpenseDto,
  ExpenseGstDto,
  ExpenseGstResponseDto,
  ExpenseListResponseDto,
  ExpenseResponseDto,
  ExpenseRevisionsResponseDto,
  ExpenseSplitsResponseDto,
  PublishExpenseResponseDto,
  RecalculateExpenseResponseDto,
  VoidExpenseResponseDto,
} from "@ses/contracts";
import { isCommentDeleted, paiseToWire } from "@ses/domain";
import type {
  ExpenseCommentRecord,
  ExpenseGstDetailsRecord,
  ExpensePublication,
  ExpenseRecalculation,
  ExpenseRecord,
  ExpenseRevisionRecord,
  ExpenseSplitRecord,
  ExpenseVoid,
} from "@ses/domain";

import type { ExpenseListResult } from "../application/use-cases/list-expenses.use-case";
import type { UpsertGstDetailsOutcome } from "../application/use-cases/upsert-gst-details.use-case";

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
    // T070's workflow stamps. They travel on every expense response because the
    // queue (`GET /expenses?status=pending_approval`) is the same DTO: an Admin
    // needs to see at a glance which entries are already approved.
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    rejectedBy: record.rejectedBy,
    rejectedAt: record.rejectedAt,
    rejectionReason: record.rejectionReason,
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
 * A committed void → the wire DTO — Roadmap T069, ADR-0010.
 *
 * The expense travels through the same `expenseToDto` every other route uses, so
 * the row is the one the definer transaction stamped (`status: "void"`,
 * `voidedAt`/`voidedBy`/`voidReason` set, `version` bumped by the trigger) rather
 * than the in-memory pre-void record's view of it. `creditsIssuedPaise` crosses
 * through `paiseToWire` — the single range-checked crossing point — so a credit
 * above `Number.MAX_SAFE_INTEGER` throws loudly instead of rounding.
 */
export function voidExpenseToDto(voided: ExpenseVoid): VoidExpenseResponseDto {
  return voidExpenseResponseSchema.parse({
    expense: expenseToDto(voided.expense),
    summary: {
      duesSuperseded: voided.summary.duesSuperseded,
      creditsIssuedPaise: paiseToWire(voided.summary.creditsIssued.paise),
      affectedMembers: voided.summary.affectedMembers,
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

/**
 * The current split rows → the wire DTO — Roadmap T073.
 *
 * Parses rather than constructs, like every mapper here: the contract schema is the
 * client's parse target, so a renamed field fails loudly at this boundary instead of
 * shipping a payload the client cannot read. `amountPaise` crosses through
 * `paiseToWire` — the repository's single range-checked crossing point (T012) — so a
 * value above `Number.MAX_SAFE_INTEGER` throws rather than rounds. `weight` and
 * `percent` stay decimal strings; nothing here puts a numeric column through a float.
 */
export function expenseSplitsToDto(
  splits: readonly ExpenseSplitRecord[],
): ExpenseSplitsResponseDto {
  return expenseSplitsResponseSchema.parse({
    splits: splits.map((split) => ({
      id: split.id,
      expenseId: split.expenseId,
      memberId: split.memberId,
      apartmentId: split.apartmentId,
      amountPaise: paiseToWire(split.amount.paise),
      weight: split.weight,
      percent: split.percent,
      assignedReason: split.assignedReason,
      snapshot: {
        memberName: split.snapshot.memberName,
        apartmentNumber: split.snapshot.apartmentNumber,
      },
      createdAt: split.createdAt,
    })),
  });
}

/**
 * The GST details record → the wire DTO — Roadmap T072.
 *
 * Parses rather than constructs, like every mapper here: the contract schema is
 * the client's parse target, so a renamed field fails loudly at this boundary
 * instead of shipping as a payload the client cannot read. Each of the six amounts
 * crosses through `paiseToWire` — the repository's single range-checked crossing
 * point — so a malformed value throws instead of rounding.
 */
export function expenseGstToDto(
  record: ExpenseGstDetailsRecord,
): ExpenseGstDto {
  return expenseGstSchema.parse({
    expenseId: record.expenseId,
    gstin: record.gstin,
    invoiceNumber: record.invoiceNumber,
    invoiceDate: record.invoiceDate,
    taxableValuePaise: paiseToWire(record.taxableValuePaise),
    cgstPaise: paiseToWire(record.cgstPaise),
    sgstPaise: paiseToWire(record.sgstPaise),
    igstPaise: paiseToWire(record.igstPaise),
    cessPaise: paiseToWire(record.cessPaise),
    hsnSac: record.hsnSac,
    placeOfSupply: record.placeOfSupply,
    isReverseCharge: record.isReverseCharge,
    itcEligible: record.itcEligible,
  });
}

/**
 * The GST upsert outcome → the wire DTO — Roadmap T072, D7.
 *
 * The stored row plus the warnings the write produced. Warnings are structurally
 * separate from an error: the request succeeded, and `TAX_TOTAL_MISMATCH` is the
 * PRD's "warn, don't block". Every amount in a warning crosses through
 * `paiseToWire` too.
 */
export function expenseGstResponseToDto(
  outcome: UpsertGstDetailsOutcome,
): ExpenseGstResponseDto {
  return expenseGstResponseSchema.parse({
    gst: expenseGstToDto(outcome.gst),
    warnings: outcome.warnings.map((warning) => ({
      code: warning.code,
      taxableValuePaise: paiseToWire(warning.taxableValuePaise),
      taxesPaise: paiseToWire(warning.taxesPaise),
      amountPaise: paiseToWire(warning.amountPaise),
      differencePaise: paiseToWire(warning.differencePaise),
    })),
  });
}

/**
 * One comment → the wire DTO — Roadmap T072.
 *
 * ## A deleted comment keeps its place and loses its prose
 *
 * The record is returned either way: its `sequence` preserves the gap that a
 * removed row would otherwise close, and `deleted`/`deletedAt`/`deletedBy` say who
 * removed it. `body` is deliberately `null` when deleted — the stored prose is
 * never lost (the row keeps it for audit), but publishing it would make the
 * soft delete meaningless to a client.
 */
export function expenseCommentToDto(
  record: ExpenseCommentRecord,
): ExpenseCommentDto {
  const deleted = isCommentDeleted(record);
  return expenseCommentSchema.parse({
    id: record.id,
    expenseId: record.expenseId,
    authorId: record.authorId,
    body: deleted ? null : record.body,
    sequence: record.sequence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deleted,
    deletedAt: record.deletedAt,
    deletedBy: record.deletedBy,
  });
}

/** `POST /expenses/:expenseId/comments` — the appended comment. */
export function expenseCommentResponseToDto(
  record: ExpenseCommentRecord,
): ExpenseCommentResponseDto {
  return expenseCommentResponseSchema.parse({
    comment: expenseCommentToDto(record),
  });
}

/** `GET /expenses/:expenseId/comments` — the whole stream, oldest first. */
export function expenseCommentsToDto(
  comments: readonly ExpenseCommentRecord[],
): ExpenseCommentsResponseDto {
  return expenseCommentsResponseSchema.parse({
    comments: comments.map((comment) => expenseCommentToDto(comment)),
  });
}
