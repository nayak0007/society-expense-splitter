import { APARTMENT_NUMBER_MAX_LENGTH, FLOOR_MAX, FLOOR_MIN } from "./apartment";
import { createApartmentNumber } from "./apartment-value-objects";
import { err, ok, type Result } from "../shared/result";
import { structureError, type StructureError } from "./errors";

/**
 * The apartment pattern generator's grammar (Roadmap T044).
 *
 * A pattern is a *template for labels*, and every other decision — how many
 * flats, which floors, which wings — is data the caller supplies. That split is
 * what keeps this pure: `generateApartmentNumbers` is a total function from
 * `(pattern, dimensions)` to labelled rows, with no repository, no clock and no
 * framework, so the API's dry run and the future wizard's preview run the same
 * expansion and cannot disagree about what a pattern produces (SAD §7).
 *
 * ## The tokens, and exactly one of each
 *
 *   `{wing}`      — expands once per supplied wing (see `PatternWing`)
 *   `{floor}`     — expands once per supplied floor; **floor 0 renders as `G`**,
 *                   because a ground floor is labelled, not numbered, in the
 *                   conventions this product serves (the acceptance's "ground
 *                   floor labelled `G`")
 *   `{floor:0Nd}` — the same expansion, zero-padded to width N (`02` → `01`,
 *                   `02`, …; floor 0 is `00`, because a padded label is a
 *                   sorting convention, not a display one)
 *   `{unit}`      — required, exactly once: the per-floor counter, 1-based
 *   `{unit:0Nd}`  — the counter zero-padded to width N (`02d` → `01`…`04`)
 *   `{prefix}` / `{suffix}` — the caller's literal bookends, so a wizard can
 *                   offer separate input boxes; plain literal text in the
 *                   pattern works identically, and these exist for the UI that
 *                   wants the fields distinct
 *
 * `{unit}` is the one token a pattern **must** carry — a pattern without it
 * would name every flat the same thing, and a silently duplicated batch is the
 * failure the building's unique index exists to prevent. `{wing}`, `{floor}`,
 * `{prefix}` and `{suffix}` may each appear at most once: a repeated token has
 * no meaning that survives review, and refusing it beats guessing.
 *
 * ## The cap is checked before a single label is built
 *
 * `MAX_PATTERN_APARTMENTS` is the Roadmap's own 2,000 per call. The count is
 * the arithmetic of the dimensions, so it is checked first — a request for
 * 40,000 labels is refused in microseconds, not after generating them.
 */

/** The Roadmap's cap, verbatim: at most 2,000 generated flats per call. */
export const MAX_PATTERN_APARTMENTS = 2_000;

/** The widest zero-pad the grammar accepts — `{:04d}` names 9,999 units. */
export const PATTERN_PAD_MAX = 4;

/** The label a floor of `0` carries under the bare `{floor}` token. */
export const GROUND_FLOOR_LABEL = "G";

/** Upper bound on flats per floor — generous, but bounded. */
export const UNITS_PER_FLOOR_MAX = 200;

/** One wing a `{wing}` pattern expands across. */
export interface PatternWing {
  /**
   * The wing's row id, attached to every flat generated for it — `null` is
   * legitimate only because a wing-less building is legal and a caller may
   * still want its *label* in the number.
   */
  readonly id: string | null;
  /** The label the `{wing}` token renders. */
  readonly label: string;
}

/** What one generated flat will be, before storage is involved at all. */
export interface GeneratedApartment {
  /** The full label, prefix and suffix included — unique across the batch. */
  readonly apartmentNumber: string;
  /** The floor the flat sits on, `null` only when the pattern has no `{floor}`. */
  readonly floor: number | null;
  /** The wing the flat belongs to, `null` when the pattern has no `{wing}`. */
  readonly wingId: string | null;
}

/** The dimensions one expansion runs across. */
export interface ApartmentPatternRequest {
  readonly pattern: string;
  /** The floors to expand across, in the order they should number. */
  readonly floors: readonly number[];
  /** Flats per floor. */
  readonly unitsPerFloor: number;
  /** Required when the pattern carries `{wing}`; ignored otherwise. */
  readonly wings?: readonly PatternWing[] | undefined;
  /** Rendered where `{prefix}` sits in the pattern. */
  readonly prefix?: string | undefined;
  /** Rendered where `{suffix}` sits in the pattern. */
  readonly suffix?: string | undefined;
}

/** One parsed token: what it is, and how wide its zero-pad is, if any. */
interface PatternToken {
  readonly kind: "wing" | "floor" | "unit" | "prefix" | "suffix";
  readonly padWidth: number | null;
}

const TOKEN_PATTERN = /^\{(wing|floor|unit|prefix|suffix)(?::(0[1-9]d))?\}$/;

/**
 * Parses one `{…}` group. Anything the grammar does not name — including a
 * malformed pad such as `{unit:2d}` or `{unit:09d}` — is an error naming the
 * offending text, because a silently unexpanded `{…}` would ship literally
 * into `apartment_number`.
 */
function parseToken(raw: string): Result<PatternToken, StructureError> {
  const match = TOKEN_PATTERN.exec(raw);
  if (match === null) {
    return err(
      structureError(
        "validation",
        `Unknown pattern token ${raw}. Use {wing}, {floor}, {floor:0Nd}, {unit}, {unit:0Nd}, {prefix} or {suffix}.`,
        { field: "pattern" },
      ),
    );
  }
  const kind = match[1] as PatternToken["kind"];
  const pad = match[2];
  if (pad === undefined) {
    return ok({ kind, padWidth: null });
  }
  const padWidth = Number.parseInt(pad.slice(1, -1), 10);
  if (!Number.isInteger(padWidth) || padWidth > PATTERN_PAD_MAX) {
    return err(
      structureError(
        "validation",
        `Pad width in ${raw} must be between 1 and ${PATTERN_PAD_MAX}.`,
        { field: "pattern" },
      ),
    );
  }
  return ok({ kind, padWidth });
}

/** Zero-pads `value` to `width`, or renders it unpadded when `width` is null. */
function renderCount(value: number, padWidth: number | null): string {
  return padWidth === null
    ? String(value)
    : String(value).padStart(padWidth, "0");
}

/**
 * Expands a pattern into the flat labels and their floor/wing attachments.
 *
 * The result is in numbering order — wing outermost, then floor, then unit —
 * which is the order a caretaker reads a building top to bottom and the order
 * the rows are created in. Every label is validated through the *same* value
 * object the single-flat form uses (`createApartmentNumber`), so a pattern that
 * would produce a 30-character label fails here with `field: "pattern"` rather
 * than 2,000 rows failing at storage with `field: "apartmentNumber"`.
 */
export function generateApartmentNumbers(
  request: ApartmentPatternRequest,
): Result<readonly GeneratedApartment[], StructureError> {
  // ── tokenise: walk the pattern once, collecting each kind ─────────────────
  const tokens: PatternToken[] = [];
  const literalChunks: string[] = [];
  let cursor = 0;
  while (cursor < request.pattern.length) {
    const open = request.pattern.indexOf("{", cursor);
    if (open === -1) {
      literalChunks.push(request.pattern.slice(cursor));
      break;
    }
    const close = request.pattern.indexOf("}", open);
    if (close === -1) {
      return err(
        structureError(
          "validation",
          "The pattern has a `{` with no matching `}`.",
          {
            field: "pattern",
          },
        ),
      );
    }
    literalChunks.push(request.pattern.slice(cursor, open));
    const token = parseToken(request.pattern.slice(open, close + 1));
    if (!token.ok) return token;
    tokens.push(token.value);
    cursor = close + 1;
  }

  const count = (kind: PatternToken["kind"]): number =>
    tokens.filter((token) => token.kind === kind).length;

  if (count("unit") !== 1) {
    return err(
      structureError(
        "validation",
        "The pattern must contain {unit} exactly once — it is the counter that names each flat.",
        { field: "pattern" },
      ),
    );
  }
  for (const kind of ["wing", "floor", "prefix", "suffix"] as const) {
    if (count(kind) > 1) {
      return err(
        structureError(
          "validation",
          `The pattern contains {${kind}} more than once.`,
          {
            field: "pattern",
          },
        ),
      );
    }
  }

  const wingToken = tokens.find((token) => token.kind === "wing");
  const floorToken = tokens.find((token) => token.kind === "floor");
  const unitToken = tokens.find(
    (token): token is PatternToken => token.kind === "unit",
  );
  if (unitToken === undefined) {
    // Unreachable — `count("unit") !== 1` above — but required for narrowing.
    return err(
      structureError(
        "validation",
        "The pattern must contain {unit} exactly once.",
        { field: "pattern" },
      ),
    );
  }
  const prefixToken = tokens.find((token) => token.kind === "prefix");
  const suffixToken = tokens.find((token) => token.kind === "suffix");

  // ── prefix/suffix: an option without its token would be silently dropped ──
  if (request.prefix !== undefined && prefixToken === undefined) {
    return err(
      structureError(
        "validation",
        "A prefix was supplied but the pattern has no {prefix} token — add it or drop the prefix.",
        { field: "prefix" },
      ),
    );
  }
  if (request.suffix !== undefined && suffixToken === undefined) {
    return err(
      structureError(
        "validation",
        "A suffix was supplied but the pattern has no {suffix} token — add it or drop the suffix.",
        { field: "suffix" },
      ),
    );
  }

  // ── dimensions ─────────────────────────────────────────────────────────────
  if (!Number.isInteger(request.unitsPerFloor) || request.unitsPerFloor < 1) {
    return err(
      structureError("validation", "Units per floor must be at least 1.", {
        field: "unitsPerFloor",
      }),
    );
  }
  if (request.unitsPerFloor > UNITS_PER_FLOOR_MAX) {
    return err(
      structureError(
        "validation",
        `Units per floor must be at most ${UNITS_PER_FLOOR_MAX}.`,
        { field: "unitsPerFloor" },
      ),
    );
  }

  const floorValues: number[] = [];
  if (floorToken === undefined) {
    // No {floor}: multiple floors would produce identical labels, which the
    // unique index would refuse row by row. Saying so here names the real
    // problem instead of N storage conflicts.
    if (request.floors.length > 1) {
      return err(
        structureError(
          "validation",
          "Multiple floors were supplied but the pattern has no {floor} token — every label would be identical.",
          { field: "pattern" },
        ),
      );
    }
    floorValues.push(request.floors[0] ?? 0);
  } else {
    if (request.floors.length === 0) {
      return err(
        structureError(
          "validation",
          "The pattern has {floor} but no floors were supplied.",
          { field: "floors" },
        ),
      );
    }
    for (const floor of request.floors) {
      if (!Number.isInteger(floor) || floor < FLOOR_MIN || floor > FLOOR_MAX) {
        return err(
          structureError(
            "validation",
            `Floors must be whole numbers between ${FLOOR_MIN} and ${FLOOR_MAX}.`,
            { field: "floors" },
          ),
        );
      }
      floorValues.push(floor);
    }
    if (new Set(floorValues).size !== floorValues.length) {
      return err(
        structureError(
          "validation",
          "The floors list contains a duplicate — each floor may appear once.",
          { field: "floors" },
        ),
      );
    }
  }

  const wings: readonly PatternWing[] =
    wingToken === undefined ? [{ id: null, label: "" }] : (request.wings ?? []);
  if (wingToken !== undefined && wings.length === 0) {
    return err(
      structureError(
        "validation",
        "The pattern has {wing} but no wings were supplied.",
        { field: "wings" },
      ),
    );
  }
  if (wingToken !== undefined) {
    for (const wing of wings) {
      if (wing.label.trim().length === 0) {
        return err(
          structureError(
            "validation",
            "Every wing needs a non-empty label for {wing} to render.",
            { field: "wings" },
          ),
        );
      }
    }
  }

  // ── the cap, before any label is built ─────────────────────────────────────
  const total = floorValues.length * wings.length * request.unitsPerFloor;
  if (total > MAX_PATTERN_APARTMENTS) {
    return err(
      structureError(
        "validation",
        `This pattern would generate ${total.toLocaleString("en-IN")} flats; the cap is ${MAX_PATTERN_APARTMENTS.toLocaleString("en-IN")} per call.`,
        { field: "pattern" },
      ),
    );
  }

  // ── expand, wing → floor → unit ────────────────────────────────────────────
  const prefix = prefixToken === undefined ? "" : (request.prefix ?? "");
  const suffix = suffixToken === undefined ? "" : (request.suffix ?? "");

  const generated: GeneratedApartment[] = [];
  for (const wing of wings) {
    for (const floor of floorValues) {
      for (let unit = 1; unit <= request.unitsPerFloor; unit += 1) {
        const rendered: Record<PatternToken["kind"], string> = {
          wing: wing.label,
          floor:
            floorToken !== undefined &&
            floorToken.padWidth === null &&
            floor === 0
              ? GROUND_FLOOR_LABEL
              : renderCount(floor, floorToken?.padWidth ?? null),
          unit: renderCount(unit, unitToken.padWidth),
          prefix,
          suffix,
        };
        let label = literalChunks[0] ?? "";
        for (const [index, token] of tokens.entries()) {
          label += rendered[token.kind];
          label += literalChunks[index + 1] ?? "";
        }

        const number = createApartmentNumber(label);
        if (!number.ok) {
          return err(
            structureError(
              "validation",
              `The pattern produces a label longer than ${APARTMENT_NUMBER_MAX_LENGTH} characters (${label}). Shorten the prefix, wing or suffix.`,
              { field: "pattern" },
            ),
          );
        }
        generated.push({
          apartmentNumber: number.value,
          floor: floorToken === undefined ? null : floor,
          wingId: wing.id,
        });
      }
    }
  }

  return ok(generated);
}
