import {
  asExpenseCommentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
} from "@ses/domain";
import type {
  ExpenseCommentDraft,
  ExpenseCommentId,
  ExpenseCommentRecord,
  ExpenseCommentRepository,
  ExpenseGstDetailsInput,
  ExpenseGstDetailsRecord,
  ExpenseGstDetailsRepository,
  ExpenseId,
  SocietyId,
  UserId,
} from "@ses/domain";

/**
 * In-memory `ExpenseGstDetailsRepository` and `ExpenseCommentRepository` for the
 * T072 HTTP suite.
 *
 * Only storage is faked — the guard chain, the pipes, the use cases and the mappers
 * all run for real. The database's own rules (RLS, the composite key, the identity
 * sequence, the definer function's author-or-Admin check) are **not** reproduced
 * here; the integration suite proves those against real PostgreSQL. This fake
 * reproduces the port's promise and nothing more, so a suite that leans on it still
 * fails when a use case regresses.
 */

export interface FakeGstDetailsRepository extends ExpenseGstDetailsRepository {
  readonly state: { readonly rows: Map<string, ExpenseGstDetailsRecord> };
}

export function createFakeGstDetailsRepository(): FakeGstDetailsRepository {
  const rows = new Map<string, ExpenseGstDetailsRecord>();
  return {
    state: { rows },
    findByExpense(
      expenseId: ExpenseId,
      societyId: SocietyId,
    ): Promise<ExpenseGstDetailsRecord | null> {
      return Promise.resolve(rows.get(`${societyId}:${expenseId}`) ?? null);
    },
    upsertForExpense(
      expenseId: ExpenseId,
      societyId: SocietyId,
      input: ExpenseGstDetailsInput,
    ): Promise<ExpenseGstDetailsRecord> {
      const record: ExpenseGstDetailsRecord = {
        expenseId,
        societyId,
        ...input,
      };
      rows.set(`${societyId}:${expenseId}`, record);
      return Promise.resolve(record);
    },
  };
}

export interface FakeCommentRepository extends ExpenseCommentRepository {
  readonly state: {
    readonly rows: ExpenseCommentRecord[];
    readonly deleted: ExpenseCommentId[];
  };
  seed(record: ExpenseCommentRecord): void;
}

export function createFakeCommentRepository(): FakeCommentRepository {
  const rows: ExpenseCommentRecord[] = [];
  const deleted: ExpenseCommentId[] = [];
  let idCounter = 0;
  let sequence = 0;

  return {
    state: { rows, deleted },
    seed(record: ExpenseCommentRecord): void {
      rows.push(record);
      sequence = Math.max(sequence, record.sequence);
    },
    listForExpense(
      expenseId: ExpenseId,
      societyId: SocietyId,
    ): Promise<readonly ExpenseCommentRecord[]> {
      return Promise.resolve(
        rows
          .filter(
            (row) => row.expenseId === expenseId && row.societyId === societyId,
          )
          .sort((a, b) => a.sequence - b.sequence),
      );
    },
    findById(
      commentId: ExpenseCommentId,
      expenseId: ExpenseId,
      societyId: SocietyId,
    ): Promise<ExpenseCommentRecord | null> {
      return Promise.resolve(
        rows.find(
          (row) =>
            row.id === commentId &&
            row.expenseId === expenseId &&
            row.societyId === societyId,
        ) ?? null,
      );
    },
    add(draft: ExpenseCommentDraft): Promise<ExpenseCommentRecord> {
      idCounter += 1;
      sequence += 1;
      const record: ExpenseCommentRecord = {
        id: asExpenseCommentId(
          `30000000-0000-4000-8000-${idCounter.toString().padStart(12, "0")}`,
        ),
        expenseId: draft.expenseId,
        societyId: draft.societyId,
        authorId: draft.authorId,
        body: draft.body,
        sequence,
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
        deletedAt: null,
        deletedBy: null,
      };
      rows.push(record);
      return Promise.resolve(record);
    },
    softDelete(
      commentId: ExpenseCommentId,
      _expenseId: ExpenseId,
      _societyId: SocietyId,
      actor: UserId,
    ): Promise<ExpenseCommentRecord> {
      const index = rows.findIndex((row) => row.id === commentId);
      const stored = rows[index]!;
      if (stored.deletedAt !== null) return Promise.resolve(stored);
      const tombstoned: ExpenseCommentRecord = {
        ...stored,
        deletedAt: "2026-10-08T12:00:00.000Z",
        // The definer function stamps the caller's membership; the fake mirrors
        // that with the actor's own id so a suite can assert who deleted.
        deletedBy: asMemberId(actor),
      };
      rows[index] = tombstoned;
      deleted.push(commentId);
      return Promise.resolve(tombstoned);
    },
  };
}

/** Convenience builders for the fakes' seeds. */
export function gstRecordFixture(
  overrides: Partial<ExpenseGstDetailsRecord> = {},
): ExpenseGstDetailsRecord {
  return {
    expenseId: asExpenseId("20000000-0000-4000-8000-000000000001"),
    societyId: asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12"),
    gstin: null,
    invoiceNumber: null,
    invoiceDate: null,
    taxableValuePaise: 0n as ExpenseGstDetailsRecord["taxableValuePaise"],
    cgstPaise: 0n as ExpenseGstDetailsRecord["cgstPaise"],
    sgstPaise: 0n as ExpenseGstDetailsRecord["sgstPaise"],
    igstPaise: 0n as ExpenseGstDetailsRecord["igstPaise"],
    cessPaise: 0n as ExpenseGstDetailsRecord["cessPaise"],
    hsnSac: null,
    placeOfSupply: null,
    isReverseCharge: false,
    itcEligible: false,
    ...overrides,
  };
}

export function commentRecordFixture(
  overrides: Partial<ExpenseCommentRecord> = {},
): ExpenseCommentRecord {
  return {
    id: asExpenseCommentId("30000000-0000-4000-8000-000000000001"),
    expenseId: asExpenseId("20000000-0000-4000-8000-000000000001"),
    societyId: asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12"),
    authorId: asMemberId("10000000-0000-4000-8000-000000000003"),
    body: "Why did this cost ₹40,000?",
    sequence: 1,
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}
