import { err, ok, type Money, type Result, type Weight } from "@ses/domain";

import { distribute, undistributedPaise } from "./rounding";
import { customWeights } from "./strategies/custom";
import { equalWeights } from "./strategies/equal";
import { percentageWeights } from "./strategies/percentage";
import { shareWeights } from "./strategies/shares";
import {
  splitError,
  type SplitAllocation,
  type SplitError,
  type SplitInput,
  type SplitParticipant,
  type SplitResult,
} from "./types";

/**
 * The split engine (Roadmap T056, PRD §3.5).
 *
 * A pure function: no I/O, no clock, no random source and no mutable state, so the
 * allocations a phone previews and the ones the server writes are the same
 * allocations or the code is different (SAD §1.1).
 *
 * ## The one thing this file decides
 *
 * **Order.** The rounding rule hands the residual paisa to the largest fractional
 * remainders and breaks ties by apartment number ascending (PRD §3.5); the
 * primitive that implements it breaks ties by *index* ascending. Those agree
 * exactly when the weights are presented in apartment-number order, so the engine
 * sorts the participants before allocating and the two rules become one. That
 * sort is the whole reason this file is more than a `switch`.
 *
 * Sorting has a second effect worth stating: the result is a function of the
 * participant **set**, not of the array the caller happened to build. Two callers
 * who pass the same flats in different orders get byte-identical allocations,
 * including which flat carries the extra paisa. Without the sort, a database
 * that returned rows in a different order on a different day would move a paisa
 * between two residents — a difference no test would catch, because both runs
 * would be individually "deterministic".
 *
 * ## Ordering contract
 *
 * Ascending by `apartmentNumber`, compared byte-wise (`<`, not `localeCompare`),
 * then by `apartmentId`, then by `memberId`. The byte-wise part is deliberate and
 * matches the database index (`apartment_number COLLATE "C"`, see
 * `compareApartments` in `@ses/domain`): `"10"` sorts before `"2"` under both, so
 * a list the server ordered and a list the client re-sorted agree without either
 * knowing the other's collation. `localeCompare` would make the residual's
 * destination depend on the device's ICU data.
 *
 * The three keys together are a **total order**, which is what makes the residual
 * placement reproducible for any input: `(memberId, apartmentId)` is unique (the
 * duplicate check below enforces it), so no two participants compare equal. The id
 * tie-breakers are not decoration — the legal case of one flat with two
 * participating members is real, and without them their relative order would fall
 * back to the array position, which is the accident this sort exists to remove.
 *
 * ## Sign, zero, and what is refused
 *
 * The amount must be **strictly positive**. An expense of zero or less is not a
 * split, it is a mistake: `expenses.amount_paise` is `CHECK (amount_paise > 0)`
 * (SAD §8), so accepting one here would move the failure from a field error the
 * treasurer can act on to a constraint violation at commit. `Money` stays signed
 * for the things that genuinely are negative — refunds, adjustments, balances
 * (T012) — and a negative amount still allocates correctly if it is ever handed
 * to `distribute` directly; the engine simply will not accept one as an expense.
 *
 * A zero amount is refused for the same reason rather than being answered with
 * zeros. Returning a list of zeros would look like success while writing splits
 * the database will reject.
 *
 * ## Errors
 *
 * Every expected failure is **returned**, not thrown (SAD §3.3): a caller
 * submitting a bad percentage is ordinary. The only throw is an invariant
 * violation — allocations that do not sum to the amount — which is a bug in the
 * rounding rule and must not be quietly reversible into a `Result` the caller
 * handles by retrying.
 */
export function computeSplit(
  input: SplitInput,
): Result<SplitResult, SplitError> {
  if (!input.amount.isPositive()) {
    return err(
      splitError(
        "validation",
        `A split needs an amount greater than zero, received ${input.amount.format()}.`,
        { field: "amount" },
      ),
    );
  }

  if (input.participants.length === 0) {
    return err(
      splitError("validation", "A split needs at least one participant.", {
        field: "participants",
      }),
    );
  }

  const duplicate = findDuplicate(input.participants);
  if (duplicate !== undefined) {
    return err(
      splitError(
        "conflict",
        `Flat ${duplicate.apartmentNumber} is a participant twice; one share of an expense cannot be charged to the same member and flat more than once.`,
        {
          field: "participants",
          apartmentId: duplicate.apartmentId,
          memberId: duplicate.memberId,
        },
      ),
    );
  }

  const plan = planSplit(input);
  if (!plan.ok) return plan;

  const parts = distribute(input.amount, plan.value.weights);
  return ok(buildResult(input.amount, plan.value, parts));
}

/** One participant's weight, resolved from the strategy, in tie-break order. */
interface SplitPlan {
  readonly ordered: readonly SplitParticipant[];
  readonly weights: readonly Weight[];
}

/**
 * Dispatch on the strategy: one arm per variant, no `default`.
 *
 * The switch is exhaustive over `SplitInput` and TypeScript knows it, so a fifth
 * strategy added to the union is a compile error until it has a branch of its own.
 * A `default` that threw would be strictly worse than that error — it would move
 * the mistake from the compiler to production, and its never-taken branch would
 * sit in the coverage report as the one line no test can reach.
 *
 * Every arm delegates its ordering to {@link planFrom}; the dispatch itself
 * decides nothing beyond which strategy resolves the weights.
 */
function planSplit(input: SplitInput): Result<SplitPlan, SplitError> {
  switch (input.strategy) {
    case "equal":
      return planFrom(input.participants, (ordered) =>
        ok(equalWeights(ordered)),
      );
    case "percentage":
      return planFrom(input.participants, percentageWeights);
    case "shares":
      return planFrom(input.participants, shareWeights);
    case "custom":
      return planFrom(input.participants, (ordered) =>
        customWeights(ordered, input.amount),
      );
  }
}

/**
 * Order the participants, then ask the strategy for a weight each.
 *
 * Ordering happens first and the weights are produced *from the ordered list*, so
 * the two arrays are index-aligned by construction — `weights[i]` belongs to
 * `ordered[i]` because the strategy was handed `ordered`. Nothing downstream has
 * to trust a parallel array that a caller built.
 *
 * Generic in the participant type so each strategy's own value survives the round
 * trip: a percentage split's `BasisPoints`, a shares split's `ShareUnits` and a
 * custom split's `Money` all reach the strategy that understands them without a
 * cast.
 */
function planFrom<TParticipant extends SplitParticipant>(
  participants: readonly TParticipant[],
  weightsFor: (
    ordered: readonly TParticipant[],
  ) => Result<readonly Weight[], SplitError>,
): Result<SplitPlan, SplitError> {
  const ordered = orderParticipants(participants);
  const weights = weightsFor(ordered);
  return weights.ok ? ok({ ordered, weights: weights.value }) : weights;
}

/**
 * The residual's destination: apartment number, then the two ids.
 *
 * See the ordering contract on {@link computeSplit}. The ids are compared as
 * strings, which for a uuid is arbitrary but *stable* — arbitrary is fine for a
 * tie-break, unstable is not.
 *
 * The three keys are compared with {@link compareStrings} rather than inlined, and
 * that is not only style: an inlined `if (left.memberId === right.memberId) return
 * 0` would be **unreachable**, because two participants that agree on all three
 * keys are the duplicate the engine already refused, and an unreachable branch is
 * one that no test can prove and no coverage gate can hold. With the comparison
 * factored out, the «equal» case is exercised by the legitimate inputs that reach
 * it — two participants in one flat share an apartment number — and the final key
 * is a plain ordered comparison whose both directions are real.
 */
function compareParticipants(
  left: SplitParticipant,
  right: SplitParticipant,
): number {
  const byApartmentNumber = compareStrings(
    left.apartmentNumber,
    right.apartmentNumber,
  );
  if (byApartmentNumber !== 0) return byApartmentNumber;

  const byApartmentId = compareStrings(left.apartmentId, right.apartmentId);
  if (byApartmentId !== 0) return byApartmentId;

  return compareStrings(left.memberId, right.memberId);
}

/**
 * Byte-wise string order: `"10"` sorts before `"2"`.
 *
 * Not `localeCompare`, deliberately. The list is ordered by the database
 * (`apartment_number COLLATE "C"`, SAD §8) and re-sorted here, so the two must
 * agree; `localeCompare` is locale- and ICU-dependent and would let the residual
 * paisa land on a different flat depending on the device that previewed the
 * split.
 */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * A sorted copy — never a sort in place.
 *
 * `Array.prototype.sort` mutates, and the array belongs to the caller: a use case
 * that resolved participants for display and then split them would find its own
 * list silently reordered. Generic in the participant type so a percentage split's
 * `BasisPoints` survive the round trip without a cast.
 */
function orderParticipants<TParticipant extends SplitParticipant>(
  participants: readonly TParticipant[],
): readonly TParticipant[] {
  return [...participants].sort(compareParticipants);
}

/**
 * The member-and-flat pair that appears twice, if any.
 *
 * Keyed on `(apartmentId, memberId)` — the pair `expense_splits` is unique on
 * (SAD §8) — rather than on either alone. Two members of one flat is a legitimate
 * participant list (an owner and a co-owner, say, and the schema's unique
 * constraint permits it), while the same member appearing twice for the same flat
 * is a resolver bug that would charge them two shares.
 *
 * The separator is what keeps the key unambiguous: without it, ids `"ab"` + `"c"`
 * and `"a"` + `"bc"` would collide. It is a NUL because no id from Postgres can
 * contain one.
 */
function findDuplicate(
  participants: readonly SplitParticipant[],
): SplitParticipant | undefined {
  const seen = new Set<string>();
  for (const participant of participants) {
    const key = `${participant.apartmentId}\u0000${participant.memberId}`;
    if (seen.has(key)) return participant;
    seen.add(key);
  }
  return undefined;
}

/**
 * Assemble the result: one allocation per participant, in tie-break order.
 *
 * `parts[i] as Money` and `weights[i] as Weight` rely on
 * [`Money.allocateByWeights`](../../domain/src/shared/money.vo.ts)'s documented
 * contract — exactly one allocation per weight, in order. This is the single place
 * in the package that leans on it, and `undistributedPaise` is what proves the
 * contract held for the whole array; a short result would surface as a non-zero
 * residual rather than as a silently missing resident.
 *
 * Frozen at both levels: the result and each allocation, so a caller holding a
 * published expense's splits cannot have them edited in place by something
 * downstream that assumed it owned the array.
 */
function buildResult(
  total: Money,
  plan: SplitPlan,
  parts: readonly Money[],
): SplitResult {
  const allocations = plan.ordered.map((participant, index) => {
    const amount = parts[index] as Money;
    const shareWeight = plan.weights[index] as Weight;
    return Object.freeze({
      memberId: participant.memberId,
      apartmentId: participant.apartmentId,
      apartmentNumber: participant.apartmentNumber,
      amount,
      weight: shareWeight,
    });
  });

  return Object.freeze({
    total,
    allocations: Object.freeze<readonly SplitAllocation[]>(allocations),
    residualPaise: undistributedPaise(total, parts),
  });
}
