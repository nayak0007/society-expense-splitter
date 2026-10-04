import { previewSplitResponseSchema } from "@ses/contracts";
import type { PreviewSplitResponseDto } from "@ses/contracts";
import { paise, paiseToWire } from "@ses/domain";
import type { Weight } from "@ses/domain";

import type { ExpenseSplitPreview } from "../application/use-cases/preview-split.use-case";

/**
 * The preview result → the wire DTO — Roadmap T064.
 *
 * ## Why it parses rather than constructs
 *
 * The contract schema in `@ses/contracts` is the client's parse target, so the response
 * has to satisfy it exactly. Mapping by hand and trusting it means a domain rename ships
 * as a silently wrong payload that the mobile client then fails to parse, in production,
 * on the split editor — the failure `category.mapper.ts` records in full. Parsing here
 * turns that into a 500 at the moment the field moves.
 *
 * ## The two crossings, and only two
 *
 * Every amount is `bigint` paise in the domain and an integer on the JSON wire, and
 * `paiseToWire` is the repository's single range-checked crossing point (T012) — a value
 * above `Number.MAX_SAFE_INTEGER` throws loudly rather than rounding into a bill. The
 * `weight` is the second integer that has to cross; it reuses the same guard rather than
 * duplicating it, because a `Weight` *is* an integer of the money scale's kin (share
 * units, basis points, hundredths of a sqft) and an unsafe one must fail exactly the
 * same way.
 *
 * `warnings` and `unassigned` are copied field by field: a spread would forward any field
 * the domain grows, including ones the contract does not define, and the whole point of
 * the boundary is that it is enumerated.
 */
export function expenseSplitPreviewToDto(
  preview: ExpenseSplitPreview,
): PreviewSplitResponseDto {
  return previewSplitResponseSchema.parse({
    totalPaise: paiseToWire(preview.total.paise),
    participantCount: preview.participantCount,
    allocations: preview.allocations.map((allocation) => ({
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      apartmentNumber: allocation.apartmentNumber,
      weight: weightToWire(allocation.weight),
      amountPaise: paiseToWire(allocation.amount.paise),
    })),
    residualPaise: paiseToWire(preview.residualPaise),
    warnings: preview.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      apartmentIds: [...warning.apartmentIds],
    })),
    unassigned: preview.unassigned.map((entry) => ({
      apartmentId: entry.apartmentId,
      apartmentNumber: entry.apartmentNumber,
      reason: entry.reason,
    })),
  });
}

/** A weight on the wire, through the money boundary's own range guard. */
function weightToWire(value: Weight): number {
  return paiseToWire(paise(value));
}
