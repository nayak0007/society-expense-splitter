import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';
import type { ApartmentBasis, SplitStrategy } from '@ses/domain';

import { CustomAmountEditor } from '../components/CustomAmountEditor';
import { FloorBandEditor } from '../components/FloorBandEditor';
import { PercentageEditor } from '../components/PercentageEditor';
import { SharesEditor } from '../components/SharesEditor';
import { StrategySelector } from '../components/StrategySelector';
import { SplitTable } from '../components/SplitTable';
import { useSplitWorkspace } from '../hooks/use-split-config';
import { useParticipantRoster, useSplitPreview } from '../hooks/use-split-preview';
import type { ExpenseSplitView } from '../repository/expense.repository';
import { expenseDraftKey } from '../services/expense-draft.store';
import { ensureSplitWorkspace, updateSplitState } from '../services/split-config.store';
import {
  APARTMENT_BASIS_LABELS,
  SPLIT_STRATEGY_LABELS,
  customRemainderPaise,
  emptySplitState,
  percentageTotalBasisPoints,
  percentageTotalOk,
  pruneSplitConfig,
  splitStateProblem,
  toParticipantSelectorPayload,
  toSplitConfigPayload,
} from '../schemas/split.schemas';
import type { FloorBandForm, SplitFormState } from '../schemas/split.schemas';

/**
 * The split configurator (PRD §3.5, PRD screen #29, T075 §3–§5, §12).
 *
 * ## State lives in the shared workspace, not in the route
 *
 * Everything the treasurer edits lives in the module-level split workspace keyed by
 * user/society/expense, so returning to the parent form (or opening the participant
 * selector and coming back) carries the configuration without a server write and
 * without a large payload through a deep-link URL. The parent form publishes the amount
 * and category through the same workspace, which is where the preview's input comes from.
 *
 * ## The live preview is the server's, or the engine's, never this file's
 *
 * The allocation shown is the preview endpoint's answer (or, offline and only with an
 * exact held snapshot, the shared engine's — see `useSplitPreview`). This screen owns no
 * arithmetic beyond the two integers a treasurer reads: the percentage total and the
 * custom remainder, both computed in `split.schemas.ts`.
 *
 * ## Save is a client explanation; the server still decides
 *
 * `splitStateProblem` blocks Save until the configuration is coherent (percentages to
 * 100%, the custom remainder to exactly ₹0, bands non-overlapping) — an *explanation* of
 * the same rules the engine enforces when the expense is written. Save writes the
 * workspace and returns; it never touches the network.
 */
export default function SplitConfiguratorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ expenseId?: string }>();
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const key = expenseDraftKey({ userId, societyId, expenseId: params.expenseId ?? null });

  const workspace = useSplitWorkspace(key);

  useEffect(() => {
    if (key !== null && workspace === null) {
      ensureSplitWorkspace(key, { state: emptySplitState() });
    }
  }, [key, workspace]);

  const state = workspace?.state ?? emptySplitState();
  const context = workspace?.context ?? {
    amountPaise: null,
    categoryId: null,
    defaultStrategy: null,
  };
  const amountPaise = context.amountPaise;

  const patchState = (patch: Partial<SplitFormState>): void => {
    if (key === null) return;
    updateSplitState(key, patch);
  };

  const onConfigChange = (
    field: 'percentages' | 'shares' | 'customAmounts',
    apartmentId: string,
    text: string,
  ): void => {
    patchState({ [field]: { ...state[field], [apartmentId]: text } } as Partial<SplitFormState>);
  };

  const selectorPayload = toParticipantSelectorPayload(state.selector);
  const selectorKey = JSON.stringify(selectorPayload);

  const roster = useParticipantRoster({
    selector: selectorPayload,
    selectorKey,
    categoryId: context.categoryId,
    enabled: key !== null,
  });

  const rosterIds =
    roster.roster.length === 0 ? null : roster.roster.map((entry) => entry.apartmentId);

  const preview = useSplitPreview({
    amountPaise,
    categoryId: context.categoryId,
    plan: { strategy: state.strategy, basis: state.strategy === 'apartment' ? state.basis : null },
    config: toSplitConfigPayload(state, rosterIds),
    selector: selectorPayload,
    selectorKey,
    enabled: key !== null,
  });

  const problem = splitStateProblem(state, amountPaise);
  const previewSplits: ExpenseSplitView[] = (preview.preview?.allocations ?? []).map(
    (allocation) => ({
      id: allocation.apartmentId,
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      amountPaise: allocation.amountPaise,
      weight: String(allocation.weight),
      percent: null,
      assignedReason: null,
      memberName: null,
      apartmentNumber: allocation.apartmentNumber,
    }),
  );

  return (
    <View className="flex-1 bg-surface">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
        <View className="gap-5 p-lg">
          <Card variant="outlined">
            <Text variant="bodyMedium">
              {`${SPLIT_STRATEGY_LABELS[state.strategy]}${
                state.strategy === 'apartment' && state.basis !== null
                  ? ` · ${APARTMENT_BASIS_LABELS[state.basis]}`
                  : ''
              }`}
            </Text>
          </Card>

          <StrategySelector
            strategy={state.strategy}
            basis={state.basis}
            onChangeStrategy={(strategy: SplitStrategy) =>
              patchState({
                strategy,
                customized: true,
                ...(strategy === 'apartment' && state.basis === null
                  ? { basis: 'per_flat' as ApartmentBasis }
                  : {}),
              })
            }
            onChangeBasis={(basis: ApartmentBasis) => patchState({ basis, customized: true })}
          />

          <Card variant="outlined">
            <View className="flex-row items-center justify-between">
              <Text variant="titleSmall">Participants</Text>
              <Button
                variant="text"
                size="sm"
                onPress={() =>
                  router.push({
                    pathname: '/(app)/expenses/participants',
                    params: params.expenseId === undefined ? {} : { expenseId: params.expenseId },
                  })
                }
              >
                Edit selection
              </Button>
            </View>
            <Text variant="bodySmall" color="onSurfaceVariant">
              {roster.isLoading
                ? 'Resolving participants…'
                : `${String(roster.roster.length)} flat${roster.roster.length === 1 ? '' : 's'} matched`}
            </Text>
          </Card>

          {state.strategy === 'percentage' ? (
            <PercentageEditor
              roster={roster.roster}
              values={state.percentages}
              totalBasisPoints={percentageTotalBasisPoints(state)}
              totalOk={percentageTotalOk(state)}
              onChange={(id, text) => onConfigChange('percentages', id, text)}
            />
          ) : null}

          {state.strategy === 'shares' ? (
            <SharesEditor
              roster={roster.roster}
              values={state.shares}
              onChange={(id, text) => onConfigChange('shares', id, text)}
            />
          ) : null}

          {state.strategy === 'custom' ? (
            <CustomAmountEditor
              roster={roster.roster}
              values={state.customAmounts}
              amountPaise={amountPaise}
              remainderPaise={customRemainderPaise(state, amountPaise)}
              onChange={(id, text) => onConfigChange('customAmounts', id, text)}
            />
          ) : null}

          {state.strategy === 'apartment' && state.basis === 'per_floor_band' ? (
            <FloorBandEditor
              bands={state.floorBands}
              onChange={(bands: readonly FloorBandForm[]) => patchState({ floorBands: bands })}
            />
          ) : null}

          {amountPaise === null ? (
            <Notice tone="warning">
              Enter an amount on the expense form first — the preview needs it.
            </Notice>
          ) : null}

          {preview.error !== null ? <Notice tone="error">{preview.error}</Notice> : null}
          {preview.offlineNotice !== null ? (
            <Notice tone="warning">{preview.offlineNotice}</Notice>
          ) : null}
          {preview.stale && preview.preview !== null ? (
            <Text variant="bodySmall" color="onSurfaceVariant">
              Refreshing the preview…
            </Text>
          ) : null}

          {preview.preview !== null ? (
            <Card variant="outlined">
              <View className="gap-3">
                <Text variant="titleSmall">Preview</Text>
                <SplitTable splits={previewSplits} amountPaise={amountPaise} />
              </View>
            </Card>
          ) : null}

          {preview.preview !== null && preview.preview.warnings.length > 0 ? (
            <Card variant="outlined">
              <View className="gap-2">
                <Text variant="titleSmall">Warnings</Text>
                {preview.preview.warnings.map((warning) => (
                  <Text key={warning.code} variant="bodySmall" color="warning">
                    {`${warning.code}: ${warning.message}`}
                  </Text>
                ))}
              </View>
            </Card>
          ) : null}

          {preview.preview !== null && preview.preview.unassigned.length > 0 ? (
            <Card variant="outlined">
              <View className="gap-2">
                <Text variant="titleSmall">Unassigned flats</Text>
                {preview.preview.unassigned.map((entry) => (
                  <Text key={entry.apartmentId} variant="bodySmall" color="onSurfaceVariant">
                    {`${entry.apartmentNumber} — ${entry.reason === 'unassigned_no_owner' ? 'no owner on record' : 'no member to charge'}`}
                  </Text>
                ))}
              </View>
            </Card>
          ) : null}

          {problem !== null ? <Notice tone="error">{problem}</Notice> : null}

          <Button
            variant="filled"
            size="lg"
            disabled={problem !== null || amountPaise === null}
            onPress={() => {
              // Prune entries for flats the current resolution no longer charges, so the payload
              // the form submits matches the one the preview priced; then simply return, with no
              // server write (T075 §2).
              if (key !== null && rosterIds !== null) {
                updateSplitState(key, pruneSplitConfig(state, rosterIds));
              }
              router.back();
            }}
          >
            Done
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}

function Notice({
  tone,
  children,
}: {
  readonly tone: 'warning' | 'error';
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
