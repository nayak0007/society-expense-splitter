import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';

/**
 * Password input with a show/hide affordance (Roadmap T030:
 * `components/forms/PasswordField`).
 *
 * Low-end Android keyboards make typing a long password error-prone, and the
 * policy in `packages/contracts` (8+ chars, letter + number) makes typos
 * common. Per MD3, the visibility toggle is a text button beside the field
 * rather than an eye icon: it is one tap larger, and its label is announced by
 * screen readers without needing an accessible name on a glyph.
 */
export interface PasswordFieldProps {
  readonly label: string;
  readonly value: string;
  onChangeText: (value: string) => void;
  onBlur?: (() => void) | undefined;
  readonly error?: boolean;
  readonly helperText?: string | undefined;
  /** `new-password` lets the OS offer a generated one on sign-up. */
  readonly autoComplete?: 'password' | 'new-password';
  readonly editable?: boolean;
}

export function PasswordField({
  label,
  value,
  onChangeText,
  onBlur,
  error = false,
  helperText,
  autoComplete = 'password',
  editable = true,
}: PasswordFieldProps) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <View className="gap-1">
      <View className="flex-row items-start gap-2">
        <View className="flex-1">
          <TextInput
            label={label}
            value={value}
            onChangeText={onChangeText}
            onBlur={onBlur}
            secureTextEntry={!isVisible}
            autoComplete={autoComplete}
            autoCapitalize="none"
            autoCorrect={false}
            editable={editable}
            error={error}
            helperText={helperText}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${isVisible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
          accessibilityState={{ expanded: isVisible }}
          onPress={() => setIsVisible((visible) => !visible)}
          className="h-11 justify-center rounded-full px-3"
        >
          <Text variant="labelMedium" color="primary">
            {isVisible ? 'Hide' : 'Show'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
