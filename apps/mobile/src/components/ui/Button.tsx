import { ActivityIndicator, Pressable, View } from 'react-native';
import type { ReactNode } from 'react';

import type { TypeRoleName } from '@/theme/typography';

import { Text } from './Text';

/**
 * MD3 Button (m3.material.io/components/buttons) — the five variants
 * (elevated, filled, tonal, outlined, text) with correct role pairings.
 * Height/shape follow MD3 metrics: 40dp, full-radius pill, 24dp paddings.
 */

export type ButtonVariant = 'elevated' | 'filled' | 'tonal' | 'outlined' | 'text';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  readonly children: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Disabled state: MD3 `on-surface/38%` container, `on-surface/38%` label. */
  readonly disabled?: boolean;
  /** Shows a spinner in place of the label; also disables interaction. */
  readonly loading?: boolean;
  /** Leading icon slot — pass any 20×20 node (an icon-font or SVG glyph). */
  readonly icon?: ReactNode;
  onPress?: (() => void) | undefined;
}

interface ButtonStyle {
  readonly container: string;
  readonly label: string;
}

const VARIANT_STYLES: Record<ButtonVariant, ButtonStyle> = {
  elevated: { container: 'bg-surface-container-low shadow-sm', label: 'primary' },
  filled: { container: 'bg-primary', label: 'onPrimary' },
  tonal: { container: 'bg-secondary-container', label: 'onSecondaryContainer' },
  outlined: { container: 'bg-transparent border border-outline', label: 'primary' },
  text: { container: 'bg-transparent', label: 'primary' },
};

const SIZE_STYLES: Record<ButtonSize, { container: string; label: TypeRoleName }> = {
  sm: { container: 'h-8 px-4', label: 'labelMedium' },
  md: { container: 'h-10 px-6', label: 'labelLarge' },
  lg: { container: 'h-12 px-8', label: 'labelLarge' },
};

export function Button({
  children,
  variant = 'filled',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  onPress,
}: ButtonProps) {
  const styles = VARIANT_STYLES[variant];
  const sizeStyle = SIZE_STYLES[size];
  const isDisabled = disabled || loading;
  const labelRole = styles.label as 'primary' | 'onPrimary' | 'onSecondaryContainer';

  return (
    <View className={isDisabled ? 'opacity-40' : ''}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        onPress={isDisabled ? undefined : onPress}
        className={`flex-row items-center justify-center rounded-full ${styles.container} ${sizeStyle.container}`}
      >
        {loading ? (
          <ActivityIndicator size="small" />
        ) : (
          <>
            {icon !== undefined ? <View className="mr-2">{icon}</View> : null}
            <Text variant={sizeStyle.label} color={labelRole}>
              {children}
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}
