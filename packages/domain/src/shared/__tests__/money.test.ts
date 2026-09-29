import {
  DEFAULT_CURRENCY,
  MONEY_ERROR_CODES,
  Money,
  MoneyError,
  SUPPORTED_CURRENCIES,
  ZERO_WEIGHT,
  isMoneyError,
  moneyError,
  weight,
  type Currency,
  type Ordering,
  type Weight,
} from "../money.vo";
import {
  ZERO_PAISE,
  formatIndianDigits,
  formatPaise,
  isPaise,
  paise,
  paiseToWire,
} from "../money";
import type { Result } from "../result";

/**
 * `Money` and `Paise` — the specification of the whole financial foundation
 * (Roadmap T012).
 *
 * Three kinds of assertion live here, and they are not interchangeable:
 *
 *  - **Boundaries** (`0`, `1`, `-1`, `99`, `100`, `101`, the largest exactly
 *    representable value, an unsafe one) pin the edges of the representation.
 *  - **Property tests** (below, seeded and deterministic) state the algebra —
 *    commutativity, associativity, inverse, conservation of an allocation — once,
 *    for a thousand random inputs, instead of by example for five.
 *  - **A negative-space assertion** that the value object performs no
 *    floating-point arithmetic at all, which is the acceptance criterion this
 *    entire file exists to make true.
 */

/**
 * The one supported currency is `INR`, so a foreign amount cannot be built
 * without casting. That is deliberate and the cast is the point: cross-currency
 * arithmetic has to be *provably* refused even though it is unreachable today,
 * because "add a second currency" must not be the change that discovers the
 * guard was never there.
 */
const USD = "USD" as unknown as Currency;

function expectMoney(result: Result<Money, MoneyError>): Money {
  if (!result.ok)
    throw new Error(`expected money, got ${result.error.message}`);
  return result.value;
}

/** xorshift32 — deterministic, so a failure is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomMoney(
  random: () => number,
  maxMagnitude = 1_000_000_000,
): Money {
  const magnitude = Math.floor(random() * maxMagnitude);
  return Money.fromPaise(random() < 0.5 ? -magnitude : magnitude);
}

/** Random weights that always contain at least one non-zero entry. */
function randomWeights(random: () => number): Weight[] {
  const count = 1 + Math.floor(random() * 8);
  const list: Weight[] = [];
  let positive = false;
  for (let index = 0; index < count; index += 1) {
    const value = Math.floor(random() * 20);
    if (value > 0) positive = true;
    list.push(weight(value));
  }
  if (!positive) list[0] = weight(1);
  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paise primitive
// ─────────────────────────────────────────────────────────────────────────────

describe("Paise", () => {
  it("is a bigint brand and nothing else", () => {
    expect(isPaise(paise(1))).toBe(true);
    expect(isPaise(paise(1n))).toBe(true);
    // A plain `number` of paise is precisely what the brand exists to exclude:
    // it is the shape a float leak would arrive in.
    expect(isPaise(1)).toBe(false);
    expect(isPaise("1")).toBe(false);
    expect(isPaise(undefined)).toBe(false);
    expect(isPaise(null)).toBe(false);
  });

  it("accepts any bigint and only exactly-representable numbers", () => {
    expect(paise(5n)).toBe(5n);
    expect(paise(-5n)).toBe(-5n);
    expect(paise(5)).toBe(5n);
    // Unbounded above: the reason paise are bigint is that a value beyond 2^53
    // must stay exact rather than silently round.
    expect(paise(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);

    expect(() => paise(1.5)).toThrow(RangeError);
    expect(() => paise(Number.NaN)).toThrow(RangeError);
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => paise(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it("normalises negative zero, so a zero amount is never negative", () => {
    expect(paise(-0)).toBe(0n);
    expect(paise(-0)).toBe(ZERO_PAISE);
    expect(Money.fromPaise(-0).isNegative()).toBe(false);
  });

  it("crosses to the JSON wire only within the exactly-representable range", () => {
    expect(paiseToWire(paise(0))).toBe(0);
    expect(paiseToWire(paise(1050))).toBe(1050);
    expect(paiseToWire(paise(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    // A value JSON cannot carry exactly fails loudly instead of rounding: the
    // alternative reaches the database and settles to the wrong paisa.
    expect(() => paiseToWire(paise(9_007_199_254_740_993n))).toThrow(
      RangeError,
    );
  });

  it("formats with Indian grouping and exactly two decimals", () => {
    expect(formatPaise(paise(0))).toBe("₹0.00");
    expect(formatPaise(paise(1))).toBe("₹0.01");
    expect(formatPaise(paise(99))).toBe("₹0.99");
    expect(formatPaise(paise(100))).toBe("₹1.00");
    expect(formatPaise(paise(101))).toBe("₹1.01");
    expect(formatPaise(paise(150))).toBe("₹1.50");
    // ₹1,000 · ₹1,00,000 · ₹1,00,00,000 — the three grouping boundaries.
    expect(formatPaise(paise(100_000))).toBe("₹1,000.00");
    expect(formatPaise(paise(10_000_000))).toBe("₹1,00,000.00");
    expect(formatPaise(paise(1_000_000_000))).toBe("₹1,00,00,000.00");
    expect(formatPaise(paise(99_999_999))).toBe("₹9,99,999.99");
    // The sign comes before the symbol, not between the symbol and the digits.
    expect(formatPaise(paise(-100))).toBe("-₹1.00");
    expect(formatPaise(paise(-1))).toBe("-₹0.01");
  });

  it("groups digits in lakhs without touching short numbers", () => {
    expect(formatIndianDigits("1")).toBe("1");
    expect(formatIndianDigits("123")).toBe("123");
    expect(formatIndianDigits("1234")).toBe("1,234");
    expect(formatIndianDigits("12345")).toBe("12,345");
    expect(formatIndianDigits("123456")).toBe("1,23,456");
    expect(formatIndianDigits("10000000")).toBe("1,00,00,000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

describe("Money construction", () => {
  it("builds from paise through one branded entry point", () => {
    expect(Money.fromPaise(0).paise).toBe(0n);
    expect(Money.fromPaise(1050n).paise).toBe(1050n);
    expect(Money.fromPaise(-1050).paise).toBe(-1050n);
    expect(Money.zero().paise).toBe(ZERO_PAISE);
    expect(Money.zero().currency).toBe(DEFAULT_CURRENCY);
    expect(SUPPORTED_CURRENCIES).toContain(DEFAULT_CURRENCY);
    expect(Money.zero().format()).toBe("₹0.00");
  });

  it("refuses a fractional or unsafe number of paise", () => {
    const fractional = (): unknown => Money.fromPaise(10.5);
    expect(fractional).toThrow(MoneyError);
    expect(() => Money.fromPaise(Number.NaN)).toThrow(MoneyError);
    expect(() => Money.fromPaise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => Money.fromPaise(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      MoneyError,
    );
    // …but the largest exact value is fine, and bigint goes past it freely.
    expect(Money.fromPaise(Number.MAX_SAFE_INTEGER).paise).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });
});

describe("Money.fromRupees — exact decimal parsing", () => {
  const accepted: [string, bigint][] = [
    ["0", 0n],
    ["0.00", 0n],
    ["1", 100n],
    ["1.2", 120n],
    ["1.20", 120n],
    ["10.50", 1050n],
    ["1234.56", 123456n],
    ["999.99", 99999n],
    ["1,000.00", 100000n],
    ["₹100.00", 10000n],
    ["01.00", 100n],
    ["+1.00", 100n],
    ["-1.00", -100n],
    ["  10.50  ", 1050n],
    ["4,52,250.75", 45225075n],
    ["0.01", 1n],
    ["-0", 0n],
    // 0.1 + 0.2 is 0.30000000000000004 and 0.29 * 100 is 28.999999999999996;
    // neither can happen here because the digits are read, not multiplied.
    ["0.29", 29n],
    ["0.07", 7n],
    // Above the float precision of a whole-rupee count: still exact.
    ["90071992547409.91", 9007199254740991n],
  ];

  it.each(accepted)("parses %s as %s paise", (text, expected) => {
    expect(expectMoney(Money.fromRupees(text)).paise).toBe(expected);
  });

  const rejected: string[] = [
    "",
    "   ",
    "₹",
    "abc",
    "NaN",
    "Infinity",
    "-Infinity",
    "1.",
    ".50",
    "1.234",
    "1.2.3",
    "1..2",
    "10x",
    "1e3",
    "--1",
    "++1",
  ];

  it.each(rejected)("rejects %p", (text) => {
    const result = Money.fromRupees(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(MoneyError);
    expect(result.error.code).toBe("validation");
    expect(result.error.details).toEqual({ field: "amount" });
  });

  it("rejects a value that is not a string at all", () => {
    const result = Money.fromRupees(1050 as unknown as string);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
  });

  it("refuses an amount long enough to be an attack rather than a number", () => {
    const absurd = "9".repeat(31);
    const result = Money.fromRupees(absurd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/too large/i);
  });

  it("rejects a fraction of a paisa instead of choosing a rounding rule", () => {
    const result = Money.fromRupees("1.005");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/finer than a paisa/i);
  });

  it("reads a decimal point with nothing after it as malformed", () => {
    const result = Money.fromRupees("1.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/no paise/i);
  });

  it("keeps a parsed negative zero unsigned", () => {
    const zero = expectMoney(Money.fromRupees("-0"));
    expect(zero.isZero()).toBe(true);
    expect(zero.isNegative()).toBe(false);
  });

  it("round-trips through its own decimal form, exactly", () => {
    const cases = ["0", "1", "1.50", "10000", "-1.50", "4,52,250.75"];
    for (const text of cases) {
      const money = expectMoney(Money.fromRupees(text));
      const again = expectMoney(Money.fromRupees(money.toRupeesString()));
      expect(again.paise).toBe(money.paise);
    }
    expect(Money.fromPaise(100).toRupeesString()).toBe("1");
    expect(Money.fromPaise(150).toRupeesString()).toBe("1.50");
    expect(Money.fromPaise(-150).toRupeesString()).toBe("-1.50");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe("Money arithmetic", () => {
  it("adds and subtracts exactly, without mutating either operand", () => {
    const a = Money.fromPaise(100);
    const b = Money.fromPaise(50);

    expect(a.add(b).paise).toBe(150n);
    expect(a.subtract(Money.fromPaise(30)).paise).toBe(70n);
    expect(a.paise).toBe(100n);
    expect(b.paise).toBe(50n);
    expect(a.add(b)).not.toBe(a);
  });

  it("stays exact past the safe integer range, where a number would silently round", () => {
    const huge = Money.fromPaise(BigInt(Number.MAX_SAFE_INTEGER));
    expect(huge.add(Money.fromPaise(1)).paise).toBe(
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    );
    expect(huge.add(Money.fromPaise(1)).equals(huge)).toBe(false);
  });

  it("negates and takes an absolute value", () => {
    const positive = Money.fromPaise(250);
    const negative = Money.fromPaise(-250);

    expect(negative.negate().paise).toBe(250n);
    expect(positive.negate().paise).toBe(-250n);
    expect(negative.abs().paise).toBe(250n);
    expect(positive.abs().paise).toBe(250n);
    // Immutable, so an already-positive value can be returned as-is.
    expect(positive.abs()).toBe(positive);
    expect(Money.zero().abs().isZero()).toBe(true);
  });

  it("scales by a whole weight with no rounding to lose", () => {
    // ₹500 a month for a year.
    const monthly = expectMoney(Money.fromRupees("500"));
    expect(monthly.multiplyByWeight(weight(12)).paise).toBe(600_000n);
    expect(monthly.multiplyByWeight(weight(0)).isZero()).toBe(true);
    expect(monthly.multiplyByWeight(weight(1)).equals(monthly)).toBe(true);
  });

  it("has no division and no fractional multiplier, so no paise can vanish", () => {
    const money = Money.fromPaise(100);
    // `divide`/`multiply(0.33)` do not exist on purpose: both need a rounding
    // rule, and rounding is allocation policy (T056), never a property of money.
    expect(Object.getOwnPropertyNames(Money.prototype)).not.toContain("divide");
    expect(() => weight(0.33)).toThrow(MoneyError);
    expect(() => weight(1.5)).toThrow(MoneyError);
    expect(() => weight(-1)).toThrow(MoneyError);
    expect(() => weight(-1n)).toThrow(MoneyError);
    expect(weight(0)).toBe(0n);
    expect(weight(3n)).toBe(3n);
    expect(weight(3)).toBe(3n);
    expect(money.paise).toBe(100n);
  });

  it("signs money, because refunds and balances are negative", () => {
    expect(Money.fromPaise(-1).isNegative()).toBe(true);
    expect(Money.fromPaise(-1).isPositive()).toBe(false);
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.zero().isNegative()).toBe(false);
    expect(Money.fromPaise(1).isPositive()).toBe(true);
  });

  it("refuses to mix currencies, in both directions", () => {
    const rupees = Money.fromPaise(100);
    const dollars = Money.fromPaise(100, USD);

    expect(() => rupees.add(dollars)).toThrow(MoneyError);
    expect(() => dollars.add(rupees)).toThrow(MoneyError);
    expect(() => rupees.subtract(dollars)).toThrow(MoneyError);
    expect(() => rupees.compare(dollars)).toThrow(MoneyError);
    const mismatch = (): unknown => rupees.add(dollars);
    expect(mismatch).toThrow(/no exchange rate/i);
    // Not equal, and not added — but each is internally consistent.
    expect(rupees.equals(dollars)).toBe(false);
    expect(dollars.currency).toBe(USD);
    expect(rupees.currency).toBe(DEFAULT_CURRENCY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Comparison
// ─────────────────────────────────────────────────────────────────────────────

describe("Money comparison", () => {
  it("compares by value, never by identity", () => {
    expect(Money.fromPaise(100).equals(Money.fromPaise(100))).toBe(true);
    expect(Money.fromPaise(100).equals(Money.fromPaise(101))).toBe(false);
    expect(Money.fromPaise(0).equals(Money.zero())).toBe(true);
    expect(Money.fromPaise(100).equals(Money.fromPaise(100, USD))).toBe(false);
  });

  it("orders amounts, including across zero", () => {
    const amounts = [
      Money.fromPaise(-100),
      Money.fromPaise(-1),
      Money.fromPaise(0),
      Money.fromPaise(1),
      Money.fromPaise(100),
      Money.fromPaise(10_000),
    ];
    for (let index = 1; index < amounts.length; index += 1) {
      const previous = amounts[index - 1];
      const current = amounts[index];
      if (previous === undefined || current === undefined)
        throw new Error("gap");
      expect(previous.compare(current)).toBe(-1);
      expect(current.compare(previous)).toBe(1);
    }
    expect(Money.fromPaise(7).compare(Money.fromPaise(7))).toBe(0);
    // A total order is what a sort needs, and it must be consistent.
    const ordering: Ordering = Money.fromPaise(1).compare(Money.fromPaise(2));
    expect(ordering).toBe(-1);
    const sorted = [...amounts].sort((left, right) => left.compare(right));
    expect(sorted.map((entry) => entry.paise)).toEqual([
      -100n,
      -1n,
      0n,
      1n,
      100n,
      10_000n,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allocation
// ─────────────────────────────────────────────────────────────────────────────

describe("Money allocation", () => {
  it("splits equally and places the residual on the largest remainder, deterministically", () => {
    const parts = expectMoney(Money.fromRupees("100")).allocateByWeights([
      weight(1),
      weight(1),
      weight(1),
    ]);
    // Every paisa accounted for, exactly — no epsilon comparison anywhere:
    // 3334 + 3333 + 3333 = 10000, and the residual lands on the first.
    expect(parts.map((part) => part.paise)).toEqual([3334n, 3333n, 3333n]);
  });

  it("splits ₹12,000 across 96 flats into exactly ₹125.00 each", () => {
    const flats = Array.from({ length: 96 }, () => weight(1));
    const parts = expectMoney(Money.fromRupees("12000")).allocateByWeights(
      flats,
    );
    expect(parts).toHaveLength(96);
    expect(parts.every((part) => part.paise === 12_500n)).toBe(true);
  });

  it("respects unequal weights", () => {
    const parts = Money.fromPaise(100).allocateByWeights([
      weight(2),
      weight(1),
    ]);
    expect(parts.map((part) => part.paise)).toEqual([67n, 33n]);
  });

  it("gives nothing to a zero weight", () => {
    const parts = Money.fromPaise(100).allocateByWeights([
      weight(0),
      weight(1),
    ]);
    expect(parts.map((part) => part.paise)).toEqual([0n, 100n]);
  });

  it("allocates the smallest amounts, where the residual dominates", () => {
    expect(
      Money.fromPaise(1)
        .allocateByWeights([weight(1), weight(1), weight(1)])
        .map((part) => part.paise),
    ).toEqual([1n, 0n, 0n]);
    expect(
      Money.fromPaise(2)
        .allocateByWeights([weight(1), weight(1), weight(1)])
        .map((part) => part.paise),
    ).toEqual([1n, 1n, 0n]);
  });

  it("handles a single participant and a zero total", () => {
    expect(
      Money.fromPaise(100)
        .allocateByWeights([weight(5)])
        .map((part) => part.paise),
    ).toEqual([100n]);
    expect(
      Money.zero()
        .allocateByWeights([weight(1), weight(2)])
        .map((part) => part.paise),
    ).toEqual([0n, 0n]);
  });

  it("negates the allocation of a negative total, so refunds also conserve", () => {
    const parts = Money.fromPaise(-100).allocateByWeights([
      weight(1),
      weight(1),
      weight(1),
    ]);
    expect(parts.map((part) => part.paise)).toEqual([-34n, -33n, -33n]);
  });

  it("refuses a weight set it cannot divide by", () => {
    expect(() => Money.fromPaise(100).allocateByWeights([])).toThrow(
      MoneyError,
    );
    expect(() => Money.fromPaise(100).allocateByWeights([])).toThrow(
      /at least one weight/i,
    );
    expect(() =>
      Money.fromPaise(100).allocateByWeights([weight(0), weight(0)]),
    ).toThrow(/non-zero weight/i);
    // The brand is compile-time only, so the runtime guard is what actually
    // holds if a caller has cast its way past `weight()`.
    expect(() =>
      Money.fromPaise(100).allocateByWeights([-1n as Weight]),
    ).toThrow(MoneyError);
    expect(() =>
      Money.fromPaise(100).allocateByWeights([-5 as unknown as Weight]),
    ).toThrow(MoneyError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Properties
// ─────────────────────────────────────────────────────────────────────────────

describe("Money algebra (property tests)", () => {
  /**
   * The invariant the ledger rests on. 10,000 random amounts and weight sets,
   * deterministically generated so a failure is reproducible from its seed
   * rather than "somewhere in the run".
   *
   * A constraint is imposed rather than asserted: weights are whole and
   * non-negative and never all zero, because those are the *preconditions* of an
   * allocation — an input outside them is a rejected call, not a broken law.
   */
  it("always allocates exactly to the total: Σ parts === total", () => {
    const random = makeRandom(0xc0ffee);
    let failure: string | null = null;

    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const total = randomMoney(random);
      const weights = randomWeights(random);
      const parts = total.allocateByWeights(weights);
      const sum = parts.reduce(
        (accumulated, part) => accumulated.add(part),
        Money.zero(),
      );

      if (parts.length !== weights.length || !sum.equals(total)) {
        failure = `${total.paise} over [${weights.join(", ")}] gave ${sum.paise}`;
        break;
      }
      // A non-negative total must decompose into non-negative parts (a part may
      // legitimately be zero, so only the sign is checked).
      if (!total.isNegative() && parts.some((part) => part.isNegative())) {
        failure = `positive ${total.paise} produced a negative part`;
        break;
      }
    }

    expect(failure).toBeNull();
  });

  it("satisfies the identities of exact integer arithmetic", () => {
    const random = makeRandom(42);
    const zero = Money.zero();
    let failure: string | null = null;

    for (
      let iteration = 0;
      iteration < 1_000 && failure === null;
      iteration += 1
    ) {
      const a = randomMoney(random);
      const b = randomMoney(random);
      const c = randomMoney(random);

      const laws: readonly (readonly [string, boolean])[] = [
        ["a + 0 = a", a.add(zero).equals(a)],
        ["a - 0 = a", a.subtract(zero).equals(a)],
        ["a + b = b + a", a.add(b).equals(b.add(a))],
        [
          "(a + b) + c = a + (b + c)",
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c))),
        ],
        ["a - a = 0", a.subtract(a).isZero()],
        ["a + (-a) = 0", a.add(a.negate()).isZero()],
        ["a + b - b = a", a.add(b).subtract(b).equals(a)],
        ["fromPaise(a.paise) = a", Money.fromPaise(a.paise).equals(a)],
        ["a × 1 = a", a.multiplyByWeight(weight(1)).equals(a)],
        ["compare is antisymmetric", a.compare(b) === -b.compare(a)],
        ["equals agrees with compare", a.equals(b) === (a.compare(b) === 0)],
        ["|a| is never negative", !a.abs().isNegative()],
      ];

      for (const [name, held] of laws) {
        if (!held) {
          failure = `${name} failed for a=${a.paise} b=${b.paise} c=${c.paise}`;
          break;
        }
      }
    }

    expect(failure).toBeNull();
  });

  it("round-trips through serialisation and its decimal form", () => {
    const random = makeRandom(7);
    let failure: string | null = null;

    for (
      let iteration = 0;
      iteration < 1_000 && failure === null;
      iteration += 1
    ) {
      const original = randomMoney(random, 1_000_000_000_000);

      const fromPaise = Money.fromPaise(original.paise);
      const fromWire = Money.fromPaise(paiseToWire(original.paise));
      const fromText = Money.fromRupees(original.toRupeesString());

      if (!fromPaise.equals(original) || !fromWire.equals(original)) {
        failure = `paise/wire round trip lost ${original.paise}`;
      } else if (!fromText.ok || !fromText.value.equals(original)) {
        failure = `text round trip lost ${original.paise} ("${original.toRupeesString()}")`;
      }
    }

    expect(failure).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

describe("MoneyError", () => {
  it("publishes its codes and its neutral values as part of the contract", () => {
    // The catalogue is the API's mapping key; the weight is the additive
    // identity a split engine reads. Both are asserted so they cannot be
    // renamed or reordered unnoticed.
    expect(MONEY_ERROR_CODES).toEqual(["validation", "invariant"]);
    expect(ZERO_WEIGHT).toBe(0n);
    expect(weight(0)).toBe(ZERO_WEIGHT);
  });

  it("is the domain error type for money, with a stable code", () => {
    const built = moneyError("invariant", "no exchange rate", { left: "INR" });
    expect(built).toBeInstanceOf(MoneyError);
    expect(built).toBeInstanceOf(Error);
    expect(built.name).toBe("MoneyError");
    expect(built.code).toBe("invariant");
    expect(built.details).toEqual({ left: "INR" });
    expect(isMoneyError(built)).toBe(true);
    expect(isMoneyError(new Error("nope"))).toBe(false);
    expect(isMoneyError("nope")).toBe(false);
  });

  it("is what a parse failure returns rather than a thrown surprise", () => {
    const result = Money.fromRupees("nonsense");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(isMoneyError(result.error)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative space: no floating point
// ─────────────────────────────────────────────────────────────────────────────

describe("no floating-point arithmetic", () => {
  /**
   * The acceptance criterion this file exists for, checked against the shipped
   * code rather than the file's text.
   *
   * Why inspect function sources and not the file: the file's own documentation
   * has to *name* `parseFloat` and `Number` in order to explain why they are not
   * used, so a grep over the text would fail on the explanation. `toString()`
   * returns the executable source of a method without its JSDoc, which is exactly
   * the surface a regression would appear on.
   */
  const FLOAT_CALL = /\b(?:parseFloat|parseInt|Number)\s*\(/;

  function memberSources(): readonly string[] {
    const statics = Object.getOwnPropertyNames(Money)
      .filter((name) => !["length", "name", "prototype"].includes(name))
      .map((name) => (Money as unknown as Record<string, unknown>)[name]);
    const methods = Object.getOwnPropertyNames(Money.prototype)
      .filter((name) => name !== "constructor")
      .map(
        (name) => (Money.prototype as unknown as Record<string, unknown>)[name],
      );
    return [...statics, ...methods]
      .filter(
        (member): member is (...args: never[]) => unknown =>
          typeof member === "function",
      )
      .map((member) => member.toString());
  }

  it("covers every Money static and method, so it cannot pass vacuously", () => {
    expect(memberSources().length).toBeGreaterThanOrEqual(15);
  });

  it("never calls parseFloat, parseInt or Number in any Money member", () => {
    const offenders = memberSources().filter((source) =>
      FLOAT_CALL.test(source),
    );
    expect(offenders).toEqual([]);
  });

  it("proves the parser is exact where a float would not be", () => {
    // `0.29 * 100` is 28.999999999999996 and `Math.round` would be required to
    // hide it; reading the digits gives 29 with no rounding at all.
    expect(expectMoney(Money.fromRupees("0.29")).paise).toBe(29n);
    expect(Money.fromRupees("1.005").ok).toBe(false);
    // A whole-rupee amount beyond float-integer precision still parses exactly.
    expect(expectMoney(Money.fromRupees("90071992547409.91")).paise).toBe(
      9_007_199_254_740_991n,
    );
    expect(Money.fromPaise(1).add(Money.fromPaise(2)).paise).toBe(3n);
  });
});
