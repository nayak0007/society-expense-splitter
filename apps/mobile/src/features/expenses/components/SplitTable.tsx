import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

import type { ExpenseSplitView } from '../repository/expense.repository';
import { formatPaise } from '../schemas/expense.schemas';

/**
 * The split table (PRD §3.5.3): who owes what for this bill.
 *
 * ## The rows are the server's, and the total is their sum
 *
 * Each `amountPaise` is read verbatim from `expense_splits`; the total is the **sum of the
 * rows rendered**, computed in `BigInt` so a large society total cannot drift. The table
 * never re-derives a share from a percentage or a weight — a displayed split that disagreed
 * with what was charged is the exact failure the API's read-only port and its conservation
 * trigger exist to prevent (see `GET /expenses/:expenseId/splits`).
 *
 * ## The conservation line is shown, not assumed
 *
 * When the expense's amount is known the footer states whether the rows reconcile with it.
 * The database guarantees they do (`chk_split_total()`), so a mismatch is a genuine bug
 * rather than an expected state — surfacing it is the cheapest possible detection, and it is
 * deliberately passive (a sentence, never a crash or a silent clamp).
 *
 * ## Compact rows for a narrow screen
 *
 * Two columns — the flat/member on the left, the amount right-aligned — rather than a wide
 * grid, because a resident reads this on a phone. A `Unassigned` row (no member, no flat) is
 * rendered as itself rather than dropped: it is the Treasurer's follow-up case, and hiding it
 * would make the table's total disagree with the bill.
 */
export interface SplitTableProps {
  readonly splits: readonly ExpenseSplitView[];
  /** The expense's amount, for the reconciliation footer. `null`/absent hides the footer. */
  readonly amountPaise?: number | null;
}

export function SplitTable({ splits, amountPaise = null }: SplitTableProps) {
  if (splits.length === 0) {
    return (
      <Text variant="bodyMedium" color="onSurfaceVariant">
        This expense has not been split yet.
      </Text>
    );
  }

  const total = splits.reduce((sum, split) => sum + BigInt(split.amountPaise), 0n);
  const reconciles = amountPaise === null || BigInt(amountPaise) === total;

  return (
    <View className="gap-2">
      <View className="flex-row justify-between border-b border-outline-variant pb-1">
        <Text variant="labelMedium" color="onSurfaceVariant">
          Flat / member
        </Text>
        <Text variant="labelMedium" color="onSurfaceVariant">
          Amount
        </Text>
      </View>

      {splits.map((split) => (
        <View key={split.id} className="flex-row items-start justify-between gap-3">
          <View className="flex-1">
            <Text variant="bodyMedium">{primaryLabel(split)}</Text>
            <Text variant="bodySmall" color="onSurfaceVariant">
              {secondaryLabel(split)}
            </Text>
          </View>
          <Text variant="bodyMedium">{formatPaise(split.amountPaise)}</Text>
        </View>
      ))}

      <View className="mt-1 flex-row justify-between border-t border-outline-variant pt-2">
        <Text variant="titleSmall">{`Total · ${String(splits.length)} flat${splits.length === 1 ? '' : 's'}`}</Text>
        <Text variant="titleSmall">{formatPaise(total)}</Text>
      </View>

      {!reconciles ? (
        <Text variant="bodySmall" color="error">
          {`The rows total ${formatPaise(total)}, which does not match the bill's ${formatPaise(
            amountPaise ?? 0,
          )}. Please report this.`}
        </Text>
      ) : null}
    </View>
  );
}

/** The flat number, the member's name, or `Unassigned` — never an empty line. */
function primaryLabel(split: ExpenseSplitView): string {
  if (split.apartmentNumber !== null && split.apartmentNumber.length > 0) {
    return split.apartmentNumber;
  }
  if (split.memberName !== null && split.memberName.length > 0) return split.memberName;
  return 'Unassigned';
}

/** The member beside the flat, or the reason there is none. */
function secondaryLabel(split: ExpenseSplitView): string {
  if (split.memberName !== null && split.memberName.length > 0) {
    return split.memberName;
  }
  return 'No member assigned';
}
