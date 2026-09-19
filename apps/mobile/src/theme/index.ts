/**
 * Theme entry. Re-exports the tokens, the hook and the provider.
 * (A single-module re-export, not a barrel over a folder.)
 */
export { darkColors, lightColors, COLOR_ROLES } from './colors';
export type { ColorRole, Md3ColorScheme } from './colors';
export { typeScale } from './typography';
export type { TypeRoleName } from './typography';
export { elevation, shape, spacing, TOUCH_TARGET } from './spacing';
export type { ElevationToken, ShapeToken, SpacingToken } from './spacing';
export { useTheme } from './theme';
export type { Theme } from './theme';
export { ThemeProvider, toVarName } from './theme-provider';
