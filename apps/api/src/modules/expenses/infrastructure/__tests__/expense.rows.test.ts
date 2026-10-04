import { ExpenseError, Money, expenseError } from "@ses/domain";
import type { ExpenseRecord } from "@ses/domain";

import {
  expenseErrorFromPostgres,
  expenseFromRow,
  expenseRowSchema,
  unexpectedShapeError,
} from "../expense.rows";

/**
 * The row boundary — T065's `expense.rows.ts`, in isolation.
 *
 * The integration suite proves these functions against a live database; this file
 * pins the table they encode, including the branches a route cannot reach but an
 * operator will: every SQLSTATE's translation, the wrapper's `cause` chain the
 * adapter always sees (Drizzle wraps `postgres.js`), and the money crossing. None of
 * it needs a database, which is exactly why it is here — a dropped `case` fails a
 * unit run rather than an integration run three minutes later.
 */

const ROW = {
  id: "20000000-0000-4000-8000-000000000001",
  society_id: "b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12",
  category_id: "0a000000-0000-4000-8000-000000000001",
  title: "Lift AMC",
  description: null as string | null,
  amount_paise: "4294967297",
  expense_date: "2026-09-30",
  vendor_name: null as string | null,
  payment_source: "society_account",
  paid_by_member_id: null as string | null,
  split_strategy: "equal",
  apartment_basis: null as string | null,
  split_config: {} as unknown,
  participant_selector: { scope: "society" } as unknown,
  status: "draft",
  created_by: "10000000-0000-4000-8000-000000000001",
  published_at: null as Date | string | null,
  voided_at: null as Date | string | null,
  voided_by: null as string | null,
  void_reason: null as string | null,
  version: 3,
  created_at: new Date("2026-10-01T10:00:00.000Z") as Date | string,
  updated_at: "2026-10-01T10:00:00.000Z" as Date | string,
};

function parseRow(overrides: Record<string, unknown> = {}): ExpenseRecord {
  const parsed = expenseRowSchema.safeParse({ ...ROW, ...overrides });
  if (!parsed.success) {
    throw new Error(
      `The fixture row no longer parses: ${parsed.error.message}`,
    );
  }
  return expenseFromRow(parsed.data);
}

describe("expenseFromRow", () => {
  it("crosses bigint money exactly and keeps the date a date", () => {
    const record = parseRow();

    expect(record.amount).toBeInstanceOf(Money);
    expect(record.amount.paise).toBe(4_294_967_297n);
    expect(record.expenseDate).toBe("2026-09-30");
    expect(record.status).toBe("draft");
    expect(record.version).toBe(3);
  });

  it("maps the nullable form fields as null rather than undefined", () => {
    const record = parseRow();

    expect(record.description).toBeNull();
    expect(record.vendorName).toBeNull();
    expect(record.paidByMemberId).toBeNull();
    expect(record.voidedAt).toBeNull();
    expect(record.voidedBy).toBeNull();
    expect(record.voidReason).toBeNull();
    expect(record.publishedAt).toBeNull();
  });

  it("maps the filled fields and normalises both timestamp serialisations", () => {
    const record = parseRow({
      description: "Covers Oct",
      vendor_name: "Kone India",
      paid_by_member_id: "10000000-0000-4000-8000-000000000002",
      published_at: "2026-10-02T00:00:00.000Z",
      voided_at: new Date("2026-10-03T00:00:00.000Z"),
      voided_by: "10000000-0000-4000-8000-000000000001",
      void_reason: "Duplicate of the September bill",
      status: "void",
    });

    expect(record.description).toBe("Covers Oct");
    expect(record.vendorName).toBe("Kone India");
    expect(record.paidByMemberId).toBe("10000000-0000-4000-8000-000000000002");
    expect(record.publishedAt).toBe("2026-10-02T00:00:00.000Z");
    // A `Date` column and its text form become the one ISO string.
    expect(record.voidedAt).toBe("2026-10-03T00:00:00.000Z");
    expect(record.voidedBy).toBe("10000000-0000-4000-8000-000000000001");
    expect(record.voidReason).toBe("Duplicate of the September bill");
    expect(record.status).toBe("void");
  });

  it("refuses a row carrying a status the domain does not know", () => {
    const parsed = expenseRowSchema.safeParse({ ...ROW, status: "approved" });

    expect(parsed.success).toBe(false);
  });
});

describe("expenseErrorFromPostgres", () => {
  it("passes an ExpenseError through untouched", () => {
    const original = expenseError("conflict", "Already there.");

    expect(expenseErrorFromPostgres(original, "write")).toBe(original);
    expect(expenseErrorFromPostgres(original, "read")).toBeInstanceOf(
      ExpenseError,
    );
  });

  it("maps P0002 and the function's own EXPENSE_NOT_FOUND to not_found", () => {
    expect(
      expenseErrorFromPostgres(
        { code: "P0002", message: "EXPENSE_NOT_FOUND" },
        "read",
      ).code,
    ).toBe("not_found");
    expect(
      expenseErrorFromPostgres(
        { code: "P0001", message: "EXPENSE_NOT_FOUND" },
        "write",
      ).code,
    ).toBe("not_found");
  });

  it("maps P0003 and EXPENSE_NOT_OWN_DRAFT to forbidden", () => {
    expect(
      expenseErrorFromPostgres(
        { code: "P0003", message: "EXPENSE_NOT_OWN_DRAFT" },
        "write",
      ).code,
    ).toBe("forbidden");
  });

  it("maps the delete function's other refusals by exception name", () => {
    expect(
      expenseErrorFromPostgres(
        { code: "P0001", message: "EXPENSE_NOT_DRAFT" },
        "write",
      ).code,
    ).toBe("invalid_transition");
    expect(
      expenseErrorFromPostgres(
        { code: "P0001", message: "EXPENSE_HAS_SPLITS" },
        "write",
      ).code,
    ).toBe("conflict");
    expect(
      expenseErrorFromPostgres(
        { code: "P0001", message: "SPLIT_MISMATCH: splits total 0 expected 1" },
        "write",
      ).code,
    ).toBe("split_mismatch");
    expect(
      expenseErrorFromPostgres({ code: "P0001", message: "OTHER" }, "write")
        .code,
    ).toBe("unknown");
  });

  it("reads RLS by context: invisible on a read, a role refusal on a write", () => {
    const denial = {
      code: "42501",
      message:
        'new row violates row-level security policy for table "expenses"',
    };

    expect(expenseErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(expenseErrorFromPostgres(denial, "write").code).toBe("forbidden");
    expect(
      expenseErrorFromPostgres(
        { code: "42501", message: "permission denied for table expenses" },
        "write",
      ).code,
    ).toBe("forbidden");
  });

  it("names the composite foreign keys' subjects", () => {
    expect(
      expenseErrorFromPostgres(
        {
          code: "23503",
          message: "insert or update violates foreign key constraint",
          constraint_name: "fk_expenses_category",
        },
        "write",
      ).code,
    ).toBe("not_found");

    const paidBy = expenseErrorFromPostgres(
      {
        code: "23503",
        message: "violates foreign key constraint",
        detail: "Key (paid_by_member_id)=(x) is not present in table members.",
      },
      "write",
    );
    expect(paidBy.code).toBe("validation");
    expect(paidBy.details?.field).toBe("paidByMemberId");

    expect(
      expenseErrorFromPostgres(
        { code: "23503", message: "violates foreign key constraint" },
        "write",
      ).code,
    ).toBe("not_found");
  });

  it("maps a unique violation to conflict and a check to validation", () => {
    expect(
      expenseErrorFromPostgres(
        { code: "23505", message: "duplicate key" },
        "write",
      ).code,
    ).toBe("conflict");

    const check = expenseErrorFromPostgres(
      {
        code: "23514",
        message: 'new row violates check constraint "chk_expenses_amount"',
        constraint_name: "chk_expenses_amount",
        detail: "Failing row contains (..., amount_paise).",
      },
      "write",
    );
    expect(check.code).toBe("validation");
    expect(check.details?.field).toBe("amountPaise");
  });

  it("recognises a missing migration rather than reporting the caller's fault", () => {
    const missing = expenseErrorFromPostgres(
      { code: "42P01", message: 'relation "public.expenses" does not exist' },
      "read",
    );

    expect(missing.code).toBe("unknown");
    expect(missing.details?.hint).toMatch(/expense_schema/);
  });

  it("walks the wrapper's cause chain — the shape Drizzle always throws", () => {
    const wrapped = {
      message: "Failed query: insert into expenses",
      cause: { code: "23503", constraint_name: "fk_expenses_category" },
    };

    expect(expenseErrorFromPostgres(wrapped, "write").code).toBe("not_found");
  });

  it("falls back to unknown for an unclassifiable failure", () => {
    const failure = expenseErrorFromPostgres(
      new Error("the socket went away"),
      "write",
    );

    expect(failure.code).toBe("unknown");
  });
});

describe("unexpectedShapeError", () => {
  it("is an internal failure with an operator-facing hint", () => {
    const error = unexpectedShapeError("expense");

    expect(error.code).toBe("unknown");
    expect(error.details?.hint).toBe(
      "Unexpected expense shape returned by the database.",
    );
  });
});
