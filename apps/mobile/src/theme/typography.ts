/**
 * Material Design 3 type scale (m3.material.io/styles/typography/type-scale).
 * 15 roles. We use the Roboto reference scale with MD3 2021 sizes; the app
 * swaps the font family once the Inter/NotoSansDevanagari assets land.
 *
 * Values: fontSize / lineHeight / letterSpacing in dp units, per the MD3 spec.
 * Components consume these through Tailwind classes (`text-title-large`,
 * `text-body-medium`) — never hard-coded numbers.
 */

export interface TypeRole {
  /** Font size in dp. */
  readonly fontSize: number;
  /** Line height in dp. */
  readonly lineHeight: number;
  /** Letter spacing in dp (MD3 tracks display/headline as negative). */
  readonly letterSpacing: number;
  /** Font weight name; maps to a loaded font face. */
  readonly fontWeight: 'regular' | 'medium';
}

export const typeScale = {
  displayLarge: { fontSize: 57, lineHeight: 64, letterSpacing: -0.25, fontWeight: 'regular' },
  displayMedium: { fontSize: 45, lineHeight: 52, letterSpacing: 0, fontWeight: 'regular' },
  displaySmall: { fontSize: 36, lineHeight: 44, letterSpacing: 0, fontWeight: 'regular' },
  headlineLarge: { fontSize: 32, lineHeight: 40, letterSpacing: 0, fontWeight: 'regular' },
  headlineMedium: { fontSize: 28, lineHeight: 36, letterSpacing: 0, fontWeight: 'regular' },
  headlineSmall: { fontSize: 24, lineHeight: 32, letterSpacing: 0, fontWeight: 'regular' },
  titleLarge: { fontSize: 22, lineHeight: 28, letterSpacing: 0, fontWeight: 'regular' },
  titleMedium: { fontSize: 16, lineHeight: 24, letterSpacing: 0.15, fontWeight: 'medium' },
  titleSmall: { fontSize: 14, lineHeight: 20, letterSpacing: 0.1, fontWeight: 'medium' },
  bodyLarge: { fontSize: 16, lineHeight: 24, letterSpacing: 0.5, fontWeight: 'regular' },
  bodyMedium: { fontSize: 14, lineHeight: 20, letterSpacing: 0.25, fontWeight: 'regular' },
  bodySmall: { fontSize: 12, lineHeight: 16, letterSpacing: 0.4, fontWeight: 'regular' },
  labelLarge: { fontSize: 14, lineHeight: 20, letterSpacing: 0.1, fontWeight: 'medium' },
  labelMedium: { fontSize: 12, lineHeight: 16, letterSpacing: 0.5, fontWeight: 'medium' },
  labelSmall: { fontSize: 11, lineHeight: 16, letterSpacing: 0.5, fontWeight: 'medium' },
} as const satisfies Record<string, TypeRole>;

export type TypeRoleName = keyof typeof typeScale;
export const TYPE_ROLES = Object.keys(typeScale) as readonly TypeRoleName[];
