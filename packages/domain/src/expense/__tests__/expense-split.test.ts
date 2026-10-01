import { asApartmentId, asMemberId } from "../../shared/ids";
import { Money, weight } from "../../shared/money.vo";
import type { Weight } from "../../shared/money.vo";
import { expenseErrorCode } from "../errors";
import { ExpenseSplit } from "../expense-split.vo";
import type { ExpenseSplitAllocation } from "../expense-split.vo";

/**
 * `ExpenseSplit` — the value object `publish()` builds and sums (T061).
 *
 * The assertions are written against the rules the T060 migration also enforces
 * (`amount_paise >= 0`, a real participant label): a value the domain accepts must
 * be a value the database accepts, so a refusal here is the same refusal the row
 * would give, one layer earlier and with a field to render.
 */

const MEMBER = asMemberId("11111111-1111-4111-8111-111111111111");
const APARTMENT = asApartmentId("22222222-2222-4222-8222-222222222222");

function allocation(
  overrides: Partial<ExpenseSplitAllocation> = {},
): ExpenseSplitAllocation {
  return {
    memberId: MEMBER,
    apartmentId: APARTMENT,
    apartmentNumber: "A-101",
    amount: Money.fromPaise(25_000),
    weight: weight(1n),
    ...overrides,
  };
}

describe("ExpenseSplit.fromAllocation", () => {
  it("builds a frozen object holding the allocation's five facts", () => {
    const built = ExpenseSplit.fromAllocation(allocation());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.memberId).toBe(MEMBER);
    expect(built.value.apartmentId).toBe(APARTMENT);
    expect(built.value.apartmentNumber).toBe("A-101");
    expect(built.value.amount.paise).toBe(25_000n);
    expect(built.value.weight).toBe(1n);
    expect(Object.isFrozen(built.value)).toBe(true);
  });

  it("trims the flat label, which is the snapshot the bill keeps", () => {
    const built = ExpenseSplit.fromAllocation(
      allocation({ apartmentNumber: "  B-1204  " }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.value.apartmentNumber).toBe("B-1204");
  });

  it("refuses a negative amount — the zero exemption is legal, a debit is not", () => {
    const built = ExpenseSplit.fromAllocation(
      allocation({ amount: Money.fromPaise(-1) }),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.code).toBe("validation");
      expect(built.error.details?.field).toBe("splits");
      expect(built.error.details?.amountPaise).toBe("-1");
      expect(expenseErrorCode(built.error)).toBe("validation");
    }
  });

  it("allows exactly zero — SPLIT_ENGINE.md §5's deliberate exemption", () => {
    const built = ExpenseSplit.fromAllocation(
      allocation({ amount: Money.zero() }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.value.amount.isZero()).toBe(true);
  });

  it("refuses a flat label that is blank", () => {
    for (const apartmentNumber of ["", "   "]) {
      const built = ExpenseSplit.fromAllocation(
        allocation({ apartmentNumber }),
      );
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error.details?.field).toBe("splits");
    }
  });

  it("refuses a weight that was cast past its brand", () => {
    const built = ExpenseSplit.fromAllocation(
      allocation({ weight: -1n as unknown as Weight }),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe("validation");
  });

  it("compares by value across all five facts", () => {
    const base = ExpenseSplit.fromAllocation(allocation());
    const same = ExpenseSplit.fromAllocation(allocation());
    const otherAmount = ExpenseSplit.fromAllocation(
      allocation({ amount: Money.fromPaise(25_001) }),
    );
    const otherLabel = ExpenseSplit.fromAllocation(
      allocation({ apartmentNumber: "A-102" }),
    );

    expect(base.ok && same.ok).toBe(true);
    if (!base.ok || !same.ok || !otherAmount.ok || !otherLabel.ok) return;

    expect(base.value.equals(same.value)).toBe(true);
    expect(base.value.equals(otherAmount.value)).toBe(false);
    expect(base.value.equals(otherLabel.value)).toBe(false);
  });
});
