import { paise } from "../../shared/money";
import {
  gstTaxTotal,
  reconcileGstTaxTotal,
  type ExpenseGstDetailsRecord,
} from "../gst-details";

/**
 * PRD §3.5.3's tax-total rule — Roadmap T072, decision D7.
 *
 * `taxable_value + taxes` must equal `amount`, and the rule **warns rather than
 * blocks** because real invoices carry rounding. These cases pin both directions:
 * an exact match and a documented rounding difference must not be confused, and
 * the arithmetic must be exact bigint paise with no float anywhere.
 */

function details(
  components: Partial<{
    taxableValuePaise: bigint;
    cgstPaise: bigint;
    sgstPaise: bigint;
    igstPaise: bigint;
    cessPaise: bigint;
  }>,
): Pick<
  ExpenseGstDetailsRecord,
  "taxableValuePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "cessPaise"
> {
  return {
    taxableValuePaise: paise(components.taxableValuePaise ?? 0n),
    cgstPaise: paise(components.cgstPaise ?? 0n),
    sgstPaise: paise(components.sgstPaise ?? 0n),
    igstPaise: paise(components.igstPaise ?? 0n),
    cessPaise: paise(components.cessPaise ?? 0n),
  };
}

describe("GST tax-total reconciliation (PRD §3.5.3)", () => {
  it("sums the four tax components exactly", () => {
    expect(
      gstTaxTotal(details({ cgstPaise: 343220n, sgstPaise: 343221n })),
    ).toBe(686441n);
  });

  it("emits no warning when taxable + taxes equals the amount", () => {
    // The PRD's own worked example: 3813559 + 343220 + 343221 = 4500000.
    const reconciled = reconcileGstTaxTotal(
      details({
        taxableValuePaise: 3813559n,
        cgstPaise: 343220n,
        sgstPaise: 343221n,
      }),
      paise(4500000n),
    );
    expect(reconciled).toEqual([]);
  });

  it("warns, and does not block, on a documented rounding difference", () => {
    const warnings = reconcileGstTaxTotal(
      details({ taxableValuePaise: 100000n, igstPaise: 18000n }),
      paise(118001n),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "TAX_TOTAL_MISMATCH",
      taxableValuePaise: 100000n,
      taxesPaise: 18000n,
      amountPaise: 118001n,
      differencePaise: 1n,
    });
  });

  it("reports a negative difference when the components exceed the amount", () => {
    const warnings = reconcileGstTaxTotal(
      details({ taxableValuePaise: 100000n, cessPaise: 5000n }),
      paise(100000n),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.differencePaise).toBe(-5000n);
  });

  it("does not warn when no tax information is recorded at all", () => {
    // A GSTIN on file with no amounts is the "not yet filled in" state the table's
    // zero defaults produce; warning on it would fire on every such expense.
    expect(reconcileGstTaxTotal(details({}), paise(999999n))).toEqual([]);
  });

  it("carries every compared figure so a screen need not recompute", () => {
    const warnings = reconcileGstTaxTotal(
      details({
        taxableValuePaise: 1n,
        cgstPaise: 2n,
        sgstPaise: 3n,
        igstPaise: 4n,
        cessPaise: 5n,
      }),
      paise(100n),
    );
    expect(warnings[0]).toMatchObject({
      taxableValuePaise: 1n,
      taxesPaise: 14n,
      amountPaise: 100n,
      differencePaise: 85n,
    });
  });
});
