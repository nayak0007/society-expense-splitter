import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { useSplitWorkspace } from '../hooks/use-split-config';
import { expenseDraftKey } from '../services/expense-draft.store';
import {
  APARTMENT_BASIS_LABELS,
  SPLIT_STRATEGY_LABELS,
  summaryLine,
} from '../schemas/split.schemas';

/**
 * The split entry point on the expense form (T075 §2, §12).
 *
 * It shows what the current split *is* — the strategy and, for an apartment split, the basis —
 * and opens the configurator and the participant selector. The configuration itself lives in
 * the shared split workspace (keyed by user/society/expense), so the pushed routes read and
 * write the same state and nothing travels through the URL; returning re-renders this summary
 * through `useSplitWorkspace`.
 *
 * `expenseId` is `null` while creating, which is the third segment of the scope key — a create
 * session and an edit session therefore never share configuration.
 */
export interface SplitSectionProps {
  readonly expenseId: string | null;
}

export function SplitSection({ expenseId }: SplitSectionProps) {
  const router = useRouter();
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const key = expenseDraftKey({ userId, societyId, expenseId });
  const workspace = useSplitWorkspace(key);

  const state = workspace?.state ?? null;
  const params = expenseId === null ? {} : { expenseId };

  return (
    <Card variant="outlined">
      <View className="gap-3">
        <View className="gap-1">
          <Text variant="titleSmall">Split</Text>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            {state === null
              ? 'Default split — every eligible flat, weighted equally.'
              : summaryLine(state)}
          </Text>
          {state !== null ? (
            <Text variant="bodySmall" color="outline">
              {`Method: ${SPLIT_STRATEGY_LABELS[state.strategy]}${
                state.strategy === 'apartment' && state.basis !== null
                  ? ` · ${APARTMENT_BASIS_LABELS[state.basis]}`
                  : ''
              }`}
            </Text>
          ) : null}
        </View>

        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="tonal"
            onPress={() => router.push({ pathname: '/(app)/expenses/split', params })}
          >
            Edit split
          </Button>
          <Button
            variant="outlined"
            onPress={() => router.push({ pathname: '/(app)/expenses/participants', params })}
          >
            Choose participants
          </Button>
        </View>
      </View>
    </Card>
  );
}
