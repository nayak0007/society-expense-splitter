import type { ExpenseMonthGroup } from '../hooks/use-expenses';
import type {
  ExpenseAttachmentView,
  ExpenseCommentView,
  ExpenseRevisionView,
  ExpenseSplitView,
  ExpenseSummary,
} from '../repository/expense.repository';

/**
 * Small builders for the expense component tests.
 *
 * Every builder returns a complete, realistic row and takes a partial override, so a test
 * states only the field it is about and the rest stays a valid shape. They are fixtures, not
 * a framework: no registry, no teardown.
 */

export function makeExpense(overrides: Partial<ExpenseSummary> = {}): ExpenseSummary {
  return {
    id: 'exp-1',
    societyId: 'soc-1',
    categoryId: 'cat-1',
    title: 'Lift AMC',
    description: null,
    amountPaise: 4_500_000,
    expenseDate: '2026-09-30',
    vendorName: null,
    status: 'published',
    version: 1,
    publishedAt: '2026-09-30T10:00:00.000Z',
    voidedAt: null,
    voidReason: null,
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

export function makeSplit(overrides: Partial<ExpenseSplitView> = {}): ExpenseSplitView {
  return {
    id: 'split-1',
    memberId: 'mem-1',
    apartmentId: 'apt-1',
    amountPaise: 1_500_000,
    weight: '1',
    percent: null,
    assignedReason: 'equal_share',
    memberName: 'Owner A1',
    apartmentNumber: 'A1',
    ...overrides,
  };
}

export function makeRevision(overrides: Partial<ExpenseRevisionView> = {}): ExpenseRevisionView {
  return {
    id: 'rev-1',
    version: 1,
    changedBy: 'mem-9',
    changeNote: 'Corrected the amount',
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeComment(overrides: Partial<ExpenseCommentView> = {}): ExpenseCommentView {
  return {
    id: 'comment-1',
    authorId: 'mem-1',
    body: 'Paid by cheque',
    deleted: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeAttachment(
  overrides: Partial<ExpenseAttachmentView> = {},
): ExpenseAttachmentView {
  return {
    id: 'att-1',
    originalFilename: 'bill.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    scanStatus: 'pending',
    completedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<ExpenseMonthGroup> = {}): ExpenseMonthGroup {
  return {
    key: '2026-09',
    label: 'September 2026',
    totalPaise: 4_500_000,
    expenses: [makeExpense()],
    ...overrides,
  };
}
