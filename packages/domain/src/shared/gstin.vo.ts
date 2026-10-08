import { DomainError, type DomainErrorInit } from "./errors";
import { err, ok, type Result } from "./result";

/**
 * `Gstin` — a GST Identification Number, validated structurally **and** by its
 * check digit (PRD §3.5.3 / §13.1, Roadmap T072).
 *
 * ## Why a checksum and not a 15-character regex
 *
 * A GSTIN is fifteen characters laid out as five fields:
 *
 * ```text
 *   2  7  A A P F U  0 9 3 9 F  1  Z  V
 *   └┬─┘  └────┬────┘  └┬┘ │  │  └┬┘
 *    │         │        │  │  │   └─ check digit (mod 36)  position 15
 *    │         │        │  │  └───── default char, always 'Z'  position 14
 *    │         │        │  └──────── entity number (1–9, A–Z) position 13
 *    │         │        └─────────── PAN: AAAAA9999A         positions 3–12
 *    │         └──────────────────── (the PAN's own shape)
 *    └────────────────────────────── state code (01–38, 97, 99) positions 1–2
 * ```
 *
 * A regex can only check those shapes. The PRD asks for **checksum** validation
 * ("an invalid GSTIN is rejected client-side", task 29), because a transcription
 * typo — a swapped digit, a mistyped letter — keeps every field's shape and is
 * exactly the error a human makes reading an invoice. The check digit is the only
 * thing that catches it, and it is pure arithmetic (no external service is called;
 * the product "records; it does not file or advise").
 *
 * ## The algorithm, and why it is written by hand
 *
 * The GSTIN check digit is a mod-36 variant of Luhn over the alphabet
 * `0-9A-Z`, computed over the first fourteen characters with alternating weights
 * 1 and 2:
 *
 * ```text
 *   sum += (value × weight) ÷ 36 + (value × weight) mod 36
 *   check = (36 − (sum mod 36)) mod 36
 * ```
 *
 * It is implemented directly rather than pulled from a package: it is twenty
 * lines, has no dependency, and a third-party checksum implementation is a supply
 * chain for a specification that does not change. `27AAPFU0939F1ZV` is a valid
 * reference value (checked in the unit test).
 *
 * ## Normalisation is `trim` + `upper`
 *
 * A GSTIN is case-insensitive and is frequently copied with surrounding spaces, so
 * those two transformations are legitimate. Nothing else is: no punctuation is
 * stripped, no visually similar characters are folded (`O`/`0`, `I`/`1`) — those
 * are real characters in a GSTIN's alphabet and "fixing" them would turn a wrong
 * value into a different wrong value.
 */

/** The only length a GSTIN has. */
export const GSTIN_LENGTH = 15;

/**
 * The state codes that exist — 01–38 for the States and Union Territories, plus
 * 97 (Other Territory) and 99 (Centre Jurisdiction). A code outside this set is a
 * malformed GSTIN rather than an unrecognised one: the range is closed and well
 * known, so 39 is a typo and not a future state.
 */
export const GSTIN_STATE_CODES: ReadonlySet<string> = new Set([
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "29",
  "30",
  "31",
  "32",
  "33",
  "34",
  "35",
  "36",
  "37",
  "38",
  "97",
  "99",
]);

/** The characters the check digit's arithmetic is defined over, in order. */
const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The PAN inside a GSTIN: five letters, four digits, one letter. */
const GSTIN_PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** The entity number: 1–9, or A–Z (no zero — the entity counts from one). */
const GSTIN_ENTITY_PATTERN = /^[1-9A-Z]$/;

export const GSTIN_ERROR_CODES = ["validation"] as const;
export type GstinErrorCode = (typeof GSTIN_ERROR_CODES)[number];

export class GstinError extends DomainError<GstinErrorCode> {
  constructor(
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<GstinErrorCode> = {
      code: "validation",
      message,
      details: { ...details, field: "gstin" },
    };
    super(init);
    this.name = "GstinError";
  }
}

export function isGstinError(error: unknown): error is GstinError {
  return error instanceof GstinError;
}

declare const gstinBrand: unique symbol;

/** A GSTIN known to be structurally sound and check-digit valid. */
export type Gstin = string & { readonly [gstinBrand]: "Gstin" };

/**
 * Trim and upper-case — the only normalisation that is safe for a GSTIN.
 *
 * Everything else about the string is left exactly as typed, so a value that is
 * wrong before normalisation is still wrong after it.
 */
export function normalizeGstin(input: string): string {
  return input.trim().toUpperCase();
}

/**
 * The check character for the first fourteen characters, computed mod 36.
 *
 * Exported so a test can assert the arithmetic directly and so a caller that has
 * already validated the structure can recompute without re-walking the fields.
 * The input **must** be fourteen characters from the GSTIN alphabet; anything
 * else is a programming error and throws rather than returning a meaningless
 * character.
 */
export function gstinCheckCharacter(firstFourteen: string): string {
  if (firstFourteen.length !== GSTIN_LENGTH - 1) {
    throw new GstinError(
      `A GSTIN check digit is computed from ${GSTIN_LENGTH - 1} characters, received ${firstFourteen.length}.`,
    );
  }

  let total = 0;
  for (let index = 0; index < firstFourteen.length; index += 1) {
    const value = GSTIN_ALPHABET.indexOf(firstFourteen.charAt(index));
    if (value < 0) {
      throw new GstinError(
        `"${firstFourteen}" contains a character outside the GSTIN alphabet.`,
      );
    }
    const weight = index % 2 === 0 ? 1 : 2;
    const product = value * weight;
    total += Math.floor(product / 36) + (product % 36);
  }

  const check = (36 - (total % 36)) % 36;
  return GSTIN_ALPHABET.charAt(check);
}

/**
 * The structural half, without the check digit.
 *
 * Split out because the two failures are different facts: "this is the wrong
 * shape" (a truncated paste, a missing letter) and "this has the right shape but
 * the check digit disagrees" (a transcription typo). The error copy names which,
 * so a form can tell a user to re-copy the field rather than re-read the invoice.
 */
function structureProblem(normalized: string): string | null {
  if (normalized.length !== GSTIN_LENGTH) {
    return `A GSTIN is exactly ${GSTIN_LENGTH} characters; this one has ${normalized.length}.`;
  }
  if (!/^[0-9A-Z]+$/.test(normalized)) {
    return "A GSTIN may contain only digits and capital letters.";
  }
  if (!GSTIN_STATE_CODES.has(normalized.slice(0, 2))) {
    return `"${normalized.slice(0, 2)}" is not a GST state code.`;
  }
  if (!GSTIN_PAN_PATTERN.test(normalized.slice(2, 12))) {
    return "The PAN inside a GSTIN is five letters, four digits and one letter.";
  }
  if (!GSTIN_ENTITY_PATTERN.test(normalized.charAt(12))) {
    return "A GSTIN's entity number is 1–9 or A–Z.";
  }
  if (normalized.charAt(13) !== "Z") {
    return "The fourteenth character of a GSTIN is always 'Z'.";
  }
  return null;
}

/** Is `input` a structurally sound, check-digit-valid GSTIN? */
export function isValidGstin(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const normalized = normalizeGstin(input);
  if (structureProblem(normalized) !== null) return false;
  return gstinCheckCharacter(normalized.slice(0, 14)) === normalized.charAt(14);
}

/**
 * Parse untrusted input into a `Gstin`, or explain why it is not one.
 *
 * Returns a `Result` rather than throwing, because this is the door user input
 * comes through (a form field, an OCR suggestion the user accepted) and "that is
 * not a GSTIN" is an expected outcome the caller must render. The value inside a
 * success is the **normalised** string, so the stored value is canonical.
 */
export function parseGstin(input: string): Result<Gstin, GstinError> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return err(new GstinError("Enter a GSTIN."));
  }

  const normalized = normalizeGstin(input);
  const problem = structureProblem(normalized);
  if (problem !== null) {
    return err(new GstinError(problem, { value: normalized }));
  }

  const expected = gstinCheckCharacter(normalized.slice(0, 14));
  if (expected !== normalized.charAt(14)) {
    return err(
      new GstinError(
        "That GSTIN's check digit does not match. Re-check the number on the invoice.",
        { value: normalized, expected },
      ),
    );
  }

  return ok(normalized as Gstin);
}

/**
 * Boundary helper — the only place a raw string becomes a branded `Gstin` without
 * re-running the rules.
 *
 * Used where the value has *already* been validated on the way in (a stored column
 * that was written through {@link parseGstin}, a contract that called
 * {@link isValidGstin}), so the full parse would be redundant work. A caller that
 * has not validated must call {@link parseGstin} instead.
 */
export function asGstin(value: string): Gstin {
  return value as Gstin;
}
