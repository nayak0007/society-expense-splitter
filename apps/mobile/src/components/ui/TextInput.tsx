import { forwardRef } from 'react';
import type {
  TextInput as RNTextInputType,
  TextInputProps as RNTextInputProps,
} from 'react-native';
import { Text as RNText, TextInput as RNTextInput, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

/**
 * MD3 Text field (m3.material.io/components/text-fields) — filled and
 * outlined styles. The label sits above the input (MD3's floating label
 * collapses to this on focus in the reference impl); error and helper text
 * render in the MD3 supporting-text slot below the field. The label doubles
 * as the accessibility label for screen readers.
 */

export type TextInputVariant = 'filled' | 'outlined';

export interface TextInputProps extends RNTextInputProps {
  /** Label; also the a11y label. */
  readonly label: string;
  readonly variant?: TextInputVariant;
  /** Supporting text below the field (MD3 helper or error message). */
  readonly helperText?: string;
  /** Error pairing: error border + error supporting text. */
  readonly error?: boolean;
}

const VARIANT_CLASSES: Record<TextInputVariant, { box: string; label: string }> = {
  filled: {
    box: 'rounded-t-token border-b border-on-surface-variant bg-surface-container-highest',
    label: 'text-on-surface-variant',
  },
  outlined: {
    box: 'rounded-md border border-outline bg-surface',
    label: 'text-on-surface-variant',
  },
};

const ERROR_BOX = 'border-error';

export const TextInput = forwardRef<RNTextInputType, TextInputProps>(function TextInput(
  { label, variant = 'filled', helperText, error = false, ...rest },
  ref,
) {
  const styles = VARIANT_CLASSES[variant];
  const { colors } = useTheme();
  const boxClass = error ? `${styles.box} ${ERROR_BOX}` : styles.box;

  return (
    <View className="gap-1">
      <View className={boxClass}>
        <RNText className={`px-4 pt-2 text-body-small ${styles.label}`}>{label}</RNText>
        <RNTextInput
          ref={ref}
          accessibilityLabel={label}
          placeholderTextColor={colors.outline}
          className="min-h-11 px-4 pb-2 text-body-large text-on-surface"
          {...rest}
        />
      </View>
      {helperText !== undefined && helperText.length > 0 ? (
        <Text variant="bodySmall" color={error ? 'error' : 'onSurfaceVariant'}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
});
