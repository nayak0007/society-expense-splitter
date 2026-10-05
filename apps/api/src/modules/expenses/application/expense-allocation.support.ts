import { expenseError } from "@ses/domain";
import type {
  ApartmentId,
  ExpenseMemberNameReader,
  ExpenseParticipant,
  PublishExpenseAllocation,
  SocietyId,
  UnassignedReason,
  UserId,
  Weight,
} from "@ses/domain";
import type { SplitAllocation } from "@ses/split-engine";

import { toAppError } from "./expense-category-error.mapper";

/**
 * The allocation-mapping and fail-closed pieces T066's publish and T068's
 * recalculation share — extracted so the two published writes cannot drift.
 *
 * Nothing here computes a share: the engine did that before these functions run.
 * What lives here is the two facts the publish snapshot needs (`memberName`,
 * `apartmentNumber` at write time), the percentage column's exact conversion, and
 * the refusal that stops a bill silently omitting a flat with nobody to charge.
 * Both use cases call the same `resolveSplitPlan` → `computeSplit` →
 * `verifyConservation` pipeline and then this file, which is what makes "the plan a
 * preview showed and the plan a recalculation writes are the same shape" a
 * property rather than a coincidence.
 */

/**
 * The engine's allocations, joined with the two facts only the application layer
 * has.
 *
 * `percent` is the percentage strategy's own figure — its weight *is* basis
 * points (hundredths of a percent), so `33.33%` is `"33.33"` by an exact integer
 * shift, never a division. Every other strategy leaves the column `NULL` rather
 * than inventing a percentage for a share or an area split.
 *
 * The snapshot is PRD §7.3's "member name, flat no at publish time", read here so
 * it describes the roster as it is at the write. A participant missing from the
 * name read is an `invariant`: `members.display_name` is `NOT NULL` and non-blank,
 * and the resolver read the same row moments earlier, so a gap means the database
 * and this build disagree rather than that the caller did something wrong.
 */
export async function persistableAllocations(
  names: ExpenseMemberNameReader,
  actor: UserId,
  societyId: SocietyId,
  allocations: readonly SplitAllocation[],
  participants: readonly ExpenseParticipant[],
  strategy: string,
): Promise<readonly PublishExpenseAllocation[]> {
  const byApartment = new Map<ApartmentId, ExpenseParticipant>(
    participants.map((participant) => [participant.apartmentId, participant]),
  );
  const memberNames = await names.listMemberNames(
    societyId,
    [...new Set(allocations.map((allocation) => allocation.memberId))],
    actor,
  );

  return allocations.map((allocation) => {
    const participant = byApartment.get(allocation.apartmentId);
    if (participant === undefined) {
      throw toAppError(
        expenseError(
          "invariant",
          "The split engine allocated to a flat that was not resolved as a participant.",
          { apartmentId: allocation.apartmentId },
        ),
      );
    }
    const memberName = memberNames.get(allocation.memberId);
    if (memberName === undefined) {
      throw toAppError(
        expenseError(
          "invariant",
          "A participant's name could not be read for the publish snapshot.",
          { memberId: allocation.memberId },
        ),
      );
    }
    return {
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      amount: allocation.amount,
      weight: allocation.weight,
      percent: strategy === "percentage" ? percentOf(allocation.weight) : null,
      assignedReason: participant.assignedReason,
      snapshot: {
        memberName,
        apartmentNumber: allocation.apartmentNumber,
      },
    };
  });
}

/** What the treasurer must do about one flagged flat — the reason, in words. */
const UNASSIGNED_COPY: Readonly<Record<UnassignedReason, string>> = {
  unassigned_no_owner: "no owner membership to bill an owner-only charge to",
  unassigned_no_member: "no member linked to the flat",
};

/**
 * Refuses a published write while any resolved participant is unassigned.
 *
 * The message names the flats and what is missing from each, because the two
 * reasons are two different jobs (record an owner — a shadow member needs no login
 * — or link a member at all), and `details.unassigned` carries the same facts in
 * the machine-readable shape the error mapper turns into one `ErrorDetail` per
 * flat. `dues.member_id` is `NOT NULL`, so "publish anyway" would be a bill that
 * omits the flat, a fabricated member or a redistributed share — every one a
 * silent wrong bill.
 */
export function assertAllAssignable(
  unassigned: readonly {
    readonly apartmentId: ApartmentId;
    readonly apartmentNumber: string;
    readonly reason: UnassignedReason;
  }[],
): void {
  if (unassigned.length === 0) return;

  const flats = unassigned.map(
    (entry) => `${entry.apartmentNumber} (${UNASSIGNED_COPY[entry.reason]})`,
  );
  const noun = unassigned.length === 1 ? "flat has" : "flats have";
  throw toAppError(
    expenseError(
      "unassigned_participants",
      `Cannot publish: ${String(unassigned.length)} billable ${noun} nobody to charge — ${flats.join("; ")}. Record an owner or member, or exclude those flats from the participant selector, then publish again.`,
      {
        field: "participantSelector",
        unassigned: unassigned.map((entry) => ({
          apartmentId: entry.apartmentId,
          apartmentNumber: entry.apartmentNumber,
          reason: entry.reason,
        })),
      },
    ),
  );
}

/** Basis points → the column's decimal, exactly: `3333n` → `"33.33"`. */
export function percentOf(basisPoints: Weight): string {
  const whole = basisPoints / 100n;
  const fraction = basisPoints % 100n;
  return `${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}
