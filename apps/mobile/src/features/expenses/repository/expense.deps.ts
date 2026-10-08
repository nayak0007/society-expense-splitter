/**
 * Expense feature composition root — the one place that decides which repository
 * implementation the app uses.
 *
 * The API is the only implementation, and there is deliberately no mock, for the reason the
 * members and structure features record: the expense rules live server-side and are
 * exercised by the API's own e2e/integration suites, so a local fake would be a second
 * implementation of rules that already have one owner.
 *
 * The seam exists anyway — importing this module must not construct anything, and a test or a
 * preview can swap in a stub without module mocking:
 *
 *     setExpenseRepository(fake);
 *
 * Resolved lazily rather than captured, so a repository is built after the session exists
 * rather than at import time.
 */

import { ApiExpenseRepository } from './expense.repository.api';
import type { ExpenseRepository } from './expense.repository';

let expenseRepository: ExpenseRepository | null = null;

export function getExpenseRepository(): ExpenseRepository {
  expenseRepository ??= new ApiExpenseRepository();
  return expenseRepository;
}

/** Test/tooling seam — inject a fake or a stub. */
export function setExpenseRepository(repository: ExpenseRepository | null): void {
  expenseRepository = repository;
}
