import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

import type { RosterEntry } from '../hooks/use-split-preview';
import { parseShareText } from '../schemas/split.schemas';

import { ParticipantValueRow } from './ParticipantValueRow';

/**
 * Shares editor (PRD §3.5.3, T075 §8).
 *
 * A share is a weight, not money: each flat's field holds `integer or decimal share
 * units`, and the engine turns them into amounts by dividing once in integers. The
 * field's scale is the column's own — thousandths of a share (`1.5` is `1500`), the
 * `apartments.share_units numeric(8, 3)` scale — and a value outside the engine's
 * `MAX_SHARE_UNITS` ceiling, a zero or a negative is refused here with a sentence rather
 * than sent to be refused after a round trip.
 *
 * A flat with **no entry** falls back to its stored `share_units`, which is exactly what
 * the server does when the client omits it (the API's `buildSplitInput`), so leaving the
 * field blank is a real choice — "use this flat's share" — not an unfinished form.
 */
export interface SharesEditorProps {
  readonly roster: readonly RosterEntry[];
  readonly values: Readonly<Record<string, string>>;
  onChange: (apartmentId: string, text: string) => void;
}

/** Why a share entry is invalid, or `null` — shared by the field and the save gate. */
export function shareEntryProblem(text: string): string | null {
  if (text.trim().length === 0) return null; // blank = the flat's stored share_units
  const parsed = parseShareText(text);
  if (parsed === null) return 'Enter shares like 1.5';
  if (parsed <= 0) return 'A share must be greater than zero';
  return null;
}

export function SharesEditor({ roster, values, onChange }: SharesEditorProps) {
  return (
    <View className="gap-3">
      <Text variant="titleSmall">Shares per flat</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        Leave a field blank to use the flat&rsquo;s recorded share units.
      </Text>

      <View className="gap-3">
        {roster.map((participant) => {
          const value = values[participant.apartmentId] ?? '';
          const problem = shareEntryProblem(value);
          return (
            <ParticipantValueRow
              key={participant.apartmentId}
              apartmentNumber={participant.apartmentNumber}
              value={value}
              placeholder="1"
              error={problem ?? undefined}
              onChangeText={(text) => onChange(participant.apartmentId, text)}
              testID={`share-${participant.apartmentId}`}
            />
          );
        })}
      </View>
    </View>
  );
}
