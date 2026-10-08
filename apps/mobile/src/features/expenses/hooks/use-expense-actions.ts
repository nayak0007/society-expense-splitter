import type { CreateExpensePayload, UpdateExpensePayload } from '@ses/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import type { ExpenseSummary } from '../repository/expense.repository';
import { createExpense, updateExpense } from '../services/expense.service';

import { expenseKeys } from './expense-keys';

/**
 * Expense write hooks — the form's mutations (Roadmap T074).
 *
 * ## Both are **server-confirmed**, and that is a decision
 *
 * The member directory patches its cache optimistically for an edit; an expense does not. Three
 * reasons, all specific to money: the server is the authority on `status` (a draft that crosses
 * the approval threshold becomes `pending_approval` — a client guess would show a saved draft
 * that is really awaiting approval), it is the authority on `version` (the optimistic lock the
 * next write depends on), and it is the only writer of splits and dues. A row rendered from a
 * guess would be a *financial* row that no one has committed.
 *
 * The wait is covered by the form's own pending state rather than by an invented row.
 *
 * ## The scope comes from the stores, never from a screen argument
 *
 * Same rule as the reads: the society is what the row belongs to and the user is who may write
 * it, so the value in the `X-Society-Id` header is by construction the value the cache keys are
 * scoped by. A screen that supplied either could be wrong; the session cannot.
 */

interface Scope {
  readonly actorId: string | null;
  readonly societyId: string | null;
}

function useScope(): Scope {
  return {
    actorId: useAuthStore(selectAuthUser)?.id ?? null,
    societyId: useSocietyStore(selectActiveSocietyId),
  };
}

/**
 * Resolved at call time rather than during render — a hook must never throw while React is
 * rendering, and by the time a mutation runs the session is a fact.
 */
function requireScope(scope: Scope): { readonly actorId: string; readonly societyId: string } {
  if (scope.actorId === null) {
    throw new Error('Your session expired. Please sign in again.');
  }
  if (scope.societyId === null) {
    throw new Error('Switch to a society to record an expense.');
  }
  return { actorId: scope.actorId, societyId: scope.societyId };
}

/**
 * Create a draft.
 *
 * Nothing is optimistic: the server mints the id, and every key, route and cache entry the new
 * row will be addressed by is that id — so a fabricated row would be a row nobody can open.
 */
export function useCreateExpense() {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<ExpenseSummary, unknown, CreateExpensePayload>({
    mutationFn: (payload) => {
      const { actorId, societyId } = requireScope(scope);
      return createExpense(actorId, societyId, payload);
    },
    onSuccess: () => {
      // The whole namespace: a new row changes the ledger, its month's total, the counts a filter
      // chip would produce and anything derived from them.
      void queryClient.invalidateQueries({ queryKey: expenseKeys.all });
    },
  });
}

/**
 * Edit a draft or pending-approval expense.
 *
 * `expenseId` is captured here so the payload stays a pure contract value (it carries
 * `expectedVersion`, not an id). On success the detail entry is **dropped and refetched** rather
 * than merged: the response is authoritative and the row it describes may have moved state.
 */
export function useUpdateExpense(expenseId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<ExpenseSummary, unknown, UpdateExpensePayload>({
    mutationFn: (payload) => {
      const { actorId, societyId } = requireScope(scope);
      if (expenseId === null) {
        throw new Error('That expense is not available to you.');
      }
      return updateExpense(actorId, societyId, expenseId, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: expenseKeys.all });
    },
  });
}
