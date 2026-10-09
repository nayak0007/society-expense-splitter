import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';
import { FLOOR_MAX, FLOOR_MIN, WING_NAME_MAX_LENGTH } from '@ses/domain';
import type { OccupancyStatus, ParticipantScope } from '@ses/domain';

import { useExpenseBuildingOptions } from '../hooks/use-expenses';
import { useParticipantRoster } from '../hooks/use-split-preview';
import { useSplitWorkspace } from '../hooks/use-split-config';
import { ensureSplitWorkspace, updateSplitState } from '../services/split-config.store';
import { expenseDraftKey } from '../services/expense-draft.store';
import {
  OCCUPANCY_OPTIONS,
  defaultSelector,
  emptySplitState,
  toParticipantSelectorPayload,
} from '../schemas/split.schemas';
import type { ParticipantSelectorForm } from '../schemas/split.schemas';

/**
 * Participant selector (PRD §3.5.4, PRD screen #30, T075 §7).
 *
 * ## The eight dimensions, edited, never a list of flats
 *
 * The product resolves participants from a **selector**, and this screen edits that
 * selector's dimensions (scope, buildings, wings, floors, occupancy, exclusions,
 * `includeVacant`, `ownerOnly`) — it does not replace the server's resolution with a
 * hand-picked flat list. The full contract payload is preserved
 * (`toParticipantSelectorPayload`); the flat list the treasurer *sees* is the server's
 * own roster (read through the existing preview endpoint with `equal`), so owner-only
 * routing, vacancy and eligibility are the server's answers.
 *
 * ## Wings are a known gap, and are labelled as one
 *
 * There is no `GET /wings` route and the expenses feature holds no apartment read, so
 * wing **labels** cannot be enumerated from existing data. The screen does not invent
 * them: it says so, and lets the treasurer type a wing name (a value they already know),
 * which is the contract's own representation (`wings` are names, matched exactly).
 *
 * ## Returning updates the parent form without a server write
 *
 * Every edit is written to the shared split workspace (keyed by user/society/expense),
 * and Done simply goes back. No expense is created or updated here.
 */
export default function ParticipantSelectorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ expenseId?: string }>();
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const key = expenseDraftKey({ userId, societyId, expenseId: params.expenseId ?? null });

  const workspace = useSplitWorkspace(key);
  // Seed a workspace for a deep link: the selector screen can be a cold entry point.
  useEffect(() => {
    if (key !== null && workspace === null) {
      ensureSplitWorkspace(key, { state: emptySplitState() });
    }
  }, [key, workspace]);

  const selector = workspace?.state.selector ?? defaultSelector();
  const setSelector = (patch: Partial<ParticipantSelectorForm>): void => {
    if (key === null) return;
    updateSplitState(key, { selector: { ...selector, ...patch } });
  };

  const { buildings } = useExpenseBuildingOptions();
  const roster = useParticipantRoster({
    selector: toParticipantSelectorPayload(selector),
    selectorKey: JSON.stringify(toParticipantSelectorPayload(selector)),
    categoryId: workspace?.context.categoryId ?? null,
    enabled: key !== null,
  });

  return (
    <View className="flex-1 bg-surface">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
        <View className="gap-5 p-lg">
          <Text variant="titleMedium">Who is charged</Text>

          <ChoiceChips
            label="Scope"
            options={[
              { value: 'society', label: 'Whole society' },
              { value: 'building', label: 'Selected buildings' },
            ]}
            value={selector.scope}
            onChange={(value) => setSelector({ scope: value as ParticipantScope })}
          />

          <ToggleGroup
            label="Buildings"
            options={buildings.map((building) => ({ value: building.id, label: building.name }))}
            selected={selector.buildings}
            onToggle={(value) => setSelector({ buildings: toggle(selector.buildings, value) })}
            emptyHint="No buildings to choose from."
          />

          <ToggleGroup
            label="Occupancy"
            options={OCCUPANCY_OPTIONS.map((option) => ({ ...option }))}
            selected={selector.occupancy}
            onToggle={(value) =>
              setSelector({ occupancy: toggle(selector.occupancy, value) as OccupancyStatus[] })
            }
            emptyHint=""
          />

          <ChoiceChips
            label="Vacant flats"
            options={[
              { value: 'default', label: 'Society default' },
              { value: 'include', label: 'Include' },
              { value: 'exclude', label: 'Exclude' },
            ]}
            value={
              selector.includeVacant === null
                ? 'default'
                : selector.includeVacant
                  ? 'include'
                  : 'exclude'
            }
            onChange={(value) =>
              setSelector({
                includeVacant: value === 'default' ? null : value === 'include',
              })
            }
          />

          <ChoiceChips
            label="Owner only"
            options={[
              { value: 'no', label: 'Owner and tenant' },
              { value: 'yes', label: 'Owner only' },
            ]}
            value={selector.ownerOnly ? 'yes' : 'no'}
            onChange={(value) => setSelector({ ownerOnly: value === 'yes' })}
          />

          <FloorRange floors={selector.floors} onChange={(floors) => setSelector({ floors })} />

          <WingEntry wings={selector.wings} onChange={(wings) => setSelector({ wings })} />

          <View className="gap-2">
            <Text variant="titleSmall">Excluded flats</Text>
            {roster.isLoading ? (
              <Text variant="bodySmall" color="onSurfaceVariant">
                Loading the participant list…
              </Text>
            ) : roster.error !== null ? (
              <Text variant="bodySmall" color="error">
                {roster.error}
              </Text>
            ) : roster.roster.length === 0 ? (
              <Text variant="bodySmall" color="onSurfaceVariant">
                No flats match this selection.
              </Text>
            ) : (
              <View className="gap-2">
                {roster.roster.map((participant) => {
                  const excluded = selector.excludeApartments.includes(participant.apartmentId);
                  return (
                    <Pressable
                      key={participant.apartmentId}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: excluded }}
                      accessibilityLabel={`${excluded ? 'Include' : 'Exclude'} ${participant.apartmentNumber}`}
                      onPress={() =>
                        setSelector({
                          excludeApartments: toggle(
                            selector.excludeApartments,
                            participant.apartmentId,
                          ),
                        })
                      }
                      className="flex-row items-center justify-between rounded-md border border-outline-variant px-3 py-2"
                    >
                      <Text variant="bodyMedium">{participant.apartmentNumber}</Text>
                      <Text variant="labelMedium" color={excluded ? 'error' : 'onSurfaceVariant'}>
                        {excluded ? 'Excluded' : 'Charged'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <Button variant="filled" size="lg" onPress={() => router.back()}>
            Done
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}

/** Add/remove a value from a readonly string array. */
function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/** A multi-select chip group — `ChoiceChips` is single-select, and this screen needs many. */
function ToggleGroup({
  label,
  options,
  selected,
  onToggle,
  emptyHint,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly selected: readonly string[];
  onToggle: (value: string) => void;
  readonly emptyHint: string;
}) {
  return (
    <View className="gap-1">
      <Text variant="bodySmall" color="onSurfaceVariant">
        {label}
      </Text>
      {options.length === 0 ? (
        <Text variant="bodySmall" color="onSurfaceVariant">
          {emptyHint}
        </Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {options.map((option) => {
            const isSelected = selected.includes(option.value);
            return (
              <Pressable
                key={option.value}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={option.label}
                onPress={() => onToggle(option.value)}
                className={
                  isSelected
                    ? 'rounded-full border border-primary bg-secondary-container px-4 py-2'
                    : 'rounded-full border border-outline-variant bg-surface px-4 py-2'
                }
              >
                <Text
                  variant="labelLarge"
                  color={isSelected ? 'onSecondaryContainer' : 'onSurfaceVariant'}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** An inclusive floor range → the selector's `floors` array, bounded by the domain's own limits. */
function FloorRange({
  floors,
  onChange,
}: {
  readonly floors: readonly number[];
  onChange: (floors: number[]) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const apply = (): void => {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return;
    const lower = Math.max(FLOOR_MIN, start);
    const upper = Math.min(FLOOR_MAX, end);
    const next: number[] = [];
    for (let floor = lower; floor <= upper; floor += 1) next.push(floor);
    onChange(next);
  };

  return (
    <View className="gap-2">
      <Text variant="titleSmall">Floors</Text>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextInput
            label="From"
            value={from}
            variant="outlined"
            keyboardType="numeric"
            onChangeText={setFrom}
            testID="floor-from"
          />
        </View>
        <View className="flex-1">
          <TextInput
            label="To"
            value={to}
            variant="outlined"
            keyboardType="numeric"
            onChangeText={setTo}
            testID="floor-to"
          />
        </View>
      </View>
      <View className="flex-row gap-2">
        <Button variant="outlined" size="sm" onPress={apply}>
          Apply range
        </Button>
        {floors.length > 0 ? (
          <Button variant="text" size="sm" onPress={() => onChange([])}>
            {`Clear (${String(floors.length)})`}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

/** Wing labels, typed rather than enumerated — the missing-capability note lives here. */
function WingEntry({
  wings,
  onChange,
}: {
  readonly wings: readonly string[];
  onChange: (wings: readonly string[]) => void;
}) {
  const [draft, setDraft] = useState('');

  const add = (): void => {
    const label = draft.trim();
    if (label.length === 0 || label.length > WING_NAME_MAX_LENGTH || wings.includes(label)) return;
    onChange([...wings, label]);
    setDraft('');
  };

  return (
    <View className="gap-2">
      <Text variant="titleSmall">Wings</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        Wing names must be typed — the app has no wing list to read from yet, so labels cannot be
        suggested. They are matched exactly against each building&rsquo;s wings on the server.
      </Text>
      {wings.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {wings.map((wing) => (
            <Pressable
              key={wing}
              accessibilityRole="button"
              accessibilityLabel={`Remove wing ${wing}`}
              onPress={() => onChange(wings.filter((entry) => entry !== wing))}
              className="rounded-full border border-outline-variant bg-surface px-4 py-2"
            >
              <Text variant="labelLarge" color="onSurfaceVariant">{`${wing} ✕`}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View className="flex-row items-end gap-2">
        <View className="flex-1">
          <TextInput
            label="Add a wing"
            value={draft}
            variant="outlined"
            maxLength={WING_NAME_MAX_LENGTH}
            onChangeText={setDraft}
            testID="wing-draft"
          />
        </View>
        <Button variant="outlined" onPress={add}>
          Add
        </Button>
      </View>
    </View>
  );
}
