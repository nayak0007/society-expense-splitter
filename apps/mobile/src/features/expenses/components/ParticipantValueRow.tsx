import { View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

/**
 * One row of a per-participant editor — the flat on the left, its value field below.
 *
 * Extracted so the percentage, shares and custom editors cannot drift in how a row is
 * labelled or how an error is shown: they differ only in what the field means, and a
 * second copy of this layout is how one editor ends up labelling a flat differently
 * from another. The `label` is both the visible flat number and the input's
 * accessibility label (the ui `TextInput` wires those together), so a screen reader
 * hears "A-101, 33.33" rather than an unlabelled box.
 */
export interface ParticipantValueRowProps {
  /** The flat's number — the row's visible heading and the field's a11y label. */
  readonly apartmentNumber: string;
  /** The member the charge is addressed to, when known — shown beneath the heading. */
  readonly memberName?: string | undefined;
  readonly value: string;
  readonly placeholder?: string;
  readonly keyboardType?: 'numeric' | 'decimal-pad' | 'number-pad';
  readonly error?: string | undefined;
  onChangeText: (text: string) => void;
  onBlur?: () => void;
  readonly testID?: string;
}

export function ParticipantValueRow({
  apartmentNumber,
  memberName,
  value,
  placeholder,
  keyboardType = 'decimal-pad',
  error,
  onChangeText,
  onBlur,
  testID,
}: ParticipantValueRowProps) {
  return (
    <View className="gap-1">
      <TextInput
        label={apartmentNumber}
        value={value}
        variant="outlined"
        placeholder={placeholder}
        keyboardType={keyboardType}
        error={error !== undefined}
        onChangeText={onChangeText}
        {...(onBlur === undefined ? {} : { onBlur })}
        {...(error === undefined ? {} : { helperText: error })}
        {...(testID === undefined ? {} : { testID })}
      />
      {memberName !== undefined && memberName.length > 0 ? (
        <Text variant="bodySmall" color="onSurfaceVariant">
          {memberName}
        </Text>
      ) : null}
    </View>
  );
}
