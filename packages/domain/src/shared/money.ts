/**
 * `Paise` — money as an integer number of paise.
 *
 * The unit is not a convention here, it is the storage format: PRD §7 ("all
 * monetary values are `bigint` paise. Never `float`, never `money`"), SAD §2.3
 * rule 3 and ADR-0005 (`money-as-bigint-paise`) all say the same thing, and every
 * `*_paise` column in `supabase/migrations/` and `@ses/db-schema` is `bigint`.
 *
 * ## Why `bigint` and not `number`
 *
 * `number` is exact only up to 2^53 − 1. That is about ₹90 trillion, far beyond
 * any residential society, so `number` would appear to work — right up until an
 * import, a multiplied field or a summed cycle silently rounds and the error
 * surfaces as a bill that does not add up. `bigint` makes that class of bug
 * impossible rather than merely unlikely, which is why `paiseColumn` in
 * `@ses/db-schema` is `bigint({ mode: "bigint" })`: the value never passes
 * through a float on its way from Postgres to `Money`.
 *
 * ## Where `number` is still allowed
 *
 * Exactly one place: the JSON wire, because JSON has no bigint (the same reason
 * `JSON.stringify` throws on one). {@link paiseToWire} is that single,
 * range-checked crossing point.
 *
 * ## Layout
 *
 * This file is the *primitive* — the branded unit and its rendering. Behaviour
 * (arithmetic, weighted allocation) belongs to the `Money` value object in
 * `money.vo.ts` (Roadmap T012), which wraps this type. One unit, one brand, one
 * place to construct it: there is no second integer-money representation to keep
 * in step.
 */
declare const paiseBrand: unique symbol;

export type Paise = bigint & { readonly [paiseBrand]: "Paise" };

export const ZERO_PAISE = 0n as Paise;

export function isPaise(value: unknown): value is Paise {
  return typeof value === "bigint";
}

/**
 * Brands a value as paise.
 *
 * A `bigint` is accepted as it stands — every bigint *is* an integer, so there is
 * nothing to reject. A `number` must be a safe integer: a fractional one is a
 * float that escaped the boundary, and an unsafe one is already lossy, so both
 * are refused rather than rounded.
 *
 * Signed values are allowed deliberately. A refund, an adjustment and an
 * outstanding balance are negative money (Roadmap T012), and forbidding them here
 * would push callers into `Math.abs` gymnastics that lose the sign they needed.
 * Where a sign is genuinely invalid, the owning field says so itself — the
 * society approval threshold, for instance, rejects negatives in its own value
 * object.
 */
export function paise(value: bigint | number): Paise {
  if (typeof value === "bigint") return value as Paise;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `[money] Paise must be a whole, exactly-representable number of paise, received ${value}`,
    );
  }
  return BigInt(value) as Paise;
}

/**
 * Paise → the integer the JSON wire carries.
 *
 * The single crossing point between the domain's `bigint` and a JSON document,
 * and deliberately a *throwing* one: a value above `Number.MAX_SAFE_INTEGER` has
 * no exact JSON representation, so the useful outcome is a loud failure at the
 * boundary rather than a rounded number that reaches the database and settles to
 * the wrong paisa.
 *
 * The `Number(...)` call is exact precisely *because* of the check that follows
 * it — this is a conversion with a range guard, not a floating-point operation on
 * a monetary value. Nothing in this function performs arithmetic.
 */
export function paiseToWire(amount: Paise): number {
  const asNumber = Number(amount);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(
      `[money] ${amount.toString()} paise cannot cross the JSON wire without losing precision.`,
    );
  }
  return asNumber;
}

/**
 * `₹4,52,250.75` — Indian digit grouping, exactly two decimals, sign before the
 * symbol (`-₹1.00`, not `₹-1.00`).
 *
 * Two decimals always, including `.00`: a ledger column that sometimes shows
 * `₹1,000` and sometimes `₹1,000.50` is one a treasurer has to re-read, and a
 * receipt that renders `₹999.99` as `₹999` is simply wrong.
 */
export function formatPaise(amount: Paise): string {
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const rupees = magnitude / 100n;
  const subunit = magnitude % 100n;
  return `${negative ? "-" : ""}₹${formatIndianDigits(rupees.toString())}.${subunit
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Integer grouping: last three digits, then pairs (`1,23,456`).
 *
 * The product is India-only (PRD §1), so lakh/crore grouping is the correct one
 * and `Intl.NumberFormat` is not needed: this is a pure string transform, which
 * keeps the domain free of locale data and of `Intl` differences between Hermes
 * and Node.
 */
export function formatIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${grouped},${lastThree}`;
}
