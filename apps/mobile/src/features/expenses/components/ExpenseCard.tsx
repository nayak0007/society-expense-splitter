import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

import type { ExpenseSummary } from '../repository/expense.repository';
import {
  EXPENSE_STATUS_LABELS,
  EXPENSE_STATUS_TONES,
  formatExpenseDate,
  formatPaise,
} from '../schemas/expense.schemas';

/**
 * One expense row (PRD §3.5.3's list): the amount, the title, when, its category and its
 * status — the five facts a resident scans a ledger for.
 *
 * ## Money is formatted from integer paise, never a float
 *
 * `formatPaise` is the only place the amount becomes text, and it works on `BigInt` digits
 * (see the schema's note) — so the figure on the card is the stored figure, correctly grouped
 * for an Indian reader (`₹1,23,456.78`).
 *
 * ## The edited chip is a fact, not a guess
 *
 * `version > 1` means the row has been written more than once, which is exactly what the
 * server's optimistic lock counts. The chip is presentational — the history itself is behind
 * the detail screen's `RevisionChip` — so the list can say "Edited" without a second request.
 *
 * ## No flat, no vendor, no description renders as itself
 *
 * A missing vendor or description is simply omitted; there is nothing ambiguous about an
 * expense without a vendor. The amount and the title are never omitted — they are the row.
 */
export interface ExpenseCardProps {
  readonly expense: ExpenseSummary;
  /** Resolved category label, or `null` when the category map has not loaded. */
  readonly categoryName?: string | null;
  onPress?: (() => void) | undefined;
}

export function ExpenseCard({ expense, categoryName = null, onPress }: ExpenseCardProps) {
  return (
    <Card variant="filled" onPress={onPress}>
      <View className="gap-2">
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1 gap-1">
            <Text variant="titleMedium" numberOfLines={1}>
              {expense.title}
            </Text>
            <Text variant="bodySmall" color="onSurfaceVariant">
              {[formatExpenseDate(expense.expenseDate), categoryName, expense.vendorName]
                .filter((part): part is string => part !== null && part.length > 0)
                .join(' · ')}
            </Text>
          </View>
          <Text variant="titleMedium">{formatPaise(expense.amountPaise)}</Text>
        </View>

        <View className="flex-row flex-wrap gap-2">
          <StatusBadge status={expense.status} />
          {expense.version > 1 ? <Badge label={`Edited · v${expense.version}`} /> : null}
        </View>
      </View>
    </Card>
  );
}

/** The lifecycle status — text as well as tone, so it is not colour-only. */
export function StatusBadge({ status }: { readonly status: ExpenseSummary['status'] }) {
  const tone = EXPENSE_STATUS_TONES[status];
  return <Badge label={EXPENSE_STATUS_LABELS[status]} tone={tone} />;
}

function Badge({
  label,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly tone?: 'neutral' | 'attention' | 'done';
}) {
  const container =
    tone === 'attention'
      ? 'rounded-full bg-error-container px-3 py-1'
      : tone === 'done'
        ? 'rounded-full bg-success-container px-3 py-1'
        : 'rounded-full bg-surface-variant px-3 py-1';
  const color =
    tone === 'attention'
      ? 'onErrorContainer'
      : tone === 'done'
        ? 'onSuccessContainer'
        : 'onSurfaceVariant';

  return (
    <View className={container}>
      <Text variant="labelSmall" color={color}>
        {label}
      </Text>
    </View>
  );
}
