import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/Text';

/**
 * Single-select chip row — the non-text-input fields (society type, occupancy)
 * use this instead of a native picker: fewer taps, works offline, and keeps
 * every choice visible rather than hidden behind a modal.
 */
export interface ChoiceOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

export interface ChoiceChipsProps<TValue extends string> {
  /** Accessible group label, e.g. "Society type". */
  readonly label: string;
  readonly options: readonly ChoiceOption<TValue>[];
  readonly value: TValue;
  onChange: (value: TValue) => void;
  readonly error?: string | undefined;
}

export function ChoiceChips<TValue extends string>({
  label,
  options,
  value,
  onChange,
  error,
}: ChoiceChipsProps<TValue>) {
  return (
    <View className="gap-1">
      <Text variant="bodySmall" color={error === undefined ? 'onSurfaceVariant' : 'error'}>
        {label}
      </Text>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              onPress={() => onChange(option.value)}
              className={
                selected
                  ? 'rounded-full border border-primary bg-secondary-container px-4 py-2'
                  : 'rounded-full border border-outline-variant bg-surface px-4 py-2'
              }
            >
              <Text
                variant="labelLarge"
                color={selected ? 'onSecondaryContainer' : 'onSurfaceVariant'}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error !== undefined ? (
        <Text variant="bodySmall" color="error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
