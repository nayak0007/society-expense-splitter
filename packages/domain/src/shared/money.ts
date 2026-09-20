/**
 * `Paise` — money as an integer number of paise (PRD §18, SAD §1.1 "No floats in
 * money paths": a branded type plus a lint rule banning `parseFloat`/`Number` on
 * `*Paise` fields).
 *
 * This is the minimal piece the Society domain needs (the approval threshold is
 * a money value). The full `Money` value object with arithmetic and allocation
 * is Roadmap T012 — deliberately not pre-empted here.
 *
 * Rupees exist only at the edges: user input and display. Everything stored,
 * compared or summed is an integer, because `0.1 + 0.2 !== 0.3` and a society's
 * ledger must balance to the paisa.
 */
declare const paiseBrand: unique symbol;

export type Paise = number & { readonly [paiseBrand]: "Paise" };

export const ZERO_PAISE = 0 as Paise;

export function isPaise(value: unknown): value is Paise {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** From an already-integer paise amount. Throws on floats and negatives. */
export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `[money] Paise must be a non-negative safe integer, received ${value}`,
    );
  }
  return value as Paise;
}

/**
 * Rupees (what a user types) → paise. Rounds to the nearest paisa: the only
 * place a fractional value may exist is a value on its way in, never a stored one.
 */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees) || rupees < 0) {
    throw new RangeError(
      `[money] Rupees must be a finite non-negative number, received ${rupees}`,
    );
  }
  return paise(Math.round(rupees * 100));
}

export function paiseToRupees(amount: Paise): number {
  return amount / 100;
}

/**
 * `₹1,23,456` — Indian digit grouping (PRD §1: the product is India-only; a
 * treasurer reading `123,456` in lakhs thinks in a different scale).
 */
export function formatPaise(amount: Paise): string {
  return `₹${formatIndianDigits(Math.round(amount / 100).toString())}`;
}

/** Integer grouping: last three digits, then pairs (1,23,456). */
export function formatIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${grouped},${lastThree}`;
}
