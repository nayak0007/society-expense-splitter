import { DomainError, type DomainErrorInit } from "./errors";
import { ZERO_PAISE, formatPaise, isPaise, paise, type Paise } from "./money";
import { err, ok, type Result } from "./result";

/**
 * `Money` — the canonical monetary primitive (Roadmap T012, PRD §7, SAD §3.2).
 *
 * ## The one representation
 *
 * An exact integer number of paise, held as `bigint` (ADR-0005). There is no
 * float anywhere in this file and no second unit: rupees exist only as text on
 * the way in ({@link Money.fromRupees}) and as text on the way out
 * ({@link Money.format}). `0.1 + 0.2` is not `0.3`, and a society's ledger has to
 * balance to the paisa, so the representation is chosen once, here, and every
 * future financial object — Expense, Due, Payment — is built out of it.
 *
 * ## What this object refuses to do
 *
 * Money performs **no business rounding**. It will not take `"1.234"` (finer than
 * a paisa) and quietly pick a rule; it will not offer `divide(3)`, which has no
 * exact answer; and it will not multiply by a percentage, because *which way the
 * leftover paisa falls* is an allocation policy (the split engine, T056), not a
 * property of money. What it does offer — {@link Money.allocateByWeights} — is
 * proportional distribution with the residual distributed deterministically, so
 * the total is conserved exactly and the policy is visible at the call site
 * rather than hidden inside an operator.
 *
 * ## Immutability
 *
 * Every instance is frozen and every operation returns a new one. `add` cannot
 * mutate its receiver, so a value shared between a due and a receipt is safe by
 * construction.
 *
 * Depends on nothing: no Nest, no React, no Drizzle, no driver. The domain
 * package compiles unchanged for Node and for Hermes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Currency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The currencies the product supports.
 *
 * One, on purpose. Resident 360 targets Indian residential societies (PRD §1),
 * every `*_paise` column is INR, and the settings contract is
 * `currency: z.literal("INR")`. Carrying the code on every `Money` is not
 * multi-currency theatre: it is what makes a mistaken `usd.add(inr)` a loud error
 * today and a supported operation tomorrow, without changing a single call site
 * at the moment a second currency is genuinely added. No conversion rate, no
 * formatting switch, no exchange table exists here — none is needed yet.
 */
export const SUPPORTED_CURRENCIES = ["INR"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "INR";

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error codes for money construction and arithmetic.
 *
 * Both already exist in the shared catalogue, so the API's error mapper needs no
 * new case: `validation` for a value that could never be money (malformed text,
 * a fractional paisa, a bad weight set), `invariant` for an operation that is
 * meaningless rather than malformed (adding rupees to dollars).
 */
export const MONEY_ERROR_CODES = ["validation", "invariant"] as const;
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number];

export class MoneyError extends DomainError<MoneyErrorCode> {
  constructor(
    code: MoneyErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<MoneyErrorCode> = { code, message, details };
    super(init);
    this.name = "MoneyError";
  }
}

export function isMoneyError(error: unknown): error is MoneyError {
  return error instanceof MoneyError;
}

export function moneyError(
  code: MoneyErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): MoneyError {
  return new MoneyError(code, message, details);
}

// ─────────────────────────────────────────────────────────────────────────────
// Weight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Weight` — a non-negative whole proportion: a share count, a floor multiplier,
 * a weight in a weighted split.
 *
 * Deliberately a whole number. Real proportions are rational, and a rational held
 * as a float is exactly how a paisa goes missing; the split engine normalises
 * percentages and areas to integers before it gets here (T056/T058). Zero is
 * legal and means "owes nothing from this pool".
 */
declare const weightBrand: unique symbol;

export type Weight = bigint & { readonly [weightBrand]: "Weight" };

export const ZERO_WEIGHT = 0n as Weight;

export function weight(value: bigint | number): Weight {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw moneyError(
        "validation",
        `A weight must be a whole, non-negative number, received ${value}.`,
      );
    }
    return BigInt(value) as Weight;
  }
  if (value < 0n) {
    throw moneyError(
      "validation",
      `A weight must be non-negative, received ${value.toString()}.`,
    );
  }
  return value as Weight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * At most 30 integer digits (10^30 paise ≈ ₹10,000,000,000,000,000,000,000,000).
 *
 * Unbounded input would let a hostile or fat-fingered string of a million digits
 * cost quadratic bigint work inside a request handler. The bound is far above any
 * real figure and turns that into an ordinary field error.
 */
const MAX_RUPEES_INTEGER_DIGITS = 30;

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * Exact decimal-string → paise.
 *
 * Hand-scanned rather than `parseFloat`/`Number`, for two reasons. Float parsing
 * cannot be exact (`"0.29" * 100` is `28.999999999999996`), and the string is
 * scanned here so the *shape* rules are explicit and testable: at most two
 * decimal places, a leading integer digit required, no grouping beyond stripped
 * commas, no currency word, no exponent, no `NaN`.
 *
 * Accepted: `"0"`, `"0.00"`, `"1"`, `"1.2"`, `"1.20"`, `"1234.56"`, `"1,000.00"`,
 * `"₹100.00"`, `"01.00"`, `"+1.00"`, `"-1.00"`, and surrounding whitespace.
 *
 * Rejected, each with a validation error naming the field: `""` (nothing to
 * parse), `"1.234"` (finer than a paisa — the caller must choose a rounding rule,
 * this object will not), `"1."` (a decimal point with no paise), `".50"` (no
 * integer part), `"NaN"`, `"Infinity"`, and anything with trailing characters.
 * `"-0"` parses to exactly zero — never negative zero.
 */
function parseRupeesText(text: string): Result<Paise, MoneyError> {
  if (typeof text !== "string") {
    return err(
      moneyError(
        "validation",
        'A rupee amount must be written as a string, for example "1050.00".',
        { field: "amount" },
      ),
    );
  }

  // Grouping separators and a currency prefix are noise, not information: the
  // same amount typed by three people should parse to the same paise.
  const cleaned = text.trim().replace(/[₹,]/g, "");
  if (cleaned.length === 0) {
    return err(
      moneyError("validation", "Enter an amount.", { field: "amount" }),
    );
  }

  let index = 0;
  let sign = 1n;
  const lead = cleaned.charAt(0);
  if (lead === "+" || lead === "-") {
    if (lead === "-") sign = -1n;
    index = 1;
  }

  const integerStart = index;
  while (index < cleaned.length && isDigit(cleaned.charAt(index))) index += 1;
  const integerDigits = cleaned.slice(integerStart, index);
  if (integerDigits.length === 0) {
    return err(
      moneyError("validation", `"${text}" is not a valid rupee amount.`, {
        field: "amount",
      }),
    );
  }
  if (integerDigits.length > MAX_RUPEES_INTEGER_DIGITS) {
    return err(
      moneyError(
        "validation",
        "That amount is too large to represent exactly.",
        {
          field: "amount",
        },
      ),
    );
  }

  let fractionDigits = "";
  if (index < cleaned.length && cleaned.charAt(index) === ".") {
    index += 1;
    const fractionStart = index;
    while (index < cleaned.length && isDigit(cleaned.charAt(index))) index += 1;
    fractionDigits = cleaned.slice(fractionStart, index);
    if (fractionDigits.length === 0) {
      return err(
        moneyError(
          "validation",
          `"${text}" has a decimal point but no paise after it.`,
          { field: "amount" },
        ),
      );
    }
    if (fractionDigits.length > 2) {
      return err(
        moneyError(
          "validation",
          `"${text}" is finer than a paisa; at most two decimal places are accepted.`,
          { field: "amount" },
        ),
      );
    }
  }

  if (index !== cleaned.length) {
    return err(
      moneyError("validation", `"${text}" is not a valid rupee amount.`, {
        field: "amount",
      }),
    );
  }

  // `BigInt(digits)` on a digit string is exact for any length; `"1.2"` is two
  // tenths of a rupee, so `"2"` pads to `"20"` paise, not `2`.
  const whole = BigInt(integerDigits) * 100n;
  const fraction =
    fractionDigits.length === 0 ? 0n : BigInt(fractionDigits.padEnd(2, "0"));
  return ok(paise(sign * (whole + fraction)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

/** `-1` / `0` / `1`, so a caller can sort without a subtract that might overflow. */
export type Ordering = -1 | 0 | 1;

export class Money {
  /** The amount, in paise. Exact, signed, and never a float. */
  readonly paise: Paise;
  /** The currency — `INR` today (PRD §1). Never implicit. */
  readonly currency: Currency;

  private constructor(amount: Paise, currency: Currency) {
    this.paise = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  // ── Construction ───────────────────────────────────────────────────────────

  /**
   * From an exact integer number of paise. Throws {@link MoneyError} on anything
   * that is not one.
   *
   * Throws rather than returning a `Result`, and that is the intended shape: this
   * is the constructor a programmer calls with a value they already believe is
   * integral — a database column, an allocation, a literal in a test. A `number`
   * that is fractional or beyond the safe range is a bug in the caller, not user
   * input, and `fromRupees` is the door for input.
   */
  static fromPaise(
    value: bigint | number,
    currency: Currency = DEFAULT_CURRENCY,
  ): Money {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw moneyError(
        "validation",
        `Money must be a whole number of paise within the safe integer range, received ${value}; parse a decimal string with fromRupees instead.`,
        { field: "paise" },
      );
    }
    return new Money(paise(value), currency);
  }

  /**
   * From user or API text, e.g. `"4,52,250.75"`. Returns a `Result` because this
   * is the door untrusted input comes through — a form field, a CSV cell, a query
   * parameter — and "that is not an amount" is an expected outcome the caller
   * must render, not an exception.
   */
  static fromRupees(
    text: string,
    currency: Currency = DEFAULT_CURRENCY,
  ): Result<Money, MoneyError> {
    const parsed = parseRupeesText(text);
    if (!parsed.ok) return parsed;
    return ok(new Money(parsed.value, currency));
  }

  /** Zero in the given currency — the identity, and the empty balance. */
  static zero(currency: Currency = DEFAULT_CURRENCY): Money {
    return new Money(ZERO_PAISE, currency);
  }

  // ── Arithmetic ─────────────────────────────────────────────────────────────

  add(other: Money): Money {
    this.assertSameCurrency(other, "add");
    return new Money(paise(this.paise + other.paise), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, "subtract");
    return new Money(paise(this.paise - other.paise), this.currency);
  }

  /** `-₹10.00` from `₹10.00`. Needed by refunds, adjustments and credits. */
  negate(): Money {
    return new Money(paise(-this.paise), this.currency);
  }

  /**
   * The magnitude, keeping the currency.
   *
   * Returns `this` when it is already non-negative: the object is immutable, so
   * there is nothing to copy and a fresh instance would only make `a.abs() === a`
   * false for no reason.
   */
  abs(): Money {
    return this.isNegative() ? this.negate() : this;
  }

  /**
   * Exact integer scaling: `₹500 × 12` is `₹6,000`, with no rounding to get wrong.
   *
   * The weight is a whole number on purpose (see {@link Weight}). A *proportional*
   * share is not this operation — `multiplyByWeight(1/3)` is exactly the hidden
   * rounding this object exists to prevent, so it does not exist. Use
   * {@link Money.allocateByWeights} and let it place the residual deterministically.
   */
  multiplyByWeight(factor: Weight): Money {
    return new Money(paise(this.paise * factor), this.currency);
  }

  // ── Allocation ─────────────────────────────────────────────────────────────

  /**
   * Split this amount proportionally to `weights`, conserving every paisa.
   *
   * `total.allocateByWeights(w)` always satisfies
   * `Σ result === total.paise`, exactly, at paise precision — the invariant the
   * whole ledger rests on (PRD §18, SAD §4 "the residual paisa lands on the
   * largest fractional share, deterministically").
   *
   * The method is the largest-remainder rule, with no float anywhere:
   *
   *  1. `base_i = floor(|total| × w_i ÷ Σw)` — exact bigint division, so a
   *     `number` of any magnitude cannot round;
   *  2. the leftover `|total| − Σbase_i` is at most one paisa per participant and
   *     is handed out one at a time to the largest remainders
   *     (`(|total| × w_i) mod Σw`), ties broken by index ascending.
   *
   * A negative total allocates its magnitude and negates every part, so the sum
   * still equals the input rather than drifting by a paisa the way a naive
   * truncation would. A zero weight receives zero.
   *
   * Rejects an empty or all-zero weight set: a split with nothing to split by has
   * no answer, and returning `[]` or zeros would be a silent lie.
   */
  allocateByWeights(weights: readonly Weight[]): readonly Money[] {
    if (weights.length === 0) {
      throw moneyError("validation", "Allocation needs at least one weight.", {
        field: "weights",
      });
    }

    let total = 0n;
    for (const candidate of weights) {
      // The brand is compile-time only; this is the check that actually holds if
      // a caller has cast its way past `weight()`.
      if (!isPaise(candidate) || candidate < 0n) {
        throw moneyError(
          "validation",
          "Allocation weights must be whole, non-negative numbers.",
          { field: "weights" },
        );
      }
      total += candidate;
    }
    if (total === 0n) {
      throw moneyError(
        "validation",
        "Allocation needs at least one non-zero weight.",
        { field: "weights" },
      );
    }

    const negative = this.paise < 0n;
    const magnitude = negative ? -this.paise : this.paise;
    const residual =
      magnitude -
      weights.reduce(
        (sum, candidate) => sum + (magnitude * candidate) / total,
        0n,
      );

    return weights.map((shareWeight, position) => {
      const scaled = magnitude * shareWeight;
      const base = scaled / total;
      const mine = scaled % total;
      // How many participants rank strictly ahead of this one: a larger
      // remainder, or an equal one at a lower index. Computed rather than
      // mutated, so the result cannot depend on iteration order.
      const ahead = weights.reduce((count, other, otherPosition) => {
        const theirs = (magnitude * other) % total;
        const ranksAhead =
          theirs > mine || (theirs === mine && otherPosition < position);
        return ranksAhead ? count + 1n : count;
      }, 0n);
      const share = ahead < residual ? base + 1n : base;
      return new Money(paise(negative ? -share : share), this.currency);
    });
  }

  // ── Comparison ─────────────────────────────────────────────────────────────

  /**
   * Value equality — `₹1.00` equals `₹1.00` and not `₹1.01`, by value rather than
   * by object identity, and not across currencies.
   */
  equals(other: Money): boolean {
    return this.paise === other.paise && this.currency === other.currency;
  }

  /**
   * Total order: `₹0` < `₹0.01` < `₹1` < `₹100`, and the same for negatives.
   * Throws on a currency mismatch — there is no rate here, so the comparison would
   * be a guess.
   */
  compare(other: Money): Ordering {
    this.assertSameCurrency(other, "compare");
    if (this.paise < other.paise) return -1;
    if (this.paise > other.paise) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.paise === 0n;
  }

  isPositive(): boolean {
    return this.paise > 0n;
  }

  isNegative(): boolean {
    return this.paise < 0n;
  }

  // ── Presentation ───────────────────────────────────────────────────────────

  /**
   * `₹4,52,250.75`. Presentation only — never parse it back into state, and never
   * send it as an authoritative amount (SAD §7.9: money on the wire is an integer
   * `*Paise` field).
   */
  format(): string {
    return formatPaise(this.paise);
  }

  /**
   * The plain decimal rupees text that {@link Money.fromRupees} parses back:
   * `"10000"`, `"10000.50"`, `"-1.5"` → no, `"-1.50"`. No symbol, no grouping,
   * no exponent, and a `-` for a negative.
   *
   * It exists because a form that *edits* an amount has to prefilled with one, and
   * the alternative is a second hand-rolled paise→rupees conversion in the UI that
   * drifts from the parser. Being the exact inverse also makes the round trip
   * assertable (`fromRupees(m.toRupeesString()).paise === m.paise`) rather than a
   * property of one screen.
   */
  toRupeesString(): string {
    const negative = this.paise < 0n;
    const magnitude = negative ? -this.paise : this.paise;
    const subunit = magnitude % 100n;
    const fraction =
      subunit === 0n ? "" : `.${subunit.toString().padStart(2, "0")}`;
    return `${negative ? "-" : ""}${(magnitude / 100n).toString()}${fraction}`;
  }

  private assertSameCurrency(other: Money, operation: string): void {
    if (this.currency !== other.currency) {
      throw moneyError(
        "invariant",
        `Cannot ${operation} money in ${this.currency} and money in ${other.currency}; no exchange rate exists.`,
        { left: this.currency, right: other.currency },
      );
    }
  }
}
