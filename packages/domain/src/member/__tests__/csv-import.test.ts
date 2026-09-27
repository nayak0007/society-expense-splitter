import {
  parseAndValidateCsv,
  parseCsv,
  templateCsv,
  validateCsvMemberRow,
  type CsvRecord,
} from "../csv-import";
import type { CsvRowError } from "../csv-import";

/** The error codes of one pass, for assertions that read like the failure they name. */
const codes = (errors: readonly CsvRowError[]): readonly string[] =>
  errors.map((error) => error.code);

const oneRow = (csv: string, header = templateCsv()) => {
  const outcome = parseAndValidateCsv(`${header}${csv}\n`);
  return {
    rows: outcome.ok ? outcome.value.rows : [],
    errors: outcome.ok ? outcome.value.errors : outcome.error,
    codes: outcome.ok ? codes(outcome.value.errors) : codes(outcome.error),
  };
};

describe("templateCsv", () => {
  it("is the header contract itself, so docs and code cannot drift", () => {
    expect(templateCsv()).toBe("flat_no,name,phone,email,occupancy_type\n");
  });
});

describe("parseCsv", () => {
  it("splits simple rows", () => {
    const parsed = parseCsv("a,b\n1,2\n3,4\n");
    expect(parsed.header).toEqual(["a", "b"]);
    expect(parsed.records.map((record) => record.cells)).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles quoted commas, escaped quotes and embedded newlines", () => {
    const parsed = parseCsv(
      'name,note\n"Menon, Suresh","said ""hello""\nthen left"\n',
    );
    expect(parsed.records[0]?.cells).toEqual([
      "Menon, Suresh",
      'said "hello"\nthen left',
    ]);
    // The multi-line cell keeps the line the ROW starts on — the number a human counts.
    expect(parsed.records[0]?.line).toBe(2);
  });

  it("accepts CRLF endings and a trailing line without a newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,3").records.map((r) => r.cells)).toEqual([
      ["1", "2"],
      ["3", "3"],
    ]);
  });

  it("tolerates a UTF-8 BOM without corrupting the first header", () => {
    const parsed = parseCsv("\uFEFFa,b\n1,2\n");
    expect(parsed.header).toEqual(["a", "b"]);
  });

  it("reports an unterminated quote as a row error, not a crash", () => {
    const parsed = parseCsv('a,b\n"open,2\n');
    expect(codes(parsed.errors)).toContain("UNTERMINATED_QUOTE");
  });

  it("ignores blank lines entirely — spreadsheet exports often have them", () => {
    expect(codes(parseCsv("a\n\n1\n").errors)).toEqual([]);
    expect(parseCsv("a\n\n1\n\n\n2\n").records).toHaveLength(2);
    expect(parseCsv("a\n1\n\n").errors).toHaveLength(0);
  });

  it("skips blank lines and enforces the row cap", () => {
    expect(parseCsv("a\n1\n2\n").records).toHaveLength(2);
    const parsed = parseCsv("a\n1\n2\n", { maxRows: 2 });
    expect(codes(parsed.errors)).toContain("TOO_MANY_ROWS");
  });
});

describe("header validation", () => {
  it("accepts the template and any order of the five columns", () => {
    expect(
      oneRow("A-1,Someone,+919876543210,x@y.in,tenant").errors,
    ).toHaveLength(0);
    const reordered = parseAndValidateCsv(
      "phone,name,email,flat_no,occupancy_type\n+919876543210,Someone,x@y.in,A-1,\n",
    );
    expect(reordered.ok && reordered.value.errors).toHaveLength(0);
  });

  it("refuses unknown, missing and duplicate columns, with a fatal duplicate", () => {
    expect(
      oneRow("A-1,N,+919876543210,,", "flat_no,name,phone,email,wing\n").codes,
    ).toContain("UNKNOWN_COLUMN");
    expect(
      oneRow("A-1,N,+919876543210,,", "flat_no,name,phone\n").codes,
    ).toContain("MISSING_HEADER");
    expect(
      oneRow("A-1,N,+919876543210,,", "name,name,phone,email,flat_no\n").codes,
    ).toContain("DUPLICATE_COLUMN");
    // Fatal: rows are NOT validated when the header is unusable.
    const fatal = parseAndValidateCsv(
      "nonsense,columns,only,here,also\nx,y,z,w,v\n",
    );
    expect(!fatal.ok).toBe(true);
  });

  it("is case- and whitespace-tolerant", () => {
    const outcome = parseAndValidateCsv(
      " Flat_No , NAME , Phone , Email , Occupancy_Type \nA-1,N,+919876543210,,\n",
    );
    expect(outcome.ok && outcome.value.errors).toHaveLength(0);
  });
});

describe("row validation", () => {
  const record = (line: number, cells: string[]): CsvRecord => ({
    line,
    cells,
  });

  it("normalises the phone to E.164 and trims every field", () => {
    const result = validateCsvMemberRow(
      record(2, [
        "A-1",
        "  Meera   Krishnan ",
        "98765 43210",
        " MEERA@Example.COM ",
        "tenant",
      ]),
    );
    expect(result.ok && result.row.phone).toBe("+919876543210");
    expect(result.ok && result.row.displayName).toBe("Meera Krishnan");
    expect(result.ok && result.row.email).toBe("meera@example.com");
    expect(result.ok && result.row.occupancy).toBe("tenant");
  });

  it("defaults occupancy and allows an empty flat and email", () => {
    const result = validateCsvMemberRow(
      record(2, ["", "Someone", "+919876543210", "", ""]),
    );
    expect(result.ok && result.row.apartmentNumber).toBeNull();
    expect(result.ok && result.row.occupancy).toBe("owner_occupied");
  });

  it("reports the exact failure per field", () => {
    expect(
      validateCsvMemberRow(record(4, ["A-1", "", "+919876543210", "", ""])),
    ).toMatchObject({
      ok: false,
      error: { line: 4, field: "name", code: "MISSING_NAME" },
    });
    expect(
      validateCsvMemberRow(record(8, ["A-1", "Someone", "12345", "", ""])),
    ).toMatchObject({
      ok: false,
      error: { line: 8, field: "phone", code: "INVALID_PHONE" },
    });
    expect(
      validateCsvMemberRow(
        record(9, ["A-1", "Someone", "+919876543210", "nope@", ""]),
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_EMAIL" } });
    expect(
      validateCsvMemberRow(
        record(12, ["A-1", "Someone", "+919876543210", "", "owner"]),
      ),
    ).toMatchObject({
      ok: false,
      error: { field: "occupancy_type", code: "INVALID_OCCUPANCY" },
    });
    expect(validateCsvMemberRow(record(3, ["A-1", "Someone"]))).toMatchObject({
      ok: false,
      error: { code: "RAGGED_ROW" },
    });
  });

  it("refuses formula-like names and = emails", () => {
    expect(
      validateCsvMemberRow(
        record(2, ["A-1", "=cmd|' /C calc'!A0", "+919876543210", "", ""]),
      ),
    ).toMatchObject({ ok: false, error: { code: "FORMULA_LIKE_NAME" } });
    expect(
      validateCsvMemberRow(
        record(2, ["A-1", "-Dash Start", "+919876543210", "", ""]),
      ),
    ).toMatchObject({ ok: false, error: { code: "FORMULA_LIKE_NAME" } });
    expect(
      validateCsvMemberRow(
        record(2, ["A-1", "Someone", "+919876543210", "=cmd@x.com", ""]),
      ),
    ).toMatchObject({ ok: false, error: { code: "FORMULA_LIKE_EMAIL" } });
    // But a plus/dash email is legitimate and passes:
    const plus = validateCsvMemberRow(
      record(2, ["A-1", "Someone", "+919876543210", "+tag@x.com", ""]),
    );
    expect(plus.ok).toBe(true);
  });
});

describe("parseAndValidateCsv — whole-file pass", () => {
  it("passes the Roadmap's 50/3 case: every malformed row reported, the rest valid", () => {
    const lines = [templateCsv()];
    for (let i = 1; i <= 50; i += 1) {
      const phone = `+9198000${String(i).padStart(5, "0")}`;
      if (i === 10) lines.push(`A-${i},,+91980000010,,\n`);
      else if (i === 20) lines.push(`A-${i},Someone,not-a-phone,,\n`);
      else if (i === 30) lines.push(`A-${i},Someone,+91980000030,nope@,\n`);
      else lines.push(`A-${i},Person ${i},${phone},,\n`);
    }
    const outcome = parseAndValidateCsv(lines.join(""));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.rows).toHaveLength(47);
    expect([...codes(outcome.value.errors)].sort()).toEqual([
      "INVALID_EMAIL",
      "INVALID_PHONE",
      "MISSING_NAME",
    ]);
  });

  it("flags in-file duplicates by normalised phone and keeps the first row", () => {
    const { rows, codes: got } = oneRow(
      "A-1,First,+919876543210,,\nA-2,Second,98765 43210,,\nA-3,Third,+919876543211,,\n",
    );
    expect(got).toEqual(["DUPLICATE_IN_FILE"]);
    expect(rows.map((row) => row.displayName)).toEqual(["First", "Third"]);
  });

  it("flags two claims of one flat and skips both", () => {
    const { rows, codes: got } = oneRow(
      "A-1,First,+919876543210,,\nA-1,Second,+919876543211,,\n",
    );
    expect(got).toEqual(["APARTMENT_CLAIM_CONFLICT"]);
    expect(rows).toHaveLength(1); // the first claim is kept, the repeat flagged
  });

  it("reports row errors with their file line numbers", () => {
    const { errors } = oneRow("A-1,Good,+919876543210,,\n,,+919876543211,,\n");
    expect(errors[0]).toMatchObject({
      line: 3,
      field: "name",
      code: "MISSING_NAME",
    });
  });

  it("counts nothing for an empty file", () => {
    const outcome = parseAndValidateCsv("");
    expect(!outcome.ok).toBe(true);
    expect(codes(outcome.ok ? [] : outcome.error)).toContain("MISSING_HEADER");
  });
});
