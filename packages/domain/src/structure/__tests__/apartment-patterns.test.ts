import {
  GROUND_FLOOR_LABEL,
  MAX_PATTERN_APARTMENTS,
  generateApartmentNumbers,
} from "../apartment-patterns";

/** Shorthand: expand, or fail the test with the refusal's message. */
function generate(
  pattern: string,
  options: {
    readonly floors?: readonly number[];
    readonly unitsPerFloor?: number;
    readonly wings?: readonly {
      readonly id: string | null;
      readonly label: string;
    }[];
    readonly prefix?: string;
    readonly suffix?: string;
  } = {},
) {
  return generateApartmentNumbers({
    pattern,
    floors: options.floors ?? [],
    unitsPerFloor: options.unitsPerFloor ?? 1,
    wings: options.wings,
    prefix: options.prefix,
    suffix: options.suffix,
  });
}

/** The acceptance's 2 wings × 8 floors × 4 units shape. */
const TWO_WINGS = [
  { id: "11111111-1111-4111-8111-111111111111", label: "A" },
  { id: "22222222-2222-4222-8222-222222222222", label: "B" },
];

describe("generateApartmentNumbers — the roadmap's four forms", () => {
  it("expands {wing}-{floor}{unit:02d} into 64 correctly named flats", () => {
    const result = generate("{wing}-{floor}{unit:02d}", {
      floors: [1, 2, 3, 4, 5, 6, 7, 8],
      unitsPerFloor: 4,
      wings: TWO_WINGS,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows).toHaveLength(64);
    // Wing outermost, then floor, then unit: the first four are A-101…A-104.
    expect(rows.slice(0, 4).map((row) => row.apartmentNumber)).toEqual([
      "A-101",
      "A-102",
      "A-103",
      "A-104",
    ]);
    expect(rows[4]?.apartmentNumber).toBe("A-201");
    // Wing B starts after all of wing A's 32 flats.
    expect(rows[32]?.apartmentNumber).toBe("B-101");
    expect(rows[63]?.apartmentNumber).toBe("B-804");
    // Floors and wings are attached for the create call.
    expect(rows[0]?.floor).toBe(1);
    expect(rows[0]?.wingId).toBe(TWO_WINGS[0]?.id);
    expect(rows[32]?.wingId).toBe(TWO_WINGS[1]?.id);
  });

  it("expands {floor}{unit:02d} without a wing, attaching no wing", () => {
    const result = generate("{floor}{unit:02d}", {
      floors: [1, 2, 3],
      unitsPerFloor: 4,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows).toHaveLength(12);
    expect(rows[0]?.apartmentNumber).toBe("101");
    expect(rows[3]?.apartmentNumber).toBe("104");
    expect(rows[4]?.apartmentNumber).toBe("201");
    expect(rows.every((row) => row.wingId === null)).toBe(true);
  });

  it("expands {floor}{unit} unpadded, and sorts past 9 without renumbering", () => {
    const result = generate("{floor}{unit}", {
      floors: [1],
      unitsPerFloor: 11,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows[9]?.apartmentNumber).toBe("110");
    expect(rows[10]?.apartmentNumber).toBe("111");
  });

  it("renders prefix and suffix tokens", () => {
    const result = generate("{prefix}-{floor}{unit:02d}-{suffix}", {
      floors: [2],
      unitsPerFloor: 2,
      prefix: "BLK1",
      suffix: "L",
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows.map((row) => row.apartmentNumber)).toEqual([
      "BLK1-201-L",
      "BLK1-202-L",
    ]);
  });
});

describe("generateApartmentNumbers — the ground floor and padding", () => {
  it("labels floor 0 as G under the bare {floor} token", () => {
    const result = generate("{floor}{unit:02d}", {
      floors: [0, 1],
      unitsPerFloor: 2,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows.map((row) => row.apartmentNumber)).toEqual([
      `${GROUND_FLOOR_LABEL}01`,
      `${GROUND_FLOOR_LABEL}02`,
      "101",
      "102",
    ]);
    // The attachment keeps the real floor number: the label is a display
    // convention, the data is a floor.
    expect(rows[0]?.floor).toBe(0);
  });

  it("pads floor 0 as 00 under {floor:02d} — padding is a sorting convention", () => {
    const result = generate("{floor:02d}{unit:02d}", {
      floors: [0, 1, 10],
      unitsPerFloor: 1,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows.map((row) => row.apartmentNumber)).toEqual([
      "0001",
      "0101",
      "1001",
    ]);
  });

  it("pads units past the width's capacity without breaking", () => {
    const result = generate("{unit:02d}", {
      floors: [1],
      unitsPerFloor: 12,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows[11]?.apartmentNumber).toBe("12");
  });
});

describe("generateApartmentNumbers — refusals", () => {
  it("refuses a pattern without {unit}", () => {
    const result = generate("{wing}-{floor:02d}", {
      floors: [1],
      unitsPerFloor: 2,
      wings: TWO_WINGS,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.field).toBe("pattern");
      expect(result.error.message).toContain("{unit}");
    }
  });

  it("refuses a repeated token", () => {
    const result = generate("{unit}{unit}", { floors: [1], unitsPerFloor: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("pattern");
  });

  it("refuses an unknown token instead of shipping it literally", () => {
    const result = generate("{unit}-{storey}", {
      floors: [1],
      unitsPerFloor: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("{storey}");
  });

  it("refuses an unbalanced brace", () => {
    const result = generate("{unit", { floors: [1], unitsPerFloor: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("pattern");
  });

  it("refuses a malformed pad width", () => {
    for (const pattern of [
      "{unit:2d}",
      "{unit:09d}",
      "{unit:0d}",
      "{unit:0ed}",
    ]) {
      const result = generate(pattern, { floors: [1], unitsPerFloor: 1 });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a prefix option with no {prefix} token", () => {
    const result = generate("{unit}", {
      floors: [1],
      unitsPerFloor: 1,
      prefix: "X",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("prefix");
  });

  it("refuses {floor} with no floors and multiple floors with no {floor}", () => {
    expect(generate("{floor}{unit}", { unitsPerFloor: 1 }).ok).toBe(false);
    expect(generate("{unit}", { floors: [1, 2], unitsPerFloor: 1 }).ok).toBe(
      false,
    );
    expect(generate("{floor}{unit}", { floors: [], unitsPerFloor: 1 }).ok).toBe(
      false,
    );
  });

  it("refuses duplicate floors and out-of-range floors", () => {
    expect(
      generate("{floor}{unit}", { floors: [1, 1], unitsPerFloor: 1 }).ok,
    ).toBe(false);
    expect(
      generate("{floor}{unit}", { floors: [999], unitsPerFloor: 1 }).ok,
    ).toBe(false);
  });

  it("refuses {wing} with no wings or an empty wing label", () => {
    expect(generate("{wing}{unit}", { floors: [1], unitsPerFloor: 1 }).ok).toBe(
      false,
    );
    expect(
      generate("{wing}{unit}", {
        floors: [1],
        unitsPerFloor: 1,
        wings: [{ id: null, label: "  " }],
      }).ok,
    ).toBe(false);
  });

  it("refuses a generated label longer than the apartment-number bound", () => {
    const longPrefix = "P".repeat(22);
    const result = generate("{prefix}-{unit:02d}", {
      floors: [1],
      unitsPerFloor: 1,
      prefix: longPrefix,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("characters");
  });

  it("refuses non-integer or out-of-range units per floor", () => {
    expect(generate("{unit}", { floors: [1], unitsPerFloor: 0 }).ok).toBe(
      false,
    );
    expect(generate("{unit}", { floors: [1], unitsPerFloor: 2.5 }).ok).toBe(
      false,
    );
    expect(generate("{unit}", { floors: [1], unitsPerFloor: 201 }).ok).toBe(
      false,
    );
  });
});

describe("generateApartmentNumbers — the cap", () => {
  it("accepts exactly 2,000 flats", () => {
    // 2 wings × 250 floors is beyond FLOOR_MAX, so: 10 wings × 10 floors × 20.
    const wings = Array.from({ length: 10 }, (_, index) => ({
      id: null,
      label: `W${index}`,
    }));
    const result = generate("{wing}{floor:02d}{unit:02d}", {
      floors: Array.from({ length: 10 }, (_, index) => index + 1),
      unitsPerFloor: 20,
      wings,
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    expect(rows).toHaveLength(MAX_PATTERN_APARTMENTS);
  });

  it("refuses the first flat over the cap — before generating any label", () => {
    const wings = Array.from({ length: 11 }, (_, index) => ({
      id: null,
      label: `W${index}`,
    }));
    const result = generate("{wing}{floor:02d}{unit:02d}", {
      floors: Array.from({ length: 10 }, (_, index) => index + 1),
      unitsPerFloor: 20,
      wings,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("2,200");
      expect(result.error.message).toContain("2,000");
    }
  });
});

describe("generateApartmentNumbers — normalisation", () => {
  it("trims the whitespace a label picks up around tokens", () => {
    const result = generate("{wing} {unit}", {
      floors: [1],
      unitsPerFloor: 1,
      wings: [{ id: null, label: " A " }],
    });

    expect(result.ok).toBe(true);
    const rows = result.ok ? result.value : [];
    // `createApartmentNumber` collapses whitespace; the label is stored clean.
    expect(rows[0]?.apartmentNumber).toBe("A 1");
  });
});
