import { useColorScheme } from 'nativewind';
import { useMemo } from 'react';

import { darkColors, lightColors, type ColorRole, type Md3ColorScheme } from './colors';

/**
 * The runtime theme handle. Colors resolve per OS scheme; typography and
 * spacing are consumed directly as Tailwind classes (`text-title-large`,
 * `rounded-card`, `p-lg`), so they are not re-exposed here.
 */
export interface Theme {
  readonly isDark: boolean;
  /** Semantic role → resolved color for the active scheme. */
  readonly colors: Md3ColorScheme;
}

export function useTheme(): Theme {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  return useMemo<Theme>(
    () => ({
      isDark,
      colors: isDark ? darkColors : lightColors,
    }),
    [isDark],
  );
}

export type { ColorRole, Md3ColorScheme };
