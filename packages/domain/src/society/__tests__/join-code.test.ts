import {
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  JOIN_CODE_PATTERN,
  JOIN_LINK_SCHEME,
  buildJoinDeepLink,
  buildJoinShareMessage,
  generateJoinCode,
  isValidJoinCode,
  normalizeJoinCode,
  parseJoinDeepLink,
} from "../join-code";

/**
 * The join code is the one value that leaves the app and comes back through a
 * human: read aloud, typed from a notice board, pasted from WhatsApp, or opened
 * as a deep link. These tests pin the behaviour of the tolerant input path
 * (normalisation) separately from the strict one (validation), because
 * conflating them is how a code like `GV4K2M` gets rejected for the crime of
 * being typed in lowercase.
 */
describe("join code alphabet", () => {
  it("contains 32 unambiguous uppercase characters", () => {
    expect(JOIN_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(JOIN_CODE_ALPHABET).size).toBe(32);
    expect(JOIN_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
  });

  it("excludes the characters that get misread aloud", () => {
    // PRD §3.2: codes are read over the phone and written on notice boards.
    for (const ambiguous of ["0", "O", "1", "I"]) {
      expect(JOIN_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it("pins the pattern to the alphabet and the declared length", () => {
    expect(JOIN_CODE_PATTERN.source).toBe(
      `^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`,
    );
  });
});

describe("generateJoinCode", () => {
  it("uses the injected random source", () => {
    // Deterministic: index 0 is always the first alphabet character.
    expect(generateJoinCode(() => 0)).toBe("AAAAAA");
    // Highest index is the last character of the alphabet.
    expect(generateJoinCode(() => 0.999999)).toBe("999999");
  });

  it("falls back to Math.random when no source is injected", () => {
    // The default is only used where a generator is genuinely unavailable; the
    // API injects a cryptographic source.
    expect(isValidJoinCode(generateJoinCode())).toBe(true);
  });

  it("always produces a code that validates, whatever the source returns", () => {
    const random = seededRandom(20260920);
    for (let index = 0; index < 500; index += 1) {
      const code = generateJoinCode(random);
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
      expect(isValidJoinCode(code)).toBe(true);
    }
  });

  it("stays inside the alphabet even at the boundary values of the range", () => {
    for (const value of [0, 1 / 32, 0.5, 31 / 32, 0.999999999]) {
      expect(isValidJoinCode(generateJoinCode(() => value))).toBe(true);
    }
  });
});

describe("normalizeJoinCode", () => {
  it("case-folds, trims and strips separators", () => {
    expect(normalizeJoinCode("  gv4k-2m ")).toBe("GV4K2M");
    expect(normalizeJoinCode("g v 4 k 2 m")).toBe("GV4K2M");
  });

  it("unwraps a deep link pasted as text", () => {
    expect(normalizeJoinCode("societyexpense://join?code=gv4k2m")).toBe(
      "GV4K2M",
    );
  });

  it("unwraps an https link with a code query parameter", () => {
    expect(
      normalizeJoinCode("https://app.example.com/join?code=GV4K2M&x=1"),
    ).toBe("GV4K2M");
  });

  it("is idempotent", () => {
    const once = normalizeJoinCode(" gv4k-2m ");
    expect(normalizeJoinCode(once)).toBe(once);
  });
});

describe("isValidJoinCode", () => {
  it("accepts a well-formed code in any casing or spacing", () => {
    expect(isValidJoinCode("GV4K2M")).toBe(true);
    expect(isValidJoinCode("gv4k2m")).toBe(true);
    expect(isValidJoinCode(" gv4k 2m ")).toBe(true);
  });

  it("rejects codes of the wrong length", () => {
    expect(isValidJoinCode("GV4K2")).toBe(false);
    expect(isValidJoinCode("GV4K2MX")).toBe(false);
    expect(isValidJoinCode("")).toBe(false);
  });

  it("rejects the ambiguous characters even when the length is right", () => {
    expect(isValidJoinCode("GVOK2M")).toBe(false);
    expect(isValidJoinCode("GV0K2M")).toBe(false);
    expect(isValidJoinCode("GV1K2M")).toBe(false);
    expect(isValidJoinCode("GVIK2M")).toBe(false);
  });
});

describe("deep links", () => {
  it("builds a normalised link", () => {
    expect(buildJoinDeepLink(" gv4k-2m ")).toBe(
      `${JOIN_LINK_SCHEME}?code=GV4K2M`,
    );
  });

  it("round-trips a code", () => {
    const code = generateJoinCode(seededRandom(7));
    expect(parseJoinDeepLink(buildJoinDeepLink(code))).toBe(code);
  });

  it("returns null for a URL that is not a join link", () => {
    expect(
      parseJoinDeepLink("societyexpense://auth/callback#access_token=x"),
    ).toBeNull();
    expect(
      parseJoinDeepLink("https://example.com/join?code=GV4K2M"),
    ).toBeNull();
  });

  it("returns null for a join link carrying nothing usable", () => {
    expect(parseJoinDeepLink(JOIN_LINK_SCHEME)).toBeNull();
    expect(parseJoinDeepLink(`${JOIN_LINK_SCHEME}?code=nope`)).toBeNull();
    expect(parseJoinDeepLink(`${JOIN_LINK_SCHEME}?code=GV0K2M`)).toBeNull();
  });
});

describe("buildJoinShareMessage", () => {
  it("carries the society name, the code and the link", () => {
    const message = buildJoinShareMessage("Green Valley Residency", " gv4k2m ");

    expect(message).toContain("Green Valley Residency");
    expect(message).toContain("GV4K2M");
    expect(message).toContain(`${JOIN_LINK_SCHEME}?code=GV4K2M`);
    // WhatsApp linkifies the raw scheme, so the link must not be wrapped in
    // its own punctuation.
    expect(message).not.toContain("GV4K2M.");
  });

  it("normalises the code it is given", () => {
    expect(buildJoinShareMessage("Society", "ab2cd3")).toContain(
      "ab2cd3".toUpperCase(),
    );
  });
});

/** Small LCG: a deterministic random source, so a failure is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
