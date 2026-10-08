import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import type { UseFormReturn } from 'react-hook-form';

import { isNetworkError } from '@/lib/api/api-client';
import { useAutosaveDraft } from '@/lib/forms/use-autosave-draft';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import type { ExpenseSummary } from '../repository/expense.repository';
import { parseRupeeText } from '../schemas/expense-amount';
import {
  emptyExpenseForm,
  expenseFormResolver,
  expenseToFormValues,
  formFieldOfError,
  formValuesToCreatePayload,
  formValuesToUpdatePayload,
  isVersionConflict,
  staleVersionFromError,
} from '../schemas/expense-form.schemas';
import type { ExpenseFormValues } from '../schemas/expense-form.schemas';
import {
  clearExpenseDraft,
  expenseDraftKey,
  isDraftStale,
  readExpenseDraft,
  writeExpenseDraft,
} from '../services/expense-draft.store';
import type { ExpenseDraftScope } from '../services/expense-draft.store';
import { expenseErrorMessage } from '../services/expense.service';

import { useCreateExpense, useUpdateExpense } from './use-expense-actions';

/**
 * The expense form's controller (Roadmap T074).
 *
 * ## One hook, two modes, and the differences are named
 *
 * `mode: 'create'` posts and navigates; `mode: 'edit'` diffs against the server's row, carries
 * `expectedVersion` and can meet the optimistic lock. They share the fields, the resolver, the
 * draft and the error mapping, so splitting them into two hooks would duplicate exactly the parts
 * that must not drift.
 *
 * ## The form is uncontrolled and the screen is not re-rendered per keystroke
 *
 * SAD §6.4's reason for RHF here is a treasurer on a low-end phone: values are read imperatively
 * (`readValues`, fed by `form.watch`'s subscription) rather than held in React state, so typing an
 * amount re-renders the amount field and nothing else. The autosave hook polls the same
 * subscription every three seconds.
 *
 * ## The draft is read *before* the first render
 *
 * `useState`'s initialiser runs once, before RHF exists, and its result becomes `defaultValues`.
 * That ordering is the whole of "resume after app kill": there is no window in which empty
 * defaults could be rendered — and therefore autosaved — over a restored draft. A draft written
 * against a version the expense has since moved past is **not** applied; the screen says so
 * instead, because silently re-applying a stale edit to a recalculation is how a payment gets
 * charged to the wrong amount.
 *
 * ## Ambiguous failures are surfaced, never retried
 *
 * `POST /expenses` carries no idempotency key (only `publish` does, T066), so a create that
 * failed without a confirmed response is *kept as a draft* and reported as possibly-recorded. The
 * hook never retries a POST.
 */

export type ExpenseFormMode = 'create' | 'edit';

export interface UseExpenseFormOptions {
  readonly mode: ExpenseFormMode;
  /** The loaded row in edit mode; `null` while creating. */
  readonly expense: ExpenseSummary | null;
  /** Called after a confirmed save, with the server's row. */
  readonly onSaved: (expense: ExpenseSummary) => void;
  /** Re-reads the row after a version conflict, so the user can compare. */
  readonly refresh: () => void;
}

export interface ExpenseFormConflict {
  /** The version the server holds now, when it said so. */
  readonly currentVersion: number | null;
}

export interface ExpenseFormController {
  readonly form: UseFormReturn<ExpenseFormValues>;
  /** The values as of the last change — used by autosave and by the payload builders. */
  readValues: () => ExpenseFormValues;
  /** Receives `AmountInput`'s emitted integer paise. */
  setAmountPaise: (paise: number | null) => void;
  submit: () => void;
  readonly isSaving: boolean;
  readonly rootError: string | null;
  readonly conflict: ExpenseFormConflict | null;
  /** Discard the local edit and reload the server's values. */
  useServerVersion: () => void;
  /** Keep the local edit; the next save is sent against the server's current version. */
  keepMyChanges: () => void;
  readonly notice: string | null;
  dismissNotice: () => void;
  /** ISO instant the restored draft was written, or `null` when none was restored. */
  readonly restoredDraftAt: string | null;
  /** True when a stored draft existed but was based on a version the row has left. */
  readonly ignoredStaleDraft: boolean;
  /** Explicit discard: clears the stored draft and resets the fields. */
  discardDraft: () => void;
  readonly lastSavedAt: string | null;
}

/** What the first render decides, once. */
interface InitialState {
  readonly values: ExpenseFormValues;
  readonly restoredDraftAt: string | null;
  readonly ignoredStaleDraft: boolean;
}

export function useExpenseForm({
  mode,
  expense,
  onSaved,
  refresh,
}: UseExpenseFormOptions): ExpenseFormController {
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);

  const scope: ExpenseDraftScope = {
    userId,
    societyId,
    expenseId: mode === 'edit' ? (expense?.id ?? null) : null,
  };
  // The key is the isolation boundary; it is also what makes the initial read below stable.
  const draftKey = expenseDraftKey(scope);

  const baseline = expense === null ? emptyExpenseForm() : expenseToFormValues(expense);

  const [initial] = useState<InitialState>(() =>
    readInitialState(scope, expense === null ? null : expense.version, baseline),
  );

  const form = useForm<ExpenseFormValues>({
    resolver: expenseFormResolver,
    defaultValues: initial.values,
    // SAD §6.4's mode: validate when the user leaves a field, not on every keystroke — a form that
    // shouts "Enter a title" at the first character of a title is noise.
    mode: 'onBlur',
  });

  const valuesRef = useRef<ExpenseFormValues>(initial.values);
  useEffect(() => {
    const subscription = form.watch((values) => {
      valuesRef.current = values as ExpenseFormValues;
    });
    return () => subscription.unsubscribe();
  }, [form]);

  /*
    The amount's paise start from the values the form opened with.

    `AmountInput` emits on **change**, and a prefilled amount never changes before the first save —
    so seeding this from the initial text is what makes "edit a title and save" send a payload at
    all. Without it the payload builder refuses the (null) amount, and every edit of an untouched
    amount fails on the client. Found by `ExpenseFormScreen.test.tsx`'s edit-submit case.
  */
  const amountRef = useRef<number | null>(parseRupeeText(initial.values.amount).paise);
  const expectedVersionRef = useRef<number | null>(expense?.version ?? null);
  const inFlight = useRef(false);
  const expenseRef = useRef(expense);
  expenseRef.current = expense;

  const [rootError, setRootError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ExpenseFormConflict | null>(null);

  const create = useCreateExpense();
  const update = useUpdateExpense(mode === 'edit' ? (expense?.id ?? null) : null);

  const autosave = useAutosaveDraft<ExpenseFormValues>({
    read: () => valuesRef.current,
    write: (values) => {
      // Nothing is stored without a session and a tenant: a draft nobody can address is worse than
      // no draft, because it would outlive the switch that made it unreadable.
      writeExpenseDraft(scope, values, expectedVersionRef.current);
    },
    // Suspended while a save is in flight, so the interval cannot race the clear-on-success.
    enabled: draftKey !== null && !create.isPending && !update.isPending,
  });

  const isSaving = create.isPending || update.isPending;

  const submit = form.handleSubmit(async (values) => {
    // A **synchronous** guard, not `mutation.isPending`: React state has not re-rendered between
    // two taps inside one frame, and this is the only protection the create route has (it has no
    // idempotency key).
    if (inFlight.current) return;
    inFlight.current = true;
    setRootError(null);
    setNotice(null);

    try {
      if (mode === 'create') {
        const created = await create.mutateAsync(
          formValuesToCreatePayload(values, amountRef.current),
        );
        clearExpenseDraft(scope);
        onSaved(created);
        return;
      }

      const expectedVersion = expectedVersionRef.current;
      if (expectedVersion === null) {
        setRootError('This expense is not available to edit.');
        return;
      }

      const payload = formValuesToUpdatePayload({
        values,
        baseline: expenseRef.current === null ? baseline : expenseToFormValues(expenseRef.current),
        expectedVersion,
        amountPaise: amountRef.current,
      });

      if (payload === null) {
        setNotice('Nothing changed yet — edit a field before saving.');
        return;
      }

      const updated = await update.mutateAsync(payload);
      clearExpenseDraft(scope);
      expectedVersionRef.current = updated.version;
      onSaved(updated);
    } catch (caught: unknown) {
      if (isVersionConflict(caught)) {
        // The user's values stay exactly as typed; nothing is overwritten on either side.
        setConflict({ currentVersion: staleVersionFromError(caught) });
        refresh();
        return;
      }

      if (mode === 'create' && isNetworkError(caught)) {
        // The request may or may not have reached the server. The draft is deliberately *not*
        // cleared and no retry is attempted: telling the user is the only honest option.
        setNotice(
          'We could not reach the server, so we could not confirm whether the expense was recorded. Your draft is kept — check the ledger before saving again, in case it already arrived.',
        );
        return;
      }

      const field = formFieldOfError(caught);
      const message = expenseErrorMessage(caught);
      if (field !== undefined) {
        form.setError(field, { message });
        return;
      }
      setRootError(message);
    } finally {
      inFlight.current = false;
    }
  });

  const useServerVersion = (): void => {
    const server = expenseRef.current;
    if (server !== null) {
      const serverValues = expenseToFormValues(server);
      form.reset(serverValues);
      valuesRef.current = serverValues;
      amountRef.current = parseRupeeText(serverValues.amount).paise;
      expectedVersionRef.current = server.version;
    }
    setConflict(null);
    setNotice('Loaded the server’s version. Review it, then save if you still want to change it.');
  };

  const keepMyChanges = (): void => {
    /*
      The lock is re-armed against the version the **server reported**, not the one the loaded row
      happens to carry: the conflict's own `current` is authoritative and is already in hand, while
      the refetch it triggered may still be in flight — and a user who reads the notice and taps
      "Keep mine" immediately must not send the same stale version back.
    */
    const reported = conflict?.currentVersion ?? null;
    const server = expenseRef.current;
    if (reported !== null) {
      expectedVersionRef.current = reported;
    } else if (server !== null) {
      expectedVersionRef.current = server.version;
    }
    setConflict(null);
    setNotice(
      'Your changes are kept. Saving again will write them over the version on the server.',
    );
  };

  const discardDraft = (): void => {
    clearExpenseDraft(scope);
    const cleared = baseline;
    form.reset(cleared);
    valuesRef.current = cleared;
    amountRef.current = parseRupeeText(cleared.amount).paise;
    setNotice(null);
    setRootError(null);
  };

  return {
    form,
    readValues: () => valuesRef.current,
    setAmountPaise: (paise) => {
      amountRef.current = paise;
    },
    submit: () => void submit(),
    isSaving,
    rootError,
    conflict,
    useServerVersion,
    keepMyChanges,
    notice,
    dismissNotice: () => setNotice(null),
    restoredDraftAt: initial.restoredDraftAt,
    ignoredStaleDraft: initial.ignoredStaleDraft,
    discardDraft,
    lastSavedAt: autosave.lastSavedAt,
  };
}

/**
 * The one-time initial read.
 *
 * Order of preference: a **non-stale** stored draft → the server's row (edit) → an empty form
 * (create). A stale draft is not applied, and is not deleted either: the user may still want to
 * read what they had written, and deleting their text for them would be a second decision they
 * did not make.
 */
function readInitialState(
  scope: ExpenseDraftScope,
  servedVersion: number | null,
  baseline: ExpenseFormValues,
): InitialState {
  const draft = readExpenseDraft(scope);
  if (draft === null) {
    return { values: baseline, restoredDraftAt: null, ignoredStaleDraft: false };
  }
  if (isDraftStale(draft, servedVersion)) {
    return { values: baseline, restoredDraftAt: null, ignoredStaleDraft: true };
  }
  return { values: draft.values, restoredDraftAt: draft.savedAt || null, ignoredStaleDraft: false };
}
