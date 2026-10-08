import {
  GSTIN_LENGTH,
  GSTIN_STATE_CODES,
  gstinCheckCharacter,
  isGstinError,
  isValidGstin,
  normalizeGstin,
  parseGstin,
} from "../gstin.vo";

/**
 * The GSTIN value object — Roadmap T072, PRD §3.5.3 / §13.1.
 *
 * The rules are tested where they live, with no route and no database, because the
 * checksum is what actually catches a transcription typo: a shape-only regex would
 * pass every case below whose *fields* are well-formed but whose *digit* is wrong.
 */

// Checked against the mod-36 algorithm: these are the values the arithmetic
// produces for their first fourteen characters.
const VALID_GSTIN = "27AAPFU0939F1ZV";
const VALID_GSTIN_TWO = "29ABCDE1234F1ZW";

describe("GSTIN structure", () => {
  it("accepts the reference values the checksum produces", () => {
    for (const value of [VALID_GSTIN, VALID_GSTIN_TWO]) {
      const parsed = parseGstin(value);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(value);
      expect(isValidGstin(value)).toBe(true);
    }
  });

  it("normalises only whitespace and case", () => {
    expect(normalizeGstin("  27aapfu0939f1zv  ")).toBe(VALID_GSTIN);
    const parsed = parseGstin("27aapfu0939f1zv");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(VALID_GSTIN);
  });

  it("computes the documented check character", () => {
    expect(gstinCheckCharacter("27AAPFU0939F1Z")).toBe("V");
    expect(gstinCheckCharacter("29ABCDE1234F1Z")).toBe("W");
  });

  it("refuses a corrupted check digit with a checksum-specific refusal", () => {
    // Every field is well-formed; only the last character is wrong — the exact
    // transcription error a shape-only validator cannot see.
    for (const candidate of [
      "27AAPFU0939F1ZX",
      "27AAPFU0939F1Z0",
      "27AAPFU0939F1Z1",
    ]) {
      const parsed = parseGstin(candidate);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(isGstinError(parsed.error)).toBe(true);
        expect(parsed.error.code).toBe("validation");
        expect(parsed.error.details?.["field"]).toBe("gstin");
        expect(String(parsed.error.message)).toContain("check digit");
      }
      expect(isValidGstin(candidate)).toBe(false);
    }
  });

  it("refuses structurally malformed values by length and shape", () => {
    const cases: readonly string[] = [
      "27AAPFU0939F1Z", // 14 characters
      `${VALID_GSTIN}0`, // 16 characters
      "39AAPFU0939F1ZV", // 39 is not a state code
      "271AAPFU09391ZV", // the PAN's first character is a digit
      "27AAPFU0939F1YV", // the fourteenth character is not 'Z'
    ];

    for (const value of cases) {
      const parsed = parseGstin(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("validation");
      expect(isValidGstin(value)).toBe(false);
    }

    expect(GSTIN_LENGTH).toBe(15);
  });

  it("refuses empty, non-string and punctuation-only input", () => {
    for (const bad of ["", "   ", null, undefined, 42, {}, "!!!", "  -  "]) {
      expect(isValidGstin(bad)).toBe(false);
    }
    const empty = parseGstin("   ");
    expect(empty.ok).toBe(false);
  });

  it("rejects the PRD's illustrative sample, which is not checksum-valid", () => {
    // `27AABCK1234M1Z5` appears in the PRD's request/response examples. It is
    // illustrative prose, not a real invoice: its check digit does not match its
    // own first fourteen characters. Recorded here so the rejection is a
    // deliberate, tested fact rather than a surprise in review.
    expect(isValidGstin("27AABCK1234M1Z5")).toBe(false);
  });

  it("knows the closed set of state codes", () => {
    expect(GSTIN_STATE_CODES.has("27")).toBe(true);
    expect(GSTIN_STATE_CODES.has("97")).toBe(true);
    expect(GSTIN_STATE_CODES.has("99")).toBe(true);
    expect(GSTIN_STATE_CODES.has("00")).toBe(false);
    expect(GSTIN_STATE_CODES.has("40")).toBe(false);
  });
});
