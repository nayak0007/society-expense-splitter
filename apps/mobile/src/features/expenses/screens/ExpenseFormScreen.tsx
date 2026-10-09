import { useLocalSearchParams, useRouter } from 'expo-router';
import { Controller } from 'react-hook-form';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { selectActiveMembership, useSocietyStore } from '@/stores/society.store';
import { asMemberId, canOnResource, memberSnapshotOf } from '@ses/domain';

import { AmountInput } from '../components/AmountInput';
import { CategoryPicker } from '../components/CategoryPicker';
import { SplitSection } from '../components/SplitSection';
import { VendorField } from '../components/VendorField';
import { useExpense } from '../hooks/use-expense';
import { useExpenseCategoryOptions, useExpensePayerOptions } from '../hooks/use-expenses';
import { useExpenseForm } from '../hooks/useExpenseForm';
import type { ExpenseFormController } from '../hooks/useExpenseForm';
import type { ExpenseSummary } from '../repository/expense.repository';
import { PAYMENT_SOURCE_OPTIONS, todayIsoDate } from '../schemas/expense-form.schemas';

/**
 * The expense form (Roadmap T074, PRD §3.4, PRD screen #27).
 *
 * ## One screen, not a wizard
 *
 * PRD §3.4 is explicit: "a single scrollable screen with a sticky Amount header, not a multi-step
 * wizard — treasurers enter many expenses in a sitting". The amount field therefore sits **above**
 * the `ScrollView` — always visible, and still there while the note fields scroll — and everything
 * else is one column below it.
 *
 * ## Two doors, derived from the route, never from a flag
 *
 * `/expenses/new` creates; `/expenses/[id]/edit` edits. The mode comes from the route alone, so a
 * deep link cannot open an edit form over a row the caller has not been loaded and authorised
 * against — the gate below is evaluated against the row that was actually read.
 *
 * ## The client explains; the server decides
 *
 * `canOnResource` is the same rule the API's `PermissionGuard` and the RLS policies read — never a
 * role string compared inline — and it is an *explanation*: the API refuses the same write
 * underneath whatever this screen renders (SAD §5.5). Published and void expenses are deliberately
 * not editable here: a published edit is T068's recalculation (a diff, a different response shape)
 * and a void is T069's reversal — neither belongs on this form (§15 of the T074 audit).
 */
export default function ExpenseFormScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const expenseId = params.id ?? null;

  if (expenseId === null) {
    return <ExpenseForm mode="create" expense={null} refresh={null} />;
  }
  return <EditExpenseLoader expenseId={expenseId} />;
}

/**
 * The edit door: the row must exist, be in an editable state, and the caller must hold the cell.
 *
 * The loader owns the read so the form is only mounted once its `defaultValues` are known — that is
 * what lets the draft be resolved before the first render instead of being applied over empty
 * fields after it.
 */
function EditExpenseLoader({ expenseId }: { readonly expenseId: string }) {
  const { expense, isLoading, refetch } = useExpense(expenseId);
  const membership = useSocietyStore(selectActiveMembership);

  if (isLoading) {
    return <LoadingIndicator message="Loading expense…" />;
  }

  if (expense === null) {
    return (
      <ErrorScreen
        title="Expense not available"
        description="This expense may belong to another society, or it may have been removed."
        retryLabel="Reload"
        onRetry={refetch}
      />
    );
  }

  if (expense.status !== 'draft' && expense.status !== 'pending_approval') {
    return (
      <ErrorScreen
        title="This expense cannot be edited here"
        description={
          expense.status === 'published'
            ? 'A published expense is changed by recalculating it, which shows what would change before it is written. That flow is not on this screen.'
            : 'A void expense is a historical record. It cannot be edited.'
        }
        retryLabel="Back"
        onRetry={refetch}
      />
    );
  }

  const snapshot = membership === null ? null : memberSnapshotOf(membership);
  const authorized =
    snapshot !== null &&
    canOnResource(snapshot, 'expense.void', {
      kind: 'expense',
      societyId: snapshot.societyId,
      createdByMembershipId: asMemberId(expense.createdBy),
      published: false,
    });

  return (
    <RequirePermission action="expense.void" authorized={authorized}>
      <ExpenseForm mode="edit" expense={expense} refresh={refetch} />
    </RequirePermission>
  );
}

/** The form itself, mounted only once its row (if any) is known. */
function ExpenseForm({
  mode,
  expense,
  refresh,
}: {
  readonly mode: 'create' | 'edit';
  readonly expense: ExpenseSummary | null;
  /** Re-reads the row after a version conflict; `null` while creating. */
  readonly refresh: (() => void) | null;
}) {
  const router = useRouter();
  const membership = useSocietyStore(selectActiveMembership);
  const snapshot = membership === null ? null : memberSnapshotOf(membership);

  const controller = useExpenseForm({
    mode,
    expense,
    onSaved: (saved) => {
      // The server mints the id on create, so the created row is opened by its id; an edit returns
      // to the row it edited. `replace`, so Back does not land on a form that has just been saved.
      router.replace({ pathname: '/(app)/expenses/[id]', params: { id: saved.id } });
    },
    refresh: () => refresh?.(),
  });

  if (mode === 'create') {
    const canCreate =
      snapshot !== null &&
      canOnResource(snapshot, 'expense.create', {
        kind: 'expense',
        societyId: snapshot.societyId,
        createdByMembershipId: null,
        published: false,
      });
    return (
      <RequirePermission action="expense.create" authorized={canCreate}>
        <ExpenseFormBody controller={controller} mode={mode} expenseId={expense?.id ?? null} />
      </RequirePermission>
    );
  }

  return <ExpenseFormBody controller={controller} mode={mode} expenseId={expense?.id ?? null} />;
}

/** The sticky amount header + the scrollable remainder — PRD §3.4's layout, in one place. */
function ExpenseFormBody({
  controller,
  mode,
  expenseId,
}: {
  readonly controller: ExpenseFormController;
  readonly mode: 'create' | 'edit';
  /** The row being edited, or `null` while creating — the split workspace's scope segment. */
  readonly expenseId: string | null;
}) {
  const { form } = controller;
  const { categories, isLoading: categoriesLoading } = useExpenseCategoryOptions();
  const { payers } = useExpensePayerOptions();

  return (
    <View className="flex-1 bg-surface">
      {/*
        `padding` on iOS and `height` on Android: the two platforms report the keyboard
        differently, and this pair is what keeps the submit button above it in both. The scroll
        view keeps tap handling while the keyboard is open (`handled`), so a tap on Save while
        typing is a save rather than a tap that only dismisses the keyboard.
      */}
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
      >
        {/* The sticky amount header — outside the ScrollView, so it cannot scroll away. */}
        <View className="gap-1 border-b border-outline-variant bg-surface px-lg py-3">
          <Controller
            control={form.control}
            name="amount"
            render={({ field, fieldState }) => (
              <AmountInput
                value={field.value}
                onChangeText={field.onChange}
                onAmountChange={controller.setAmountPaise}
                error={fieldState.error?.message}
              />
            )}
          />
          <Text variant="bodySmall" color="outline">
            {controller.lastSavedAt === null
              ? 'Drafts save automatically every few seconds.'
              : 'Draft saved.'}
          </Text>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          <View className="gap-5 p-lg">
            {controller.restoredDraftAt !== null ? (
              <Notice tone="info">
                {`Restored the draft you had started${
                  controller.restoredDraftAt.length === 0
                    ? ''
                    : ` (saved ${controller.restoredDraftAt.slice(0, 10)})`
                }.`}
              </Notice>
            ) : null}
            {controller.ignoredStaleDraft ? (
              <Notice tone="warning">
                {
                  'A saved draft was found, but this expense changed after it was written, so the draft was not restored — the server’s values are shown instead.'
                }
              </Notice>
            ) : null}
            {controller.conflict !== null ? (
              <Notice tone="warning">
                {`Someone changed this expense while you were editing it${
                  controller.conflict.currentVersion === null
                    ? ''
                    : ` (it is now version ${String(controller.conflict.currentVersion)})`
                }. Your typing is still here — choose which version to keep, then save.`}
              </Notice>
            ) : null}
            {controller.notice !== null ? <Notice tone="info">{controller.notice}</Notice> : null}
            {controller.rootError !== null ? (
              <Notice tone="error">{controller.rootError}</Notice>
            ) : null}

            {controller.conflict !== null ? (
              <View className="flex-row flex-wrap gap-2">
                <Button variant="tonal" onPress={controller.useServerVersion}>
                  Use server version
                </Button>
                <Button variant="outlined" onPress={controller.keepMyChanges}>
                  Keep mine
                </Button>
              </View>
            ) : null}

            <Controller
              control={form.control}
              name="title"
              render={({ field, fieldState }) => (
                <TextInput
                  label="Title"
                  value={field.value}
                  variant="outlined"
                  autoCapitalize="sentences"
                  error={fieldState.error !== undefined}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  {...(fieldState.error?.message === undefined
                    ? {}
                    : { helperText: fieldState.error.message })}
                />
              )}
            />

            <Controller
              control={form.control}
              name="categoryId"
              render={({ field, fieldState }) => (
                <CategoryPicker
                  options={categories}
                  value={field.value}
                  onChange={field.onChange}
                  isLoading={categoriesLoading}
                  error={fieldState.error?.message}
                />
              )}
            />

            <Controller
              control={form.control}
              name="expenseDate"
              render={({ field, fieldState }) => (
                <View className="gap-2">
                  <TextInput
                    label="Expense date"
                    value={field.value}
                    variant="outlined"
                    placeholder="YYYY-MM-DD"
                    keyboardType="numbers-and-punctuation"
                    error={fieldState.error !== undefined}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                    {...(fieldState.error?.message === undefined
                      ? {}
                      : { helperText: fieldState.error.message })}
                  />
                  <Button variant="text" onPress={() => field.onChange(todayIsoDate())}>
                    Today
                  </Button>
                </View>
              )}
            />

            <Controller
              control={form.control}
              name="paymentSource"
              render={({ field, fieldState }) => (
                <ChoiceChips
                  label="Paid from"
                  options={PAYMENT_SOURCE_OPTIONS}
                  value={field.value}
                  onChange={field.onChange}
                  error={fieldState.error?.message}
                />
              )}
            />

            <Controller
              control={form.control}
              name="paidByMemberId"
              render={({ field }) => (
                <ChoiceChips
                  label="Paid by (optional)"
                  options={[
                    { value: '', label: 'Not specified' },
                    ...payers.map((payer) => ({ value: payer.id, label: payer.displayName })),
                  ]}
                  value={field.value ?? ''}
                  onChange={(value) => field.onChange(value.length === 0 ? null : value)}
                />
              )}
            />

            <VendorField control={form.control} />

            <SplitSection expenseId={expenseId} />

            <Button
              variant="filled"
              size="lg"
              loading={controller.isSaving}
              onPress={controller.submit}
            >
              {mode === 'create' ? 'Save expense' : 'Save changes'}
            </Button>

            {mode === 'create' ? (
              <Button variant="text" onPress={controller.discardDraft}>
                Discard draft
              </Button>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/** One inline message slot, in the two tones the form needs. */
function Notice({
  tone,
  children,
}: {
  readonly tone: 'info' | 'warning' | 'error';
  readonly children: string;
}) {
  return (
    <Card variant={tone === 'error' ? 'filled' : 'outlined'}>
      <Text variant="bodyMedium" color={tone === 'error' ? 'error' : 'onSurfaceVariant'}>
        {children}
      </Text>
    </Card>
  );
}
