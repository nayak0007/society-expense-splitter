import {
  CONTENT_FAMILIES,
  MIME_FAMILIES,
  SIGNATURE_PREFIX_BYTES,
  detectContentFamily,
  verifyContentMatchesMimeType,
} from "../magic-bytes";

/**
 * The magic-number check with **real byte signatures** — Roadmap T071, ADR-0012.
 *
 * The Roadmap's own test list is the spec here: "A `.jpg` with PDF magic bytes
 * rejected". That is the spoofing case the check exists for, and a test that used a
 * made-up header would pass while the real one failed — so every fixture below is
 * the first bytes of the actual format, written out rather than imported.
 */

/** `%PDF-1.7` — the PDF header, which is the whole signature. */
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3,
]);

/** SOI + APP0 (`JFIF`) — a JPEG as a camera writes it. */
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

/** `\x89PNG\r\n\x1a\n` + the IHDR length — a PNG. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** A HEIC still image: `[size:4][ftyp][heic]`. */
const HEIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

/** A HEIF-branded still image (`mif1`), which a third-party encoder writes. */
const HEIF_MIF1 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31,
]);

/** An MP4 video: the same `ftyp` box with an `isom` brand — not a still image. */
const MP4_ISOM = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

/**
 * An SVG — text, so no signature at all.
 *
 * Encoded byte by byte rather than with `TextEncoder`: this package is pure domain
 * and compiles with neither the DOM lib nor Node's globals, and `TextEncoder` lives
 * in both of those and in neither of the language's own libs. The bytes are what the
 * sniffer sees either way, and every character here is ASCII.
 */
const SVG = Uint8Array.from(
  [...`<svg xmlns="http://www.w3.org/2000/svg">`].map((character) =>
    character.charCodeAt(0),
  ),
);

describe("detectContentFamily", () => {
  it("recognises the four accepted formats from their real signatures", () => {
    expect(detectContentFamily(JPEG)).toBe("jpeg");
    expect(detectContentFamily(PNG)).toBe("png");
    expect(detectContentFamily(PDF)).toBe("pdf");
    expect(detectContentFamily(HEIC)).toBe("heic");
    expect(detectContentFamily(HEIF_MIF1)).toBe("heic");
  });

  it("does not confuse a video container for a still image", () => {
    // The `ftyp` box alone is not enough: an `.heic` whose bytes are a video is
    // exactly the mismatch this check exists to find.
    expect(detectContentFamily(MP4_ISOM)).toBeNull();
  });

  it("answers null for anything unrecognised", () => {
    expect(detectContentFamily(SVG)).toBeNull();
    expect(detectContentFamily(new Uint8Array([]))).toBeNull();
    expect(detectContentFamily(new Uint8Array([0x00]))).toBeNull();
    // A truncated JPEG header is a refusal rather than a guess.
    expect(detectContentFamily(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("never reads past the end of a short buffer", () => {
    // A one-byte object must not throw, and a `ftyp` box without a brand must not
    // resolve to a family by accident.
    expect(() => detectContentFamily(new Uint8Array([0x66]))).not.toThrow();
    expect(
      detectContentFamily(
        new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
      ),
    ).toBeNull();
  });

  it("needs no more than the documented prefix", () => {
    // If this ever fails, the completion path's bounded read is too small.
    expect(SIGNATURE_PREFIX_BYTES).toBe(12);
    for (const bytes of [JPEG, PNG, PDF, HEIC]) {
      expect(
        detectContentFamily(bytes.slice(0, SIGNATURE_PREFIX_BYTES)),
      ).not.toBeNull();
    }
  });
});

describe("verifyContentMatchesMimeType", () => {
  it("accepts a declaration that agrees with the bytes", () => {
    for (const [mime, bytes] of [
      ["image/jpeg", JPEG],
      ["image/png", PNG],
      ["application/pdf", PDF],
      ["image/heic", HEIC],
    ] as const) {
      expect(verifyContentMatchesMimeType(bytes, mime).ok).toBe(true);
    }
  });

  it("refuses a .jpg whose bytes are a PDF — the Roadmap's own test", () => {
    const verdict = verifyContentMatchesMimeType(PDF, "image/jpeg");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe("content_mismatch");
      expect(verdict.error.details).toMatchObject({
        expectedFamily: "jpeg",
        detectedFamily: "pdf",
      });
    }
  });

  it("refuses the reverse: a declared PDF whose bytes are a JPEG", () => {
    const verdict = verifyContentMatchesMimeType(JPEG, "application/pdf");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe("content_mismatch");
  });

  it("refuses an unrecognised type and an unrecognised object alike", () => {
    // A type outside the closed map is a validation refusal naming the field...
    const unknownType = verifyContentMatchesMimeType(JPEG, "image/gif");
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) {
      expect(unknownType.error.code).toBe("validation");
      expect(unknownType.error.details?.["field"]).toBe("mimeType");
    }

    // ...and an object that is none of the four is a content mismatch with a
    // `detectedFamily` of null, which is the difference between "we do not accept
    // that type" and "that object is not any of them".
    const unknownObject = verifyContentMatchesMimeType(SVG, "image/jpeg");
    expect(unknownObject.ok).toBe(false);
    if (!unknownObject.ok) {
      expect(unknownObject.error.code).toBe("content_mismatch");
      expect(unknownObject.error.details?.["detectedFamily"]).toBeNull();
    }
  });

  it("covers every family the vocabulary claims", () => {
    // If a fifth family is added without a MIME mapping, nothing can ever be
    // declared as it — so the two tables must agree.
    expect([...new Set(Object.values(MIME_FAMILIES))].sort()).toEqual(
      [...CONTENT_FAMILIES].sort(),
    );
  });
});
