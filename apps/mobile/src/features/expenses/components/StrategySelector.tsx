import { View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { Text } from '@/components/ui/Text';
import type { ApartmentBasis, SplitStrategy } from '@ses/domain';

import { APARTMENT_BASIS_OPTIONS, SPLIT_STRATEGY_OPTIONS } from '../schemas/split.schemas';

/**
 * Strategy + apartment-basis selection (PRD §3.5, T075 §3).
 *
 * The five strategies are the `SPLIT_STRATEGIES` enum's own arms, rendered from
 * `SPLIT_STRATEGY_OPTIONS`; the basis chips appear **only** when `apartment` is chosen,
 * because a basis beside any other strategy is dropped by the server (`resolveSplitPlan`)
 * and offering one would be inviting a control that does nothing. `occupied_only` is
 * deliberately absent: it is not in the `apartment_basis` enum and is a participation
 * question the selector owns, not a basis (`split-vocabulary.ts`).
 */
export interface StrategySelectorProps {
  readonly strategy: SplitStrategy;
  readonly basis: ApartmentBasis | null;
  onChangeStrategy: (strategy: SplitStrategy) => void;
  onChangeBasis: (basis: ApartmentBasis) => void;
}

export function StrategySelector({
  strategy,
  basis,
  onChangeStrategy,
  onChangeBasis,
}: StrategySelectorProps) {
  // `ChoiceChips` is single-select; the values are the enum's own, so a chip cannot offer
  // a strategy the engine does not implement.
  const strategyOptions = SPLIT_STRATEGY_OPTIONS.map((option) => ({ ...option }));

  return (
    <View className="gap-4">
      <ChoiceChips
        label="Split method"
        options={strategyOptions}
        value={strategy}
        onChange={onChangeStrategy}
      />

      {strategy === 'apartment' ? (
        <View className="gap-1">
          <ChoiceChips
            label="Weight flats by"
            options={APARTMENT_BASIS_OPTIONS.map((option) => ({ ...option }))}
            value={basis ?? 'per_flat'}
            onChange={onChangeBasis}
          />
          <Text variant="bodySmall" color="onSurfaceVariant">
            Flats missing the chosen attribute are left out and reported as a warning.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
