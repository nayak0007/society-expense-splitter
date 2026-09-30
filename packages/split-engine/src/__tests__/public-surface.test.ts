import {
  APARTMENT_BASES,
  SPLIT_WARNING_CODES,
  computeSplit,
  type ApartmentBasis,
} from "../index";
import {
  LIFT_BANDS,
  apartmentFlat,
  customFlat,
  expectOk,
  flats,
  percentFlat,
  rupees,
  shareFlat,
  sumPaise,
} from "./fixtures";

/**
 * The package's public surface (Roadmap T058).
 *
 * Two of these tests pin lists that exist in a second place — the enum in
 * `supabase/migrations/20260920130000_society_core.sql` for the bases, and the PRD's
 * wire example for the warning codes — because a name that drifts there stops
 * dispatching at runtime rather than failing to compile. They are pinned here, on
 * the package's *public* surface, so the assertion is about what a client sees
 * rather than about an internal constant.
 *
 * The third is the other half of T058's result contract: `warnings` was added to
 * `SplitResult` in this task, and the four strategies that came before it must go
 * on answering with an empty list rather than with a shape that changed.
 */
describe("public surface", () => {
  it("declares exactly the six bases the database enum holds", () => {
    // `CREATE TYPE public.apartment_basis AS ENUM ('per_flat','per_sqft_carpet',
    // 'per_sqft_builtup','per_bhk','per_floor_band','per_parking_slot')` — in enum
    // order, because a stored `apartment_basis` has to name one of these.
    expect(APARTMENT_BASES).toEqual([
      "per_flat",
      "per_sqft_carpet",
      "per_sqft_builtup",
      "per_bhk",
      "per_floor_band",
      "per_parking_slot",
    ]);

    // The PRD's bullet list also names `occupied_only`, which is *not* in the enum:
    // "skip vacant flats" is a question about who participates, owned by T063's
    // participant resolver, not a way to weigh a flat that participates. Asserted
    // rather than only documented, so the six and its absence are pinned together.
    expect(APARTMENT_BASES).not.toContain("occupied_only");
    expect(new Set<ApartmentBasis>(APARTMENT_BASES).size).toBe(6);
  });

  it("declares the four warning codes, each about a fact a flat can be missing", () => {
    expect(SPLIT_WARNING_CODES).toEqual([
      "MISSING_AREA",
      "MISSING_BHK",
      "MISSING_FLOOR",
      "NO_FLOOR_BAND",
    ]);
  });

  it("dispatches every declared basis", () => {
    // A basis the enum has but the engine forgot would be a stored expense that
    // cannot be split at all, so each of the six is run through `computeSplit`.
    const participants = [apartmentFlat("101"), apartmentFlat("102")];

    for (const basis of APARTMENT_BASES) {
      const result = expectOk(
        computeSplit(
          basis === "per_floor_band"
            ? {
                strategy: "apartment",
                basis,
                amount: rupees("100"),
                participants,
                floorBands: LIFT_BANDS,
              }
            : {
                strategy: "apartment",
                basis,
                amount: rupees("100"),
                participants,
              },
        ),
      );

      expect(result.allocations).toHaveLength(2);
      expect(sumPaise(result.allocations)).toBe(10_000n);
    }
  });

  it("gives the four strategies that came before it an empty warning list", () => {
    // T058 added `warnings` to the one result shape every strategy returns. The
    // contract for the other four is "no warnings, ever": they read no apartment
    // fact, so there is nothing they could report.
    const inputs = [
      {
        strategy: "equal" as const,
        amount: rupees("100"),
        participants: flats(2),
      },
      {
        strategy: "percentage" as const,
        amount: rupees("100"),
        participants: [percentFlat("101", 5_000), percentFlat("102", 5_000)],
      },
      {
        strategy: "shares" as const,
        amount: rupees("100"),
        participants: [shareFlat("101", 1_000), shareFlat("102", 1_000)],
      },
      {
        strategy: "custom" as const,
        amount: rupees("100"),
        participants: [customFlat("101", "50"), customFlat("102", "50")],
      },
    ];

    for (const input of inputs) {
      const result = expectOk(computeSplit(input));

      expect(result.warnings).toEqual([]);
      // The shared, frozen empty list — not a fresh array per call, which is what
      // makes "no warnings" a fact about the package rather than about this result.
      expect(Object.isFrozen(result.warnings)).toBe(true);
      expect(sumPaise(result.allocations)).toBe(10_000n);
    }
  });
});
