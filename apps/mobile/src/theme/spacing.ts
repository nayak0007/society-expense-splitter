/**
 * Spacing, shape and elevation tokens (SAD §4.2: src/theme/tokens.ts holds
 * design tokens; raw hex is banned in .tsx by ESLint — tokens are the only
 * styling vocabulary).
 *
 * Spacing follows a 4dp grid; semantic names map to MD3 component metrics
 * (m3.material.io/foundations/design-tokens).
 */

/** 4dp-base spacing scale in dp units. */
export const spacing = {
  /** 4 — icon padding, tight inline gaps */
  xs: 4,
  /** 8 — internal control padding, chip gaps */
  sm: 8,
  /** 12 — list item vertical padding */
  md: 12,
  /** 16 — screen gutter, card padding (MD3 standard) */
  lg: 16,
  /** 20 — card padding comfortable */
  xl: 20,
  /** 24 — section separation */
  xxl: 24,
  /** 32 — block separation */
  xxxl: 32,
  /** 48 — pre-title hero spacing */
  huge: 48,
} as const;

export type SpacingToken = keyof typeof spacing;

/** MD3 corner-radius scale in dp (m3.material.io/styles/shape/shape-scale-tokens). */
export const shape = {
  none: 0,
  /** Extra small: chips, text fields (4dp) */
  xs: 4,
  /** Small: snackbars (8dp) */
  sm: 8,
  /** Medium: cards, small FABs (12dp) */
  md: 12,
  /** Large: FABs, bottom sheets (16dp) */
  lg: 16,
  /** Extra large: modals, side sheets (28dp) */
  xl: 28,
  full: 9999,
} as const;

export type ShapeToken = keyof typeof shape;

/**
 * MD3 elevation levels 0–5 in dp. NativeWind maps these to shadow styles via
 * `shadow-sm` etc. in tailwind.config.js (Android shadow, iOS shadow+overlay).
 */
export const elevation = {
  level0: 0,
  level1: 1,
  level2: 3,
  level3: 6,
  level4: 8,
  level5: 12,
} as const;

export type ElevationToken = keyof typeof elevation;

/** Standard touch target (a11y, Material accessibility guidance). */
export const TOUCH_TARGET = 48;
