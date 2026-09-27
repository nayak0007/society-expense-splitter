import { err, ok } from "../shared/result";
import type { Result } from "../shared/result";

import type { MemberOccupancy } from "./member";
import { DEFAULT_MEMBER_OCCUPANCY } from "./member";
import {
  createDisplayName,
  createEmail,
  createMemberOccupancy,
  createPhone,
} from "./member-value-objects";

/**
 * Bulk CSV member import (Roadmap T048; PRD §3.2 step 4 / §6.3: "Bulk invite from
 * CSV with a dry-run preview showing parse errors per row").
 *
 * ## What lives here, and why it is in the domain
 *
 * The parser, the header contract, the row grammar and the formula guard are **pure
 * functions of text** — no I/O, no framework, no clock — so the API's import route and
 * the mobile client's pre-upload check run the *same* grammar and can never disagree
 * about what a valid file is (SAD §7: one contract, two consumers). The Roadmap's
 * "Create … csv-parser.service.ts" named the *capability*; the architecture puts the
 * grammar where every other rule of the member module lives, and the API's service (the
 * next file outward) keeps only the operational limits and the dependency wiring.
 *
 * ## The contract, derived from the Roadmap's own column list
 *
 * `flat_no, name, phone, email, occupancy_type` — line 1 is a header row naming exactly
 * these five columns (order free; unknown, missing or duplicated headers are row-1
 * errors, because a silently ignored header is a whole file of silently wrong rows).
 * `name` and `phone` are required; `flat_no`, `email` and `occupancy_type` are optional.
 * There is deliberately **no role column**: the direct-add path (T045) — whose rules
 * this import reuses — creates residents, and role assignment is T046's guarded,
 * audited operation. A CSV column that could mint a Treasurer would be a privilege-
 * escalation surface the matrix never granted.
 */

/** The Roadmap's cap, verbatim. One file, one thousand data rows. */
export const CSV_IMPORT_MAX_ROWS = 1_000;

/** The five headers, in template order. Kept beside `templateCsv()` so they cannot drift. */
export const CSV_MEMBER_HEADERS = [
  "flat_no",
  "name",
  "phone",
  "email",
  "occupancy_type",
] as const;

/** The downloadable template — the one spelling of the contract a society copies. */
export function templateCsv(): string {
  return `${CSV_MEMBER_HEADERS.join(",")}\n`;
}

/**
 * Characters a spreadsheet evaluates as a formula when a cell *begins* with them.
 * The canonical list (`=` `+` `-` `@`) plus the tab, which Excel also treats as
 * formula-leading in some locales.
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t"];

/**
 * The guard for free-text cells that will be *stored verbatim* and may one day be
 * exported back to CSV.
 *
 * The refusal — not a silent prefix — is the point: prefixing `'` corrupts the stored
 * name (the admin typed what they typed), while refusing with a named error tells them
 * exactly which row and character to fix. A person's name never legitimately begins
 * with a formula character, so nothing legitimate is refused.
 *
 * Deliberately **not** applied to `phone` and `email`:
 *  - a phone cell is *normalised* before storage — only `+` and digits survive
 *    (`createPhone`), so no formula can ride in on it; the stored `+91…` form is a
 *    leading-`+` cell on **export**, and quoting dangerous cells is the export
 *    feature's own guard (there is no export yet — this comment is the seam);
 *  - `+meera@…` and `-meera@…` are legitimate local parts, and refusing them would
 *    corrupt real addresses. `=`-leading is refused: no provider routes mail to it and
 *    it is the one character that makes an address look like a formula.
 */
export function isFormulaLike(value: string): boolean {
  return value.length > 0 && FORMULA_PREFIXES.includes(value[0] ?? "");
}

/** One parser-level or field-level failure, addressed by its 1-based file line. */
export interface CsvRowError {
  /** The 1-based line in the file the error belongs to (header is line 1). */
  readonly line: number;
  readonly field:
    "flat_no" | "name" | "phone" | "email" | "occupancy_type" | "row";
  /** Machine-readable, stable — the mobile screen groups and renders by it. */
  readonly code: CsvRowErrorCode;
  readonly message: string;
}

export const CSV_ROW_ERROR_CODES = [
  // File/parse level.
  "EMPTY_FILE",
  "MISSING_HEADER",
  "UNKNOWN_COLUMN",
  "DUPLICATE_COLUMN",
  "TOO_MANY_ROWS",
  "RAGGED_ROW",
  "UNTERMINATED_QUOTE",
  // Field level.
  "MISSING_NAME",
  "INVALID_NAME",
  "MISSING_PHONE",
  "INVALID_PHONE",
  "INVALID_EMAIL",
  "INVALID_OCCUPANCY",
  "FORMULA_LIKE_NAME",
  "FORMULA_LIKE_EMAIL",
  // Cross-record level (decided by the use case against storage, codes defined here
  // so the wire vocabulary is one list).
  "APARTMENT_NOT_FOUND",
  "APARTMENT_CLAIM_CONFLICT",
  "DUPLICATE_IN_FILE",
  "ALREADY_MEMBER",
  "INVITATION_PENDING",
  "IMPORT_ROW_FAILED",
] as const;

export type CsvRowErrorCode = (typeof CSV_ROW_ERROR_CODES)[number];

function rowError(
  line: number,
  field: CsvRowError["field"],
  code: CsvRowErrorCode,
  message: string,
): CsvRowError {
  return { line, field, code, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// The parser — RFC 4180, small and total
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One parsed data row: its 1-based file line and its raw cell strings.
 *
 * `line` is the *file* line the row starts on. A multi-line quoted cell keeps the row's
 * start line, which is the number a human counts in their editor.
 */
export interface CsvRecord {
  readonly line: number;
  readonly cells: readonly string[];
}

export interface ParsedCsv {
  readonly header: readonly string[];
  readonly records: readonly CsvRecord[];
  readonly errors: readonly CsvRowError[];
}

/**
 * Parse CSV text per RFC 4180: quoted cells, `""` escapes, embedded commas and
 * newlines, CRLF or LF endings, a UTF-8 BOM tolerated (Excel writes one).
 *
 * A state machine rather than `line.split(",")` for exactly the reasons the Roadmap
 * names — the naive split corrupts `"Menon, Suresh"` and cannot represent a quoted
 * quote. Malformed input is *reported*, never thrown: an unterminated quote and a
 * ragged row are row errors with line numbers, because "the file failed somewhere" is
 * not an error an admin can act on.
 *
 * The row cap is the parser's, not just the route's: a 100 MB paste must fail here in
 * bounded time rather than be parsed and then rejected.
 */
export function parseCsv(
  text: string,
  options: { readonly maxRows?: number | undefined } = {},
): ParsedCsv {
  const maxRows = options.maxRows ?? CSV_IMPORT_MAX_ROWS;
  // A UTF-8 BOM is three invisible characters that would otherwise become the first
  // header's first cell ("flat_no" would read "\uFEFFflat_no" and never match).
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const errors: CsvRowError[] = [];
  const records: CsvRecord[] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let sawAnyChar = false;
  let truncated = false;

  const endCell = (): void => {
    row.push(cell);
    cell = "";
  };
  const endRow = (): void => {
    endCell();
    // A blank line is skipped, not an error: spreadsheet exports and editors add them
    // freely, and refusing a whole import over one stray empty line would teach people
    // to hand-edit their files before every attempt.
    const isBlank = row.length === 1 && row[0] === "";
    if (!isBlank) {
      if (!truncated && records.length >= maxRows) {
        truncated = true;
        errors.push(
          rowError(
            line,
            "row",
            "TOO_MANY_ROWS",
            `A CSV import is at most ${maxRows} rows. Split the file and import in batches.`,
          ),
        );
      } else if (!truncated) {
        records.push({ line: rowStartLine, cells: row });
      }
    }
    row = [];
    sawAnyChar = false;
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (inQuotes) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (char === ",") {
      endCell();
      sawAnyChar = true;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      endRow();
      line += 1;
      rowStartLine = line;
      continue;
    }
    cell += char;
    sawAnyChar = true;
  }
  // A final cell without a trailing newline is still a row — and an unterminated
  // quote is reported rather than silently swallowing the rest of the file.
  if (inQuotes) {
    endRow();
    errors.push(
      rowError(
        rowStartLine,
        "row",
        "UNTERMINATED_QUOTE",
        "A quoted cell was never closed. Close the quote or remove it.",
      ),
    );
  } else if (row.length > 0 || sawAnyChar) {
    endRow();
  }

  return { header: records[0]?.cells ?? [], records: records.slice(1), errors };
}

/**
 * Validates line 1 against the contract. Returns the data records unchanged — the
 * header errors are appended to the parse errors by the caller — so a file with a
 * good header and bad rows reports *both* kinds on one pass.
 *
 * `MISSING_HEADER` (wrong column count or none of the five names present) is fatal to
 * the whole import — with no header there is no honest way to say what the columns
 * *are* — so the caller treats it as a file-level refusal rather than row noise.
 */
export function validateCsvHeader(
  header: readonly string[],
  line = 1,
): CsvRowError[] {
  if (header.length === 0) {
    return [
      rowError(
        line,
        "row",
        "MISSING_HEADER",
        "The first line must be the header row.",
      ),
    ];
  }
  const expected = new Set<string>(CSV_MEMBER_HEADERS);
  const seen = new Set<string>();
  const errors: CsvRowError[] = [];
  let knownColumns = 0;

  for (const raw of header) {
    const name = raw.trim().toLowerCase();
    if (name.length === 0) {
      errors.push(
        rowError(line, "row", "MISSING_HEADER", "A header cell is empty."),
      );
      continue;
    }
    if (!expected.has(name)) {
      errors.push(
        rowError(
          line,
          "row",
          "UNKNOWN_COLUMN",
          `"${raw.trim()}" is not a column this import reads. Expected: ${CSV_MEMBER_HEADERS.join(", ")}.`,
        ),
      );
      continue;
    }
    knownColumns += 1;
    if (seen.has(name)) {
      errors.push(
        rowError(
          line,
          "row",
          "DUPLICATE_COLUMN",
          `"${name}" appears more than once in the header.`,
        ),
      );
      continue;
    }
    seen.add(name);
  }

  if (knownColumns > 0 && seen.size < expected.size) {
    const missing = [...expected].filter((name) => !seen.has(name));
    errors.push(
      rowError(
        line,
        "row",
        "MISSING_HEADER",
        `The header is missing: ${missing.join(", ")}.`,
      ),
    );
  }
  if (seen.size === 0) {
    return [
      rowError(
        line,
        "row",
        "MISSING_HEADER",
        `The first line must be the header row: ${CSV_MEMBER_HEADERS.join(", ")}.`,
      ),
    ];
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row validation — the direct-add grammar, addressed by line number
// ─────────────────────────────────────────────────────────────────────────────

/** One row's fields, normalised exactly as the direct-add path would store them. */
export interface CsvMemberRow {
  readonly line: number;
  readonly displayName: string;
  /** E.164 — `createPhone`'s output, never the raw cell. */
  readonly phone: string;
  readonly email: string | null;
  readonly apartmentNumber: string | null;
  readonly occupancy: MemberOccupancy;
}

/** A row that failed field validation, with the error the preview renders. */
export type CsvRowValidation =
  | { readonly ok: true; readonly row: CsvMemberRow }
  | { readonly ok: false; readonly error: CsvRowError };

/**
 * Maps each known header name to its cell position — built from the **file's own header**
 * by `parseAndValidateCsv`, so a file may list the five columns in any order. Defaults to
 * the template order for a caller that validates a row without a file context.
 */
const TEMPLATE_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  CSV_MEMBER_HEADERS.map((name, index) => [name, index]),
);

export function headerIndexOf(
  header: readonly string[],
): Readonly<Record<string, number>> {
  const index: Record<string, number> = {};
  header.forEach((raw, position) => {
    const name = raw.trim().toLowerCase();
    if ((TEMPLATE_INDEX[name] ?? -1) >= 0 && index[name] === undefined) {
      index[name] = position;
    }
  });
  return index;
}

/**
 * Validates one data row with the *same value objects the direct-add form uses*
 * (`createDisplayName`, `createPhone`, `createEmail`, `createMemberOccupancy`) — that
 * is the whole point of this module: the import is the form at scale, not a second
 * grammar. Each value object's `field` maps onto the CSV column that fed it, so the
 * preview can put the error under the cell the admin can edit.
 */
export function validateCsvMemberRow(
  record: CsvRecord,
  headerIndex: Readonly<Record<string, number>> = TEMPLATE_INDEX,
): CsvRowValidation {
  const line = record.line;
  const cell = (name: string): string =>
    record.cells[headerIndex[name] ?? -1] ?? "";

  if (record.cells.length !== CSV_MEMBER_HEADERS.length) {
    return {
      ok: false,
      error: rowError(
        line,
        "row",
        "RAGGED_ROW",
        `Expected ${CSV_MEMBER_HEADERS.length} columns, found ${record.cells.length}.`,
      ),
    };
  }

  const rawName = cell("name").trim();
  if (rawName.length === 0) {
    return {
      ok: false,
      error: rowError(line, "name", "MISSING_NAME", "Every row needs a name."),
    };
  }
  if (isFormulaLike(rawName)) {
    return {
      ok: false,
      error: rowError(
        line,
        "name",
        "FORMULA_LIKE_NAME",
        "A name cannot start with = + - or @. Remove that character.",
      ),
    };
  }
  const displayName = createDisplayName(rawName);
  if (!displayName.ok) {
    return {
      ok: false,
      error: rowError(line, "name", "INVALID_NAME", displayName.error.message),
    };
  }

  const rawPhone = cell("phone").trim();
  if (rawPhone.length === 0) {
    return {
      ok: false,
      error: rowError(
        line,
        "phone",
        "MISSING_PHONE",
        "Every row needs a phone number — it is how the member is identified.",
      ),
    };
  }
  const phone = createPhone(rawPhone);
  if (!phone.ok || phone.value === null) {
    return {
      ok: false,
      error: rowError(
        line,
        "phone",
        "INVALID_PHONE",
        phone.ok ? "Enter a phone number." : phone.error.message,
      ),
    };
  }

  const rawEmail = cell("email").trim();
  if (rawEmail.startsWith("=")) {
    return {
      ok: false,
      error: rowError(
        line,
        "email",
        "FORMULA_LIKE_EMAIL",
        "An email cannot start with =. Remove that character.",
      ),
    };
  }
  const email = createEmail(rawEmail);
  if (!email.ok) {
    return {
      ok: false,
      error: rowError(line, "email", "INVALID_EMAIL", email.error.message),
    };
  }

  const rawFlat = cell("flat_no").trim();
  const flatNo = rawFlat.length === 0 ? null : rawFlat;

  const occupancy = createMemberOccupancy(
    cell("occupancy_type").trim() || undefined,
  );
  if (!occupancy.ok) {
    return {
      ok: false,
      error: rowError(
        line,
        "occupancy_type",
        "INVALID_OCCUPANCY",
        "Occupancy must be one of: owner_occupied, tenant, family_member, vacant_owner.",
      ),
    };
  }

  return {
    ok: true,
    row: {
      line,
      displayName: displayName.value,
      phone: phone.value,
      email: email.value,
      apartmentNumber: flatNo,
      occupancy: occupancy.value ?? DEFAULT_MEMBER_OCCUPANCY,
    },
  };
}

/**
 * The phone-normalisation key: two cells that normalise to the same E.164 number are
 * the same person as far as `uq_members_shadow_phone` is concerned, whether the file
 * wrote one as `98765 43210` and the other as `+919876543210`.
 */
export function csvDuplicateKey(row: CsvMemberRow): string {
  return row.phone;
}

/**
 * The whole-file field pass: parse → header → per-row validation, in one total
 * function the use case calls before touching storage.
 *
 * Row-level validation never masks parse-level errors and vice versa — an admin gets
 * everything wrong with their file in one preview, not one error per attempt.
 */
export function parseAndValidateCsv(text: string): Result<
  {
    readonly rows: readonly CsvMemberRow[];
    readonly errors: readonly CsvRowError[];
  },
  CsvRowError[]
> {
  const parsed = parseCsv(text);
  const headerErrors = validateCsvHeader(parsed.header);
  const fatalHeader = headerErrors.some(
    (error) =>
      error.code === "MISSING_HEADER" || error.code === "DUPLICATE_COLUMN",
  );

  const rows: CsvMemberRow[] = [];
  const rowErrors: CsvRowError[] = [...parsed.errors, ...headerErrors];

  if (fatalHeader) return err(rowErrors);

  const headerIndex = headerIndexOf(parsed.header);
  for (const record of parsed.records) {
    const validation = validateCsvMemberRow(record, headerIndex);
    if (validation.ok) rows.push(validation.row);
    else rowErrors.push(validation.error);
  }

  // Duplicates *within the file*: the first occurrence is the import candidate, every
  // repeat is flagged — the admin decides which row was right, the preview just says so.
  const seen = new Map<string, number>();
  const deduped: CsvMemberRow[] = [];
  for (const row of rows) {
    const key = csvDuplicateKey(row);
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      rowErrors.push(
        rowError(
          row.line,
          "phone",
          "DUPLICATE_IN_FILE",
          `The same phone number is already on line ${firstLine}. Keep one row per person.`,
        ),
      );
      continue;
    }
    seen.set(key, row.line);
    deduped.push(row);
  }

  // Two valid rows claiming one flat is exactly T049's collision, arriving by file:
  // both are flagged and both are skipped, because "flagged for admin decision" means
  // the admin decides — not that the first row wins.
  const flatClaims = new Map<string, number>();
  const noFlat: CsvMemberRow[] = [];
  for (const row of deduped) {
    if (row.apartmentNumber === null) {
      noFlat.push(row);
      continue;
    }
    const key = row.apartmentNumber.toLowerCase();
    const firstLine = flatClaims.get(key);
    if (firstLine !== undefined) {
      rowErrors.push(
        rowError(
          row.line,
          "flat_no",
          "APARTMENT_CLAIM_CONFLICT",
          `Line ${firstLine} claims flat ${row.apartmentNumber} too. Decide who holds it, then import them one at a time.`,
        ),
      );
      continue;
    }
    flatClaims.set(key, row.line);
    noFlat.push(row);
  }

  return ok({ rows: noFlat, errors: rowErrors });
}

/**
 * The summary counters the preview renders. `skipped` is `invalid + conflicts` and
 * `imported` what actually happened — the Roadmap's "nothing is silently dropped" is
 * this arithmetic: total = imported + skipped, always, per row.
 */
export interface CsvImportSummary {
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly conflicts: number;
  readonly skipped: number;
  readonly imported: number;
}

export function summarizeCsvImport(input: {
  readonly totalRows: number;
  readonly validRows: number;
  readonly conflicts: number;
  readonly imported: number;
}): CsvImportSummary {
  const invalidRows = Math.max(
    0,
    input.totalRows - input.validRows - input.conflicts,
  );
  return {
    totalRows: input.totalRows,
    validRows: input.validRows,
    invalidRows,
    conflicts: input.conflicts,
    skipped: invalidRows + input.conflicts,
    imported: input.imported,
  };
}
