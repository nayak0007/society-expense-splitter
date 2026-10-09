import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

import { floorBandProblem, floorBandsProblem } from '../schemas/split.schemas';
import type { FloorBandForm } from '../schemas/split.schemas';

/**
 * Floor-band editor (PRD §3.5.4, T075 §8).
 *
 * A band is an inclusive floor range and a multiplier. The table is validated **as a
 * whole** — `floorBandsProblem` — and the rule is the engine's own: ordered ranges with
 * no two overlapping or even touching (a band ending at 4 and another starting at 4 both
 * match a floor-4 flat, so which applies would depend on order). The error is shown
 * against the offending band, and the message names the floor, so the treasurer can fix
 * the table before it reaches the server's identical refusal.
 *
 * A multiplier of `0` is **legal and means exempt** — a ground-floor flat in a lift
 * charge pays ₹0 and still appears in the split — so the editor accepts `0` and never
 * treats it as "empty".
 */
export interface FloorBandEditorProps {
  readonly bands: readonly FloorBandForm[];
  onChange: (bands: readonly FloorBandForm[]) => void;
}

export function FloorBandEditor({ bands, onChange }: FloorBandEditorProps) {
  const tableProblem = floorBandsProblem(bands);

  const replace = (index: number, patch: Partial<FloorBandForm>): void => {
    onChange(bands.map((band, position) => (position === index ? { ...band, ...patch } : band)));
  };

  const remove = (index: number): void => {
    onChange(bands.filter((_, position) => position !== index));
  };

  const add = (): void => {
    const last = bands[bands.length - 1];
    const nextFrom = last === undefined ? 0 : Number(last.to) + 1;
    onChange([...bands, { from: String(nextFrom), to: String(nextFrom), mult: '1' }]);
  };

  return (
    <View className="gap-3">
      <Text variant="titleSmall">Floor bands</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        Bands are inclusive and must not overlap or touch. A multiplier of 0 exempts the floor (₹0,
        still listed).
      </Text>

      {bands.map((band, index) => {
        const problem = floorBandProblem(band);
        return (
          <View key={index} className="gap-2 rounded-md border border-outline-variant p-3">
            <View className="flex-row gap-2">
              <View className="flex-1">
                <TextInput
                  label="From floor"
                  value={band.from}
                  variant="outlined"
                  keyboardType="numeric"
                  error={problem !== null}
                  onChangeText={(text) => replace(index, { from: text })}
                  testID={`band-from-${String(index)}`}
                />
              </View>
              <View className="flex-1">
                <TextInput
                  label="To floor"
                  value={band.to}
                  variant="outlined"
                  keyboardType="numeric"
                  error={problem !== null}
                  onChangeText={(text) => replace(index, { to: text })}
                  testID={`band-to-${String(index)}`}
                />
              </View>
              <View className="flex-1">
                <TextInput
                  label="Multiply"
                  value={band.mult}
                  variant="outlined"
                  keyboardType="decimal-pad"
                  error={problem !== null}
                  onChangeText={(text) => replace(index, { mult: text })}
                  testID={`band-mult-${String(index)}`}
                />
              </View>
            </View>
            {problem !== null ? (
              <Text variant="bodySmall" color="error">
                {problem}
              </Text>
            ) : null}
            <Button variant="text" size="sm" onPress={() => remove(index)}>
              Remove band
            </Button>
          </View>
        );
      })}

      {tableProblem !== null ? (
        <Text variant="bodySmall" color="error">
          {tableProblem}
        </Text>
      ) : null}

      <Button variant="outlined" onPress={add}>
        Add band
      </Button>
    </View>
  );
}
