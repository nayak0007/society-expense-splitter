# Money

The invariants every financial object in Resident 360 is built on. Written for
whoever adds the Expense aggregate, the split engine (T056) or the billing cycle
— not as a tutorial, but as the list of rules the primitive already enforces so
that the next layer does not have to re-decide them.

Source: [`packages/domain/src/shared/money.ts`](../../packages/domain/src/shared/money.ts)
(the `Paise` primitive) and
[`packages/domain/src/shared/money.vo.ts`](../../packages/domain/src/shared/money.vo.ts)
(the `Money` value object — Roadmap T012).

## 1. One canonical representation

**`Money` is an exact integer number of paise, held as `bigint`.** There is no
second representation.

```
₹1.00   →  100 paise
₹10.50  →  1050 paise
₹4,52,250.75 → 45_225_075n
```

`Paise` is the branded primitive (`bigint & { [brand]: "Paise" }`); `Money` is
the behaviour on top of it. Anything that needs an amount — a due, a split, a
receipt total — holds `Money`, and the only way to build one is
`Money.fromPaise` / `Money.fromRupees` / `Money.zero`.

Why `bigint` and not `number`: `number` is exact only up to 2^53 − 1 (~₹90
trillion), so it would _appear_ to work and then silently round a ledger under a
bad import or a summed cycle. `bigint` makes that impossible. It also matches the
storage: every `*_paise` column is `bigint` (PRD §7, SAD §2.3 rule 3, ADR-0005),
and `paiseColumn` in `@ses/db-schema` is `bigint({ mode: "bigint" })` for exactly
this reason.

## 2. Currency

**INR only.** `SUPPORTED_CURRENCIES = ["INR"]`, the settings contract is
`currency: z.literal("INR")`, and the product is India-only (PRD §1). There is no
exchange rate, no conversion and no multi-currency formatting anywhere.

`Money` does carry a `currency`, though, and that is not theatre: it is what
makes `inr.add(usd)` a thrown `MoneyError` **today**, so adding a second currency
later is a data change rather than a bug hunt. `equals` and `compare` are
currency-aware for the same reason.

## 3. Precision, and who owns rounding

- Two decimal places (paise) is the unit. **A fraction of a paisa is rejected,
  never rounded** — `Money.fromRupees("1.234")` fails; it does not pick 1.23.
- `Money` performs **no business rounding**. It has no `divide`, and
  `multiplyByWeight` takes a whole number, because `money × 0.33` and
  `money ÷ 3` have no exact answer and hiding the remainder is how a paisa
  disappears.
- Proportional splitting is
  [`Money.allocateByWeights`](../../packages/domain/src/shared/money.vo.ts) —
  largest remainder, residual distributed one paisa at a time to the largest
  fractional remainders, ties broken by index ascending. `Σ parts === total`,
  exactly, always.
- **The split engine (T056) owns allocation policy.** It decides _which_
  strategy, _what_ weights and _which tie-break order a UI shows_; `Money` only
  guarantees that whatever weights it is handed conserve the total.

## 4. Signed money is legal

Negative `Money` is a first-class value. Refunds, adjustments, advance credits and
outstanding balances are negative amounts, and forbidding them would push callers
into `abs()` gymnastics that lose the sign they needed.

`negate()` and `abs()` exist for that reason; `isPositive()` / `isNegative()` /
`isZero()` are the sign predicates. Where a sign is genuinely invalid, the owning
field says so itself — the society approval threshold rejects a negative in its
own value object.

`allocateByWeights` on a negative total allocates its **magnitude** and negates
every part, so a refund also conserves exactly.

## 5. Parsing

Text is parsed **exactly**, by reading digits — never `parseFloat`, never
`Number(x)`. `0.29 × 100` is `28.999999999999996`; the digits `0.29` are `29n`.

| Input                                        | Result                            |
| -------------------------------------------- | --------------------------------- |
| `"0"`, `"0.00"`                              | `0n`                              |
| `"1"`, `"1.2"`, `"1.20"`, `"1234.56"`        | `100n`, `120n`, `120n`, `123456n` |
| `"1,000.00"`, `"₹100.00"`, `" 10.50 "`       | `100000n`, `10000n`, `1050n`      |
| `"01.00"`, `"+1.00"`, `"-1.00"`, `"-0"`      | `100n`, `100n`, `-100n`, `0n`     |
| `""`, `"NaN"`, `"Infinity"`, `"1."`, `".50"` | rejected                          |
| `"1.234"`                                    | rejected — finer than a paisa     |
| `"1e3"`, `"1.2.3"`, `"10x"`                  | rejected                          |

`Money.fromRupees` returns a `Result` (this is the door untrusted input comes
through); `Money.fromPaise` throws a `MoneyError` (a fractional or unsafe
`number` of paise is a caller bug, not user input). A `number` of **rupees** is
never accepted from anywhere — `fromRupees` takes a string by design.

`Money.toRupeesString()` is the exact inverse, for prefilling a form. Round trip
is asserted as a property, not by example.

## 6. Range and overflow

- `bigint` has no practical upper bound in the domain, so arithmetic cannot
  overflow. `Money.fromPaise` still refuses a non-safe-integer **`number`**,
  because such a value was already lossy before it arrived.
- Rejected everywhere: `NaN`, `Infinity`, a fractional number of paise, a
  `number` above `Number.MAX_SAFE_INTEGER`.
- An integer part longer than 30 digits is rejected, so a hostile string cannot
  cost quadratic bigint work inside a request.
- JSON cannot carry a `bigint` (`JSON.stringify` throws). `paiseToWire` is the
  **single** crossing point and it throws — rather than rounding — for an amount
  above `Number.MAX_SAFE_INTEGER`.

## 7. Serialization

Money crosses the wire as a **bare integer in a `*Paise` field** — never a
formatted string, never a number of rupees (SAD §7.9, §18.1):

```jsonc
{ "approvalThresholdPaise": 1000000 } // ₹10,000
```

`format()` output (`₹4,52,250.75`) is **presentation only**: it is never parsed
back into state and never authoritative. `paiseToWire` is how a domain value
becomes the wire integer, and `paise(...)` is how a wire integer becomes a
domain value.

Adding a money field to a request contract therefore requires no schema decision:
the wire stays an integer, and the domain brands it at the boundary.

## 8. Database

Storage is `bigint` paise in a `_paise`-suffixed column, `NOT NULL` unless the
amount genuinely does not exist yet — `paiseColumn` / `optionalPaiseColumn` in
`@ses/db-schema`. Never `numeric`, never `money`, never `float`. T012 added no
migration; the existing `approval_threshold_paise` column already met this rule.

## 9. What is deliberately absent

| Not built                                | Why                                                    |
| ---------------------------------------- | ------------------------------------------------------ |
| `divide`, fractional `multiply`          | Need a rounding rule; that is allocation policy (T056) |
| Percentages, shares, area/floor bases    | Split engine (T056–T058)                               |
| Expense, Due, Payment, billing, Razorpay | Phase 4+, consuming this primitive                     |
| Any UI formatting beyond `format()`      | Presentation belongs to the app (§7)                   |

## 10. Enforcement

| Rule                                            | Enforced by                                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Integer paise, never a float                    | `Paise` is `bigint`; the only constructor is `paise()`                                                                     |
| No float parsing or arithmetic in `Money`       | `money.test.ts` inspects every member's source for `parseFloat`/`parseInt`/`Number(` plus exactness cases (`0.29` → `29n`) |
| Allocations conserve                            | Property test, 10,000 random amounts × weight sets                                                                         |
| 100% coverage                                   | Measured at 100% statements/branches/functions/lines on both money files                                                   |
| Money carries `bigint`, wire carries an integer | `paiseToWire` (one place) and the DTO→domain mappers                                                                       |
| No formatted string is authoritative            | `format()` is documented as presentation; contracts carry integers                                                         |
