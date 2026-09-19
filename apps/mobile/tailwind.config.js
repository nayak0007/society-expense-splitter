/** @type {import('tailwindcss').Config} */
const nativewindPreset = require('nativewind/preset');
const { COLOR_ROLES } = require('./src/theme/colors');
const { typeScale } = require('./src/theme/typography');

/** dp token value → rem string (16px root assumption) for Tailwind. */
const dp = (n) => `${n / 16}rem`;

/** role `primaryContainer` → var name `--color-primary-container` */
const toVarName = (role) => `--color-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** role `primaryContainer` → utility key `primary-container` (kebab-case). */
const toKey = (role) => toVarName(role).replace('--color-', '');

/**
 * MD3 color roles → utilities `bg-surface`, `text-on-surface`,
 * `border-outline-variant`. KEYS MUST be kebab-case: Tailwind matches class
 * names against these keys verbatim. Values are CSS variables set by
 * ThemeProvider — dark mode is one OS toggle, zero re-renders.
 */
const md3ColorUtilities = COLOR_ROLES.reduce((acc, role) => {
  acc[toKey(role)] = `var(${toVarName(role)})`;
  return acc;
}, {});

/**
 * Text.tsx maps color-role names to classes at runtime (`text-${…}`), which
 * Tailwind's static scanner cannot see — these literals keep every on-* text
 * utility in the compiled CSS.
 */
const textColorSafelist = [
  'text-on-surface',
  'text-on-surface-variant',
  'text-on-background',
  'text-primary',
  'text-on-primary',
  'text-on-primary-container',
  'text-on-secondary-container',
  'text-on-tertiary-container',
  'text-error',
  'text-on-error',
  'text-on-error-container',
  'text-outline',
  'text-outline-variant',
  'text-inverse-surface',
  'text-inverse-on-surface',
  'text-inverse-primary',
  'text-success',
  'text-on-success',
  'text-on-success-container',
  'text-warning',
  'text-on-warning',
  'text-on-warning-container',
];

/** MD3 type roles → `text-title-large`, `text-body-medium`, … (kebab keys). */
const typeUtilities = Object.fromEntries(
  Object.entries(typeScale).map(([role, t]) => [
    toKey(role),
    {
      fontSize: t.fontSize,
      lineHeight: t.lineHeight,
      letterSpacing: t.letterSpacing,
      fontWeight: t.fontWeight === 'medium' ? '500' : '400',
    },
  ]),
);

module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [nativewindPreset],
  theme: {
    extend: {
      colors: md3ColorUtilities,
      fontSize: typeUtilities,
      borderRadius: {
        token: dp(4),
        sm: dp(8),
        md: dp(12),
        card: dp(12),
        lg: dp(16),
        xl: dp(28),
      },
      spacing: {
        xs: dp(4),
        sm: dp(8),
        md: dp(12),
        lg: dp(16),
        xl: dp(20),
        xxl: dp(24),
        xxxl: dp(32),
        huge: dp(48),
        'touch-target': dp(48),
      },
    },
  },
  plugins: [],
  safelist: [
    ...textColorSafelist,
    // Text.tsx interpolates type roles (`text-${variant}`) — keep all
    // text-* fontSize utilities in the compiled CSS.
    ...Object.keys(typeScale).map((role) => `text-${toKey(role)}`),
  ],
};
