import {
  asApartmentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  Money,
  paise,
} from "@ses/domain";
import type {
  ApproveExpenseRecordInput,
  CreateExpenseRecordInput,
  ExpenseId,
  ExpenseListQuery,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  ExpenseSplitRecord,
  ExpenseSplitsReader,
  RejectExpenseRecordInput,
  SocietyId,
  UpdateExpenseRecordInput,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { ListSplitsUseCase } from "../list-splits.use-case";

/**
 * The current-splits read — T073.
 *
 * The two properties worth a unit test are the ones the SQL cannot state on its own:
 * a foreign or unknown expense is a `not_found` **before** any split row is read, and
 * an expense with no allocation is an empty list rather than an error.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const ACTOR: UserId = asUserId("11111111-1111-4111-8111-111111111111");

const EXPENSE_RECORD = {
  id: EXPENSE,
  societyId: SOCIETY,
} as unknown as ExpenseRecord;

class FakeExpenseRepository implements ExpenseRepository {
  record: ExpenseRecord | null = EXPENSE_RECORD;

  create(_input: CreateExpenseRecordInput): Promise<ExpenseRecord> {
    return Promise.reject(new Error("the splits read never creates"));
  }
  findById(): Promise<ExpenseRecord | null> {
    return Promise.resolve(this.record);
  }
  update(
    _id: ExpenseId,
    _societyId: SocietyId,
    _v: number,
    _input: Omit<UpdateExpenseRecordInput, "expectedVersion">,
  ): Promise<ExpenseRecord> {
    return Promise.reject(new Error("the splits read never writes"));
  }
  list(_societyId: SocietyId, _query: ExpenseListQuery): Promise<ExpensePage> {
    return Promise.reject(new Error("the splits read never lists"));
  }
  deleteDraft(): Promise<void> {
    return Promise.reject(new Error("the splits read never deletes"));
  }
  approve(
    _id: ExpenseId,
    _societyId: SocietyId,
    _input: ApproveExpenseRecordInput,
    _actor: UserId,
  ): Promise<ExpenseRecord> {
    return Promise.reject(new Error("the splits read never approves"));
  }
  reject(
    _id: ExpenseId,
    _societyId: SocietyId,
    _input: RejectExpenseRecordInput,
    _actor: UserId,
  ): Promise<ExpenseRecord> {
    return Promise.reject(new Error("the splits read never rejects"));
  }
}

class FakeSplitsReader implements ExpenseSplitsReader {
  rows: ExpenseSplitRecord[] = [];
  readonly calls: ExpenseId[] = [];

  listForExpense(expenseId: ExpenseId): Promise<readonly ExpenseSplitRecord[]> {
    this.calls.push(expenseId);
    return Promise.resolve(this.rows);
  }
}

function row(amountPaise: bigint): ExpenseSplitRecord {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    expenseId: EXPENSE,
    memberId: asMemberId("10000000-0000-4000-8000-000000000001"),
    apartmentId: asApartmentId("60000000-0000-4000-8000-000000000001"),
    amount: Money.fromPaise(paise(amountPaise)),
    weight: "1.0000",
    percent: null,
    assignedReason: null,
    snapshot: { memberName: "Member", apartmentNumber: "A-101" },
    createdAt: "2026-10-07T09:00:00.000Z",
  };
}

function world() {
  const expenses = new FakeExpenseRepository();
  const splits = new FakeSplitsReader();
  return { expenses, splits, useCase: new ListSplitsUseCase(expenses, splits) };
}

async function rejection(pending: Promise<unknown>): Promise<AppError> {
  try {
    await pending;
  } catch (error: unknown) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("ListSplitsUseCase", () => {
  it("returns the persisted split rows for a visible expense", async () => {
    const w = world();
    w.splits.rows = [row(250_000n), row(200_000n)];

    const splits = await w.useCase.list(ACTOR, SOCIETY, EXPENSE);

    expect(splits).toHaveLength(2);
    expect(splits.reduce((total, s) => total + s.amount.paise, 0n)).toBe(
      450_000n,
    );
    expect(w.splits.calls).toEqual([EXPENSE]);
  });

  it("answers an empty list for an unallocated expense, not an error", async () => {
    const w = world();
    expect(await w.useCase.list(ACTOR, SOCIETY, EXPENSE)).toEqual([]);
  });

  it("answers not_found for an expense the caller cannot see, without reading splits", async () => {
    const w = world();
    w.expenses.record = null;

    const error = await rejection(w.useCase.list(ACTOR, SOCIETY, EXPENSE));

    expect(error.code).toBe("NOT_FOUND");
    expect(w.splits.calls).toEqual([]);
  });
});
