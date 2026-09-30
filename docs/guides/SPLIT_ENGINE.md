# Split engine

The rules `packages/split-engine` enforces, written for whoever adds the `shares`,
`custom` and apartment-based strategies (T057/T058), the expense aggregate (T061)
or the live preview endpoint (T064). Not a tutorial — the list of decisions the
package has already made so the next layer does not re-decide them differently.

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
integer paise (T012, ADR-0005). **This package performs no arithmetic on amounts at
all.** It hands the amount and one weight per participant to
`Money.allocateByWeights` and reports what came back. There is no second
largest-remainder implementation, no `parseFloat`, no `Math.round`, no `toFixed`
and no float anywhere in `src/`. The only division in the package is
`basisPoints / 100n` in a display helper.

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
| `apartment`  | an apartment attribute           | T058  |
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

## 8. Errors

| Code         | When                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation` | zero or negative amount; no participants; a percentage outside 0–100; a fractional percentage; percentages not totalling 100% within tolerance |
| `conflict`   | the same member and flat appears twice                                                                                                         |
| `invariant`  | allocations do not sum to the amount (a bug; thrown)                                                                                           |

`details.field` is `"amount"` or `"participants"`/`"participants.percentage"`, so the
API maps it to a `422` whose `field` the form can highlight (SAD §7).

## 9. Ordering, determinism, and what is _not_ covered

Determinism is asserted over the whole pipeline: 1,000 identical runs, 500 random
equal splits each re-run reversed, and an exhaustive sweep of every amount from 1
to 200 paise across 1 to 12 participants (2,400 splits) — the last one because a
systematic off-by-one at a particular divisor is what a random sample walks past.

These properties are deterministic (a seeded xorshift, so a failure reproduces from
its seed) rather than `fast-check`. **The 10,000-iteration `fast-check` invariant
suite is Roadmap T059**, which owns its CI wiring; adding a second property-testing
toolchain now would be two things to keep green for one invariant.

## 10. The extension point

Adding a strategy means:

1. a new variant in `SplitInput` (`types.ts`), with the strategy's per-participant
   value on the participant — the shape `shares` and `custom` both need;
2. a module in `strategies/` that turns an ordered participant list into
   `Result<readonly Weight[], SplitError>`;
3. one branch in `planSplit` (`engine.ts`).

`engine.ts`, `rounding.ts` and `types.ts` should not otherwise change, and no
strategy touches `Money` directly. Then extend `SPLIT_STRATEGIES` — and the test
that pins it will make you look at the change.

## 11. Coverage, and how to measure it

T056 requires 100% coverage. **The gate itself is not wired here** — Roadmap T014
owns `--coverage` and the per-path thresholds, and declaring a second threshold in
this package would be a second source of truth for the same number. So it is
measured:

```bash
pnpm --filter @ses/split-engine test --coverage
```

Measured 2026-09-29: **100% statements, branches, functions and lines** on
`engine.ts`, `rounding.ts`, `types.ts`, `index.ts`, `strategies/equal.ts` and
`strategies/percentage.ts`.

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
