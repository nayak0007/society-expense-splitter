import { Text as RNText } from 'react-native';
import type { ReactNode } from 'react';

import { type TypeRoleName } from '@/theme/typography';

/**
 * Typography primitive — the only component that renders text.
 * `variant` selects an MD3 type role (font metrics come from the Tailwind
 * `text-*` tokens); `color` selects a color role by name.
 *
 * Raw hex is banned in .tsx (ESLint) — pass a role name, not a color.
 */
export interface TextProps {
  readonly children: ReactNode;
  /** MD3 type role. Defaults to body-large. */
  readonly variant?: TypeRoleName;
  /** MD3 color role name (camelCase), e.g. `onSurfaceVariant`. */
  readonly color?: string;
  /** Number of lines before ellipsis. */
  readonly numberOfLines?: number;
  readonly align?: 'left' | 'center' | 'right';
}

const textAlignClass = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

export function Text({
  children,
  variant = 'bodyLarge',
  color = 'onSurface',
  numberOfLines,
  align = 'left',
}: TextProps) {
  const className = ['font-sans', `text-${variant}`, colorToClass(color), textAlignClass[align]]
    .filter(Boolean)
    .join(' ');

  return (
    <RNText numberOfLines={numberOfLines} className={className}>
      {children}
    </RNText>
  );
}

/**
 * Color-role name → Tailwind text color class. Runtime string interpolation
 * (`text-${role}`) cannot be used here because Tailwind's compiler scans
 * source for literal class names.
 */
const COLOR_CLASS_MAP: Record<string, string> = {
  onSurface: 'text-on-surface',
  onSurfaceVariant: 'text-on-surface-variant',
  onBackground: 'text-on-background',
  primary: 'text-primary',
  onPrimary: 'text-on-primary',
  onPrimaryContainer: 'text-on-primary-container',
  onSecondaryContainer: 'text-on-secondary-container',
  onTertiaryContainer: 'text-on-tertiary-container',
  error: 'text-error',
  onError: 'text-on-error',
  onErrorContainer: 'text-on-error-container',
  outline: 'text-outline',
  outlineVariant: 'text-outline-variant',
  inverseSurface: 'text-inverse-surface',
  inverseOnSurface: 'text-inverse-on-surface',
  inversePrimary: 'text-inverse-primary',
  success: 'text-success',
  onSuccess: 'text-on-success',
  onSuccessContainer: 'text-on-success-container',
  warning: 'text-warning',
  onWarning: 'text-on-warning',
  onWarningContainer: 'text-on-warning-container',
};

export function colorToClass(role: string): string {
  const mapped = COLOR_CLASS_MAP[role];
  if (mapped === undefined) {
    throw new Error(
      `[Text] Unknown color role "${role}". Add it to COLOR_CLASS_MAP in Text.tsx or use a defined role.`,
    );
  }
  return mapped;
}
