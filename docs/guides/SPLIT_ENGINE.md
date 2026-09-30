# Split engine

The rules `packages/split-engine` enforces, written for whoever adds the
apartment-based strategies (T058), the expense aggregate (T061) or the live
preview endpoint (T064). Not a tutorial — the list of decisions the package has
already made so the next layer does not re-decide them differently.

Source: [`packages/split-engine/src/types.ts`](../../packages/split-engine/src/types.ts)
(the contract and the errors),
[`engine.ts`](../../packages/split-engine/src/engine.ts) (`computeSplit` and the
ordering), [`rounding.ts`](../../packages/split-engine/src/rounding.ts) (the rule's
seam), and [`strategies/`](../../packages/split-engine/src/strategies).

## 1. One entry point, and it cannot fail silently

```ts
computeSplit(input: SplitInput): Result<SplitResult, SplitError>
```

Pure and deterministic: no I/O, no clock, no random source, no mutable state. The
mobile app previews with it and the API publishes with it, so the number a
treasurer saw and the number a resident is charged cannot be two different numbers
(SAD §1.1). That is why it is a package rather than a method on the expense
aggregate.

Expected failures are **returned**, not thrown (SAD §3.3): a bad percentage is
ordinary input. The one throw is an `invariant` violation — allocations that do not
sum to the amount — which is a bug, not something a caller should be able to handle
by retrying.

## 2. Money is the only amount

Every amount is [`Money`](../../packages/domain/src/shared/money.vo.ts) — exact
integer paise (T012, ADR-0005). **This package makes no rounding decision of its
own.** It hands the amount and one weight per participant to
`Money.allocateByWeights` and reports what came back. There is no second
largest-remainder implementation, no `parseFloat`, no `Math.round`, no `toFixed`
and no float anywhere in `src/`.

The only arithmetic on money outside that primitive is `custom`'s exact sum —
`Σ amounts`, compared with the total (T057). It is the addition of integers, so it
cannot round, and it is the server half of the PRD's "remaining: ₹0" rule. The only
divisions in the package are by `100n` and `1000n`, both in display and error
messages ('`33.33%`', '`10000 shares`'), never on an amount.

`amountPaise` does not appear in the domain types. The PRD's sketch writes it
because that is the JSON wire shape (SAD §7.9); the conversion belongs to the API
contract layer, where `paiseToWire` already lives.

## 3. The rounding rule, and the one thing that had to be bridged

> Divide in paise, floor each allocation, then distribute the residual paise one
> paise at a time to allocations in descending order of fractional remainder,
> tie-broken by **apartment number ascending** (PRD §3.5).

`Money.allocateByWeights` implements that rule with the tie-break by **index
ascending**. Those two are the same rule exactly when the weights arrive in
apartment-number order — so the engine sorts the participants before allocating,
and `rounding.ts` implements nothing.

That bridge is why there is still one residual algorithm in the repository. A
second implementation, in the engine, is precisely how a paisa ends up in a
different pocket on the client than on the server.

`rounding.ts` exists to give the rule a name inside the package, to keep strategies
from reaching into `Money` themselves, and to **measure** the residual rather than
assume it:

```ts
undistributedPaise(amount, parts); // Σ parts subtracted from the amount
```

It is `0n` for every distribution the engine produces, and it is carried on
`SplitResult` rather than asserted away, so a regression would surface in the data.
It is a total function so that pointing it at a knowingly short set of parts
returns a non-zero number — which is what proves it measures anything.

## 4. Ordering — the contract, and why it is total

Allocations come back ordered **ascending by `apartmentNumber`**, compared
**byte-wise** (`<`, never `localeCompare`), then by `apartmentId`, then by
`memberId`.

- **Byte-wise, because the database is.** The list is ordered by
  `apartment_number COLLATE "C"` (SAD §8) and re-sorted here, so the two must
  agree; `"10"` sorts before `"2"` under both. `localeCompare` is locale- and
  ICU-dependent, so the residual paisa's destination would depend on the device
  that previewed the split.
- **Three keys, because two are not enough.** `(memberId, apartmentId)` is unique —
  the engine refuses a repeat — so the three keys are a total order and no two
  participants compare equal. The id tie-breakers are not decoration: one flat with
  two participating members is legal, and without them their order would fall back
  to array position.
- **The result does not depend on input order.** `["103","101","102"]` and its
  reverse produce byte-identical allocations, including which flat carries the
  extra paisa. A caller that passes the same flats in a different order cannot get
  a different answer.
- **The caller's array is not mutated.** The sort copies. A use case that resolved
  participants for display and then split them does not find its own list
  reordered.

## 5. Strategies implemented

| Strategy     | Weight given to each participant | Since |
| ------------ | -------------------------------- | ----- |
| `equal`      | `1`                              | T056  |
| `percentage` | the participant's basis points   | T056  |
| `shares`     | share units                      | T057  |
| `custom`     | explicit per-participant amounts | T057  |

`SplitStrategy` lists only what is implemented, so an unimplemented strategy is a
**compile error** rather than a runtime throw. The names match the database's
`split_strategy` enum (`20260920130000_society_core.sql`) exactly, and a test pins
the list so extending it shows up in a diff.

### Equal

`amount ÷ participants`, expressed as **equal weights** rather than as a division.
₹100 across 3 flats has no exact paise answer, so "divide" would have to choose
where the leftover paisa goes — and the only specified place for that choice is the
rounding rule. Equal is therefore a distribution over equal weights, which is also
why `equal` and `percentage` at an equal percentage produce identical results.

### Percentage

Each participant carries its own percentage, so a misaligned parallel array or an
unknown participant reference is not expressible. The total must reach 100% within
one basis point.

### Shares

Each participant carries its own share count, and the count is a `ShareUnits` —
**thousandths of a share**, the `apartments.share_units numeric(8, 3)` scale, so a
society's stored `3.000` is `shareUnits(3_000)` and `1.5` shares is `1500`. The
count is the weight.

`amount × share ÷ totalShares` is **not computed here**. It has no exact paise
answer in general, so the share counts go to `Money.allocateByWeights` and the one
rounding rule divides once and places the residual. Scaling every share by the same
factor cannot move money: `1 : 2 : 3` and `1000 : 2000 : 3000` allocate
byte-identically, including which flat carries the residual paisa, because the
remainders the rule ranks are scaled too.

Validation, in `shareWeights`:

- a share must be **greater than zero**. A zero share would be a ₹0 row in a
  published split for a flat the treasurer never meant to bill; a flat the society
  means to exempt is left out of the participant list by participant resolution
  (T063), exactly as one outside the selector is today, or given the `0%` a
  percentage split allows;
- a share must be **at most `10_000`** (`10_000_000` thousandths) — the ceiling in
  `chk_apartments_share_units`, and the largest weight that still fits
  `expense_splits.weight numeric(12, 4)`, so a split this engine accepts is one the
  database can store;
- a share must be a **whole number of thousandths**. A fractional `number` is a
  caller that has already done share arithmetic in floating point, and rounding it
  into money is the one thing this package must never do (`shareUnits` refuses
  `1.5` with the hint that `1.5` shares is `1500`).

The PRD's worked example is the acceptance case: ₹60,000 over `10×3 + 20×2 + 20×1`
shares is 90,000 thousandths, giving ₹2,000.00, ₹1,333.33 and ₹666.67 per tier and
the 20 residual paise to the 1-share tier, whose remainder is the largest. The PRD
prints the 2-share tier as ₹1,333.34, which cannot be right — that ledger adds up to
₹60,000.20 — so the printed figure is a display rounding of
`60000 × 2 ÷ 90`, and the rule that conserves is the one implemented.

### Custom

The treasurer's exact figure per participant, carried as a `Money`. Nothing here is
proportional, scaled or rounded: `Σ amounts` must equal the expense exactly, and a
participant's allocation _is_ its stated amount.

Inside the engine the amounts are handed to `allocateByWeights` **as the weights**.
When the weights sum to exactly the amount the largest-remainder rule is the
identity — `floor(A × aᵢ ÷ A) = aᵢ`, every remainder zero — so the parts come back as
the treasurer's figures to the paisa, and the result's `weight` for a custom split
is the stated paise amount. That is the one strategy where `weight` is money, and it
is the honest answer: the amount _is_ the basis that produced the allocation.
Reusing the one allocation path is what keeps `undistributedPaise` able to measure
that a custom result balanced.

Validation, in `customWeights`:

- a **negative** amount is refused — `expense_splits.amount_paise` is
  `CHECK (amount_paise >= 0)`, and a resident cannot owe less than nothing;
- a sum that **does not equal the expense** is refused, in both the message and
  `details.shortfallPaise` (signed: positive is unassigned money, negative is
  over-assigned). This is the server half of "save blocked until remaining is
  ₹0";
- the amount must be a **`Money` at runtime**, not only in the type — a wire
  payload that carried `amountPaise` as a plain number would otherwise throw a
  `TypeError` out of a function that promises a `Result`.

**Exclusion** is expressed by leaving a flat out of the participant list; a listed
₹0 amount is legal and produces a ₹0 allocation (`expense_splits.amount_paise` is
`CHECK (>= 0)`), which is a real thing a treasurer records — a caretaker's quarter,
a shop billed separately. Excluding _everyone_ is therefore not a silent zero
split: ₹0 does not equal the expense, and the shortfall error names the whole
amount.

## 6. Percentages are basis points

`BasisPoints` is an exact integer: `100% = 10_000n`, `0.01% = 1n`. The PRD's own
worked example `33.33 + 33.33 + 33.34 = 100.00` is `3333n + 3333n + 3334n = 10_000n`
— deterministic, with no epsilon to tune. In binary floating point it is
`99.99999999999999`.

Because one basis point _is_ the `0.01%` both the PRD and T056 allow, the tolerance
is an integer comparison, not a float one. It exists because some totals cannot be
expressed in two decimals at all: `33.33%` three times is `99.99%`, a legitimate
ledger, while `60% + 30%` is a mistake. The accepted range is `[9999, 10001]`.

The weights need not sum to `10_000` for the money to be right — the primitive
divides by the sum it is given — so accepting the tolerance is a decision about what
a treasurer may type, never a compromise in the arithmetic.

`0%` is legal and means "owes nothing from this pool" (an exempt flat); an all-zero
set is refused, because a split with nothing to divide by has no answer.

## 7. Sign, zero, and what is refused

- **The amount must be strictly positive.** `expenses.amount_paise` is
  `CHECK (amount_paise > 0)` (SAD §8), so a zero or negative amount is refused here
  as a field error rather than becoming a constraint violation at commit. Returning
  zeros would look like success and then fail.
- **`Money` stays signed.** Refunds, adjustments and balances are negative (T012),
  and `distribute` allocates a negative amount correctly — its magnitude, with every
  part negated, still summing exactly. The _engine_ just will not accept a negative
  expense.
- **At least one participant**, and no participant twice. Duplicates are keyed on
  `(apartmentId, memberId)` — the pair `expense_splits` is unique on — so two
  members of one flat is legal while the same member twice is a `conflict`.
- **A share is positive; a custom amount is non-negative.** A `0%` participant is
  legal (see §6) because a percentage split is a claim on a pool that some flat may
  legitimately hold none of, but a `0` share is refused (T057) and a negative custom
  amount is refused — there is no reading of “this flat owes ₹0.00 from a shares
  split” that a participant list cannot express more clearly by leaving the flat
  out.

## 8. Errors

| Code         | When                                                                                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation` | zero or negative amount; no participants; a percentage outside 0–100; a fractional percentage; percentages not totalling 100% within tolerance; a share that is zero, negative, fractional or above 10,000; a negative custom amount; custom amounts that do not sum to the amount |
| `conflict`   | the same member and flat appears twice                                                                                                                                                                                                                                             |
| `invariant`  | allocations do not sum to the amount (a bug; thrown)                                                                                                                                                                                                                               |

`details.field` is `"amount"`, `"participants"`, `"participants.percentage"`,
`"participants.share"` or `"participants.amount"`, so the API maps it to a `422`
whose `field` the form can highlight (SAD §7). A custom sum failure also carries
`details.shortfallPaise` — signed, as a string, because it is a bigint.

## 9. Ordering, determinism, and what is _not_ covered

Determinism is asserted over the whole pipeline: 1,000 identical runs, 500 random
equal splits each re-run reversed, 300 random percentage splits, 300 random shares
splits (300 more, re-run reversed), 200 randomly partitioned custom amounts (also
re-run reversed), and an exhaustive sweep of every amount from 1 to 200 paise
across 1 to 12 participants (2,400 splits) — the last one because a systematic
off-by-one at a particular divisor is what a random sample walks past.

Equivalence between strategies is asserted on exact paise, per allocation and per
participant id: `equal` and `shares` at one share each, `shares 1 : 2 : 1` and
`percentage 25 : 50 : 25`, and a `custom` split typed to the amounts an `equal` or
`shares` split produced. A strategy that rounded its own remainder could still pass
its own conservation test — a total can be conserved by the wrong rule — but it
could not agree with another strategy on the same input.

These properties are deterministic (a seeded xorshift, so a failure reproduces from
its seed) rather than `fast-check`. **The 10,000-iteration `fast-check` invariant
suite is Roadmap T059**, which owns its CI wiring; adding a second property-testing
toolchain now would be two things to keep green for one invariant.

## 10. The extension point

Adding a strategy means:

1. a new variant in `SplitInput` (`types.ts`), with the strategy's per-participant
   value on the participant — the shape `shares` and `custom` both use, and the one
   `apartment` will need;
2. a module in `strategies/` that turns an ordered participant list into
   `Result<readonly Weight[], SplitError>` (a strategy that needs the total, as
   `custom` does to check its sum, receives it as a second argument);
3. one `case` in `planSplit` (`engine.ts`).

`engine.ts`, `rounding.ts` and `types.ts` should not otherwise change, and no
strategy touches `Money` directly. Then extend `SPLIT_STRATEGIES` — and the test
that pins it will make you look at the change. The `switch` in `planSplit` has no
`default`: an arm per variant is what makes a missing one a compile error
(`TS2366`, measured by deleting the `shares` arm) instead of a runtime throw that
no test can reach.

## 11. Coverage, and how to measure it

T056 requires 100% coverage, and as of Roadmap T014 it is **enforced**, not merely
measured: `packages/split-engine/jest.config.js` declares a `global`
`coverageThreshold` of 100 on all four metrics, so an uncovered line exits
non-zero. `global` rather than a path pattern because the package _is_ the SAD
§15.2 row, and a global row cannot silently match nothing.

```bash
pnpm --filter @ses/split-engine test:coverage   # or, repo-wide, pnpm test:coverage
```

Measured 2026-09-30 (T057): **100% statements, branches, functions and lines** on
all nine source files — `engine.ts`, `rounding.ts`, `types.ts`, `index.ts` and the
four strategies — 88 tests. Thresholds, proofs and the (currently red) API row are
documented in `docs/guides/TEST_COVERAGE.md`.

## 12. Architecture boundary

`lint:arch` enforces two rules beyond the general ones:
`split-engine-is-framework-free` and `split-engine-depends-only-on-domain` (no
app, no `contracts`, no `db-schema`).

Both match **two path shapes**, and that is deliberate. Measured: an import the
package does not declare is reported with `dependencyTypes: ["unknown"]` and the
bare specifier (`@nestjs/common`) as its resolved path, because under pnpm's
per-package layout it never resolves to `node_modules` at all. A rule written the
usual way — a `node_modules/...` pattern with an `npm`/`npm-no-pkg` filter — matches
nothing in that case and passes silently. Verified by planting imports: both rules
fire on `@nestjs/common`, `zod` and `@ses/contracts`.
