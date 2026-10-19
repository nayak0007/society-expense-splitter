import { useColorScheme, vars } from 'nativewind';
import { memo } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { COLOR_ROLES, type ColorRole, darkColors, lightColors } from './colors';

/** Maps role `primaryContainer` → variable name `--color-primary-container`. */
export function toVarName(role: string): string {
  return `--color-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function schemeToVars(colors: Record<ColorRole, string>): Record<`--color-${string}`, string> {
  const out: Record<string, string> = {};
  for (const role of COLOR_ROLES) {
    out[toVarName(role)] = colors[role];
  }
  return out as Record<`--color-${string}`, string>;
}

const lightVars = vars(schemeToVars(lightColors));
const darkVars = vars(schemeToVars(darkColors));

/**
 * Exposes every MD3 color role as a CSS variable (`--color-primary`, …) on a
 * root wrapper. Components style with `bg-surface`, `text-on-surface`,
 * `border-outline-variant`; Tailwind resolves those utilities to the
 * variables. The active scheme follows the OS setting via useColorScheme —
 * children re-render once when it flips.
 *
 * Usage: wrap the app once, at the very root (inside AppProviders).
 */
export const ThemeProvider = memo(function ThemeProvider({ children }: { children: ReactNode }) {
  const { colorScheme } = useColorScheme();
  // `flex: 1` is load-bearing, not decoration: this wrapper is the app's root
  // layout box. Without it the wrapper sizes to its content, every screen's
  // `flex-1` inside it resolves against a zero-height parent, and the app
  // renders as a blank white surface with a correctly mounted React tree —
  // which is exactly what the first Android run showed (2026-10-18).
  return (
    <View style={[{ flex: 1 }, colorScheme === 'dark' ? darkVars : lightVars]}>{children}</View>
  );
});
