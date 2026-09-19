/**
 * Material Design 3 color system (m3.material.io/styles/color/roles).
 *
 * Two complete schemes, light and dark. Components NEVER import hex values —
 * they read roles through `useTheme()` or Tailwind classes like
 * `bg-surface`, `text-on-surface`, `border-outline-variant`, which resolve
 * via the CSS variables set in ThemeProvider.
 */

export const lightColors = {
  // — MD3 core roles —
  primary: '#245EA9',
  onPrimary: '#FFFFFF',
  primaryContainer: '#D6E3FF',
  onPrimaryContainer: '#001C38',
  secondary: '#545F70',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#D8E3F8',
  onSecondaryContainer: '#111C2B',
  tertiary: '#6E5677',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#F7D9FF',
  onTertiaryContainer: '#271430',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  background: '#F9F9FF',
  onBackground: '#191C20',
  surface: '#F9F9FF',
  onSurface: '#191C20',
  surfaceVariant: '#DFE2EB',
  onSurfaceVariant: '#43474E',
  outline: '#73777F',
  outlineVariant: '#C3C7CF',
  inverseSurface: '#2E3135',
  inverseOnSurface: '#F0F0F7',
  inversePrimary: '#A8C8FF',
  scrim: '#000000',

  // — SES extension roles (added by the app, MD3-compatible) —
  surfaceContainer: '#EDF1F7',
  surfaceContainerLow: '#F3F3FA',
  surfaceContainerHigh: '#E7EAF1',
  surfaceContainerHighest: '#E2E4EB',
  surfaceContainerLowest: '#FFFFFF',
  success: '#146C2E',
  onSuccess: '#FFFFFF',
  successContainer: '#9BD4A5',
  onSuccessContainer: '#00210A',
  warning: '#7A5900',
  onWarning: '#FFFFFF',
  warningContainer: '#FFDF99',
  onWarningContainer: '#251A00',
} as const;

export const darkColors = {
  // — MD3 core roles —
  primary: '#A8C8FF',
  onPrimary: '#00315C',
  primaryContainer: '#20487B',
  onPrimaryContainer: '#D6E3FF',
  secondary: '#BCC7DB',
  onSecondary: '#263141',
  secondaryContainer: '#3C4758',
  onSecondaryContainer: '#D8E3F8',
  tertiary: '#DBBCE4',
  onTertiary: '#3E2846',
  tertiaryContainer: '#563E5E',
  onTertiaryContainer: '#F7D9FF',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  background: '#111318',
  onBackground: '#E2E2E9',
  surface: '#111318',
  onSurface: '#E2E2E9',
  surfaceVariant: '#43474E',
  onSurfaceVariant: '#C3C7CF',
  outline: '#8D9199',
  outlineVariant: '#43474E',
  inverseSurface: '#E2E2E9',
  inverseOnSurface: '#2E3135',
  inversePrimary: '#245EA9',
  scrim: '#000000',

  // — SES extension roles —
  surfaceContainer: '#1D2024',
  surfaceContainerLow: '#191C20',
  surfaceContainerHigh: '#282A2F',
  surfaceContainerHighest: '#33353A',
  surfaceContainerLowest: '#0C0E13',
  success: '#80D495',
  onSuccess: '#00391A',
  successContainer: '#005227',
  onSuccessContainer: '#9BD4A5',
  warning: '#F5BE48',
  onWarning: '#402D00',
  warningContainer: '#5C4300',
  onWarningContainer: '#FFDF99',
} as const;

/** Any scheme must provide every light-scheme role. */
export type ColorRole = keyof typeof lightColors;

export type Md3ColorScheme = Record<ColorRole, string>;

/** Compile-time guarantee: dark provides every role the light scheme defines. */
const darkColorsChecked: Md3ColorScheme = darkColors;
void darkColorsChecked;

/** All roles a scheme must provide — dark cannot drift from light. */
export const COLOR_ROLES: readonly ColorRole[] = Object.keys(lightColors) as ColorRole[];
